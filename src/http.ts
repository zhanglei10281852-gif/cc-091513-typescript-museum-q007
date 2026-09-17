import type { IncomingMessage, ServerResponse } from "node:http";

import { DomainError, HttpError } from "./core/errors.js";
import { ROLES, WITHDRAWAL_ACTIONS } from "./domain/constants.js";
import type { DataSource, Role } from "./domain/types.js";
import type { GovernanceService } from "./service.js";

interface RequestContext {
  actor: string;
  role: Role;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface RouteResult {
  status: number;
  body: unknown;
}

type Handler = (ctx: RequestContext) => RouteResult | Promise<RouteResult>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 1_000_000;

export function createRequestHandler(
  service: GovernanceService,
  persist: (() => void) | null,
  health: () => unknown,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, segments: splitPath(pattern), handler });
  };

  route("GET", "/health", () => ({ status: 200, body: health() }));

  route("GET", "/audit", (ctx) => {
    requireRole(ctx, "data_protection_officer");
    return { status: 200, body: { entries: service.auditTrail(parseLimit(ctx)) } };
  });

  route("GET", "/audit/verify", (ctx) => {
    requireRole(ctx, "data_protection_officer");
    return { status: 200, body: service.verifyAudit() };
  });

  route("POST", "/projects", (ctx) => ({
    status: 201,
    body: service.createProject(parseCreateProject(service, ctx)),
  }));

  route("GET", "/projects", () => ({ status: 200, body: { projects: service.listProjects() } }));

  route("GET", "/projects/:projectId", (ctx) => ({
    status: 200,
    body: service.getProject(param(ctx, "projectId")),
  }));

  route("POST", "/projects/:projectId/protocol-versions", (ctx) => ({
    status: 201,
    body: service.addProtocolVersion(param(ctx, "projectId"), parseAddVersion(service, ctx)),
  }));

  route("POST", "/consents", (ctx) => ({
    status: 201,
    body: service.grantConsent(parseGrantConsent(service, ctx)),
  }));

  route("POST", "/withdrawals", (ctx) => {
    const { withdrawal, proof } = service.withdraw(parseWithdraw(ctx));
    return { status: 201, body: { withdrawalId: withdrawal.withdrawalId, proof } };
  });

  route("GET", "/withdrawals/:withdrawalId/proof", (ctx) => ({
    status: 200,
    body: service.getWithdrawalProof(param(ctx, "withdrawalId")),
  }));

  route("POST", "/projects/:projectId/records", (ctx) => ({
    status: 200,
    body: service.ingestRecord(param(ctx, "projectId"), parseIngestRecord(service, ctx)),
  }));

  route("POST", "/projects/:projectId/ingest-batch", (ctx) => {
    const { source, items } = parseIngestBatch(service, ctx);
    return { status: 200, body: { outcomes: service.ingestBatch(param(ctx, "projectId"), source, items) } };
  });

  route("POST", "/exports", (ctx) => {
    const decision = service.requestExport(parseExportRequest(service, ctx));
    if (!decision.approved) {
      return { status: 403, body: decision };
    }
    const dataset = service.getDataset(decision.datasetId as string);
    return {
      status: 201,
      body: {
        ...decision,
        dataset: summarizeDataset(dataset),
        rows: dataset.rows,
      },
    };
  });

  route("POST", "/datasets/:datasetId/consumers", (ctx) => ({
    status: 201,
    body: service.registerConsumer(param(ctx, "datasetId"), parseConsumer(ctx)),
  }));

  route("POST", "/datasets/:datasetId/derive", (ctx) => {
    const decision = service.deriveDataset(
      param(ctx, "datasetId"),
      parseDerive(ctx),
      ctx.actor,
    );
    return decision.approved
      ? { status: 201, body: decision }
      : { status: 403, body: decision };
  });

  route("GET", "/datasets/:datasetId/lineage", (ctx) => {
    requireRole(ctx, "data_protection_officer");
    return { status: 200, body: service.getDatasetLineage(param(ctx, "datasetId")) };
  });

  route("POST", "/notices/:noticeId/acknowledge", (ctx) => ({
    status: 200,
    body: service.acknowledgeNotice(param(ctx, "noticeId"), parseAck(ctx)),
  }));

  route("POST", "/maintenance/retention-sweep", (ctx) => {
    requireRole(ctx, "data_protection_officer", "system");
    return { status: 200, body: service.runRetentionSweep() };
  });

  return async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const segments = splitPath(url.pathname);
      const match = matchRoute(routes, method, segments);
      if (!match) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const ctx: RequestContext = {
        actor: header(req, "x-actor-id") ?? "anonymous",
        role: parseRole(header(req, "x-actor-role")),
        params: match.params,
        query: url.searchParams,
        body: method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : undefined,
      };
      const result = await match.route.handler(ctx);
      if (method !== "GET" && result.status < 300 && persist) {
        persist();
      }
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function matchRoute(
  routes: Route[],
  method: string,
  segments: string[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < segments.length; index += 1) {
      const pattern = route.segments[index] as string;
      const actual = segments[index] as string;
      if (pattern.startsWith(":")) {
        params[pattern.slice(1)] = decodeURIComponent(actual);
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route, params };
    }
  }
  return null;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRole(raw: string | undefined): Role {
  if (raw === undefined) {
    return "researcher";
  }
  if ((ROLES as readonly string[]).includes(raw)) {
    return raw as Role;
  }
  throw new HttpError(400, "invalid_role", `未知角色: ${raw}`);
}

function requireRole(ctx: RequestContext, ...roles: Role[]): void {
  if (!roles.includes(ctx.role)) {
    throw new HttpError(403, "forbidden", `需要角色: ${roles.join(" 或 ")}`);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "请求体过大");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "conflict"
          ? 409
          : error.code === "forbidden"
            ? 403
            : 400;
    sendJson(res, status, { error: error.code, message: error.message });
    return;
  }
  process.stderr.write(`internal error: ${String(error)}\n`);
  sendJson(res, 500, { error: "internal_error" });
}

// ---- 请求体校验 ----

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function param(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined || value.length === 0) {
    throw new HttpError(400, "invalid_param", `缺少路径参数: ${name}`);
  }
  return value;
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_field", `字段 ${key} 必须是非空字符串`);
  }
  return value;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `字段 ${key} 必须是字符串`);
  }
  return value;
}

function reqStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "invalid_field", `字段 ${key} 必须是字符串数组`);
  }
  return value as string[];
}

function optStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (value === undefined || value === null) {
    return [];
  }
  return reqStringArray(obj, key);
}

function reqEnumArray(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string[] {
  const values = reqStringArray(obj, key);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new HttpError(400, "invalid_field", `字段 ${key} 含未知取值: ${value}`);
    }
  }
  return values;
}

function reqEnum(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string {
  const value = reqString(obj, key);
  if (!allowed.includes(value)) {
    throw new HttpError(400, "invalid_field", `字段 ${key} 取值非法: ${value}`);
  }
  return value;
}

function optEnum(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const value = optString(obj, key);
  if (value === undefined) {
    return fallback;
  }
  if (!allowed.includes(value)) {
    throw new HttpError(400, "invalid_field", `字段 ${key} 取值非法: ${value}`);
  }
  return value;
}

function optInt(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  fallback: number,
): number {
  const value = obj[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new HttpError(400, "invalid_field", `字段 ${key} 必须是不小于 ${min} 的整数`);
  }
  return value;
}

function optBoolean(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = obj[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_field", `字段 ${key} 必须是布尔值`);
  }
  return value;
}

function optFields(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  if (value === undefined || value === null) {
    return {};
  }
  return asRecord(value);
}

function parseLimit(ctx: RequestContext): number {
  const raw = ctx.query.get("limit");
  if (raw === null) {
    return 200;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new HttpError(400, "invalid_query", "limit 必须是 1-1000 的整数");
  }
  return value;
}

function parseCreateProject(service: GovernanceService, ctx: RequestContext) {
  const body = asRecord(ctx.body);
  return {
    name: reqString(body, "name"),
    purposes: reqStringArray(body, "purposes"),
    sources: reqEnumArray(body, "sources", service.reference.dataSources) as DataSource[],
    allowedRoles: reqEnumArray(body, "allowedRoles", ROLES) as Role[],
    allowedFields: reqStringArray(body, "allowedFields"),
    disclosureThreshold: optInt(body, "disclosureThreshold", 1, 5),
    retentionDays: optInt(body, "retentionDays", 1, 180),
    expiryAction: reqEnum(body, "expiryAction", service.reference.expiryActions) as
      | "delete"
      | "anonymize"
      | "review_hold",
    withdrawalAction: optEnum(body, "withdrawalAction", WITHDRAWAL_ACTIONS, "delete") as
      | "delete"
      | "anonymize",
    identifyingFields: optStringArray(body, "identifyingFields"),
  };
}

function parseAddVersion(service: GovernanceService, ctx: RequestContext) {
  const body = asRecord(ctx.body);
  return {
    version: reqString(body, "version"),
    purposes: reqStringArray(body, "purposes"),
    sources: reqEnumArray(body, "sources", service.reference.dataSources) as DataSource[],
    requiresReconsent: optBoolean(body, "requiresReconsent", true),
    ...(optString(body, "note") !== undefined ? { note: optString(body, "note") as string } : {}),
  };
}

function parseGrantConsent(service: GovernanceService, ctx: RequestContext) {
  const body = asRecord(ctx.body);
  return {
    participantId: reqString(body, "participantId"),
    projectId: reqString(body, "projectId"),
    purposes: reqStringArray(body, "purposes"),
    sources: reqEnumArray(body, "sources", service.reference.dataSources) as DataSource[],
    validUntil: reqString(body, "validUntil"),
  };
}

function parseWithdraw(ctx: RequestContext) {
  const body = asRecord(ctx.body);
  const projectId = optString(body, "projectId");
  return {
    participantId: reqString(body, "participantId"),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function parseIngestRecord(service: GovernanceService, ctx: RequestContext) {
  const body = asRecord(ctx.body);
  const collectedAt = optString(body, "collectedAt");
  return {
    participantId: reqString(body, "participantId"),
    source: reqEnum(body, "source", service.reference.dataSources) as DataSource,
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    fields: optFields(body, "fields"),
  };
}

function parseIngestBatch(
  service: GovernanceService,
  ctx: RequestContext,
): { source: DataSource; items: Array<{ participantId: string; collectedAt?: string; fields?: Record<string, unknown> }> } {
  const body = asRecord(ctx.body);
  const source = reqEnum(body, "source", service.reference.dataSources) as DataSource;
  const rawItems = body["items"];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 1000) {
    throw new HttpError(400, "invalid_field", "字段 items 必须是 1-1000 条的数组");
  }
  const items = rawItems.map((raw) => {
    const item = asRecord(raw);
    const collectedAt = optString(item, "collectedAt");
    return {
      participantId: reqString(item, "participantId"),
      ...(collectedAt !== undefined ? { collectedAt } : {}),
      fields: optFields(item, "fields"),
    };
  });
  return { source, items };
}

function parseExportRequest(service: GovernanceService, ctx: RequestContext) {
  const body = asRecord(ctx.body);
  return {
    projectId: reqString(body, "projectId"),
    purpose: reqString(body, "purpose"),
    sources: reqEnumArray(body, "sources", service.reference.dataSources) as DataSource[],
    fields: reqStringArray(body, "fields"),
    actor: ctx.actor,
    role: ctx.role,
  };
}

function parseConsumer(ctx: RequestContext) {
  const body = asRecord(ctx.body);
  const role = optString(body, "role");
  if (role !== undefined && role !== "external" && !(ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, "invalid_field", `字段 role 取值非法: ${role}`);
  }
  return {
    name: reqString(body, "name"),
    ...(role !== undefined ? { role: role as Role | "external" } : {}),
  };
}

function parseDerive(ctx: RequestContext) {
  const body = asRecord(ctx.body);
  const consumerName = optString(body, "consumerName");
  return {
    name: reqString(body, "name"),
    purpose: reqString(body, "purpose"),
    ...(consumerName !== undefined ? { consumerName } : {}),
  };
}

function parseAck(ctx: RequestContext): string {
  const body = asRecord(ctx.body);
  return reqString(body, "consumerId");
}

function summarizeDataset(dataset: {
  datasetId: string;
  projectId: string;
  name: string;
  purpose: string;
  protocolVersion: string;
  createdAt: string;
  rowCount: number;
  participantCount: number;
  deliveredFields: string[];
  retentionExpiresAt: string;
  expiryAction: string;
  status: string;
}) {
  return {
    datasetId: dataset.datasetId,
    projectId: dataset.projectId,
    name: dataset.name,
    purpose: dataset.purpose,
    protocolVersion: dataset.protocolVersion,
    createdAt: dataset.createdAt,
    rowCount: dataset.rowCount,
    participantCount: dataset.participantCount,
    deliveredFields: dataset.deliveredFields,
    retentionExpiresAt: dataset.retentionExpiresAt,
    expiryAction: dataset.expiryAction,
    status: dataset.status,
  };
}
