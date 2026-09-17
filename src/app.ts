import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { GovernanceService, ServiceError } from "./domain/service.js";
import type { ExportRequest } from "./domain/types.js";
import { CONSENT_STATES, DATA_SOURCES, EXPIRY_ACTIONS } from "./domain/types.js";

export const serviceName = "观众研究隐私治理服务";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export interface AppOptions {
  service?: GovernanceService;
  /** 变更类请求成功后调用（如写入 .runtime/ 快照）。 */
  persist?: () => void;
}

export function createApp(options: AppOptions = {}): Server {
  const service = options.service ?? new GovernanceService();
  const persist = options.persist ?? (() => {});

  return createServer(async (request, response) => {
    try {
      await route(service, persist, request, response);
    } catch (error) {
      if (error instanceof ServiceError) {
        send(response, error.statusCode, { error: error.code, message: error.message });
      } else if (error instanceof SyntaxError) {
        send(response, 400, { error: "invalid_json", message: "请求体不是合法 JSON" });
      } else {
        send(response, 500, { error: "internal_error" });
      }
    }
  });
}

async function route(
  service: GovernanceService,
  persist: () => void,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter((part) => part.length > 0);

  if (method === "GET" && url.pathname === "/health") {
    send(response, 200, healthPayload());
    return;
  }

  // 研究方案（版本注册，升级时自动重估既有同意）
  if (method === "POST" && url.pathname === "/protocols") {
    const body = await readJsonObject(request);
    const result = service.registerProtocol({
      projectId: requireString(body, "projectId"),
      version: requireNumber(body, "version"),
      purposes: requireStringArray(body, "purposes"),
      allowedSources: requireEnumArray(body, "allowedSources", DATA_SOURCES),
      fieldPolicy: requireFieldPolicy(body),
      allowedRoles: requireStringArray(body, "allowedRoles"),
      disclosureThreshold: requireNumber(body, "disclosureThreshold"),
      retentionDays: requireNumber(body, "retentionDays"),
    });
    persist();
    send(response, 201, result);
    return;
  }

  // 同意登记
  if (method === "POST" && url.pathname === "/consents") {
    const body = await readJsonObject(request);
    const consent = service.registerConsent({
      participantId: requireString(body, "participantId"),
      projectId: requireString(body, "projectId"),
      source: requireEnum(body, "source", DATA_SOURCES),
      ...(body.state !== undefined ? { state: requireEnumValue(body.state, "state", CONSENT_STATES) } : {}),
      purposes: requireStringArray(body, "purposes"),
      protocolVersions: requireNumberArray(body, "protocolVersions"),
      ...(body.restrictedFields !== undefined
        ? { restrictedFields: requireStringArray(body, "restrictedFields") }
        : {}),
      ...(body.grantedAt !== undefined ? { grantedAt: requireString(body, "grantedAt") } : {}),
      retentionUntil: requireString(body, "retentionUntil"),
    });
    persist();
    send(response, 201, consent);
    return;
  }

  // 撤回同意
  if (method === "POST" && url.pathname === "/consents/withdrawals") {
    const body = await readJsonObject(request);
    const result = service.withdraw(
      requireString(body, "participantId"),
      body.projectId !== undefined ? requireString(body, "projectId") : null,
    );
    persist();
    send(response, 200, result);
    return;
  }

  // 数据集注册
  if (method === "POST" && url.pathname === "/datasets") {
    const body = await readJsonObject(request);
    const dataset = service.registerDataset({
      datasetId: requireString(body, "datasetId"),
      projectId: requireString(body, "projectId"),
      sources: requireEnumArray(body, "sources", DATA_SOURCES),
      ...(body.upstreamDatasetIds !== undefined
        ? { upstreamDatasetIds: requireStringArray(body, "upstreamDatasetIds") }
        : {}),
      expiryAction: requireEnum(body, "expiryAction", EXPIRY_ACTIONS),
      retentionUntil: requireString(body, "retentionUntil"),
    });
    persist();
    send(response, 201, dataset);
    return;
  }

  // 采集/补传（含离线传感器迟到数据）
  if (method === "POST" && url.pathname === "/records") {
    const body = await readJsonObject(request);
    const result = service.ingest({
      ...(body.recordId !== undefined ? { recordId: requireString(body, "recordId") } : {}),
      participantId: requireString(body, "participantId"),
      datasetId: requireString(body, "datasetId"),
      source: requireEnum(body, "source", DATA_SOURCES),
      fields: requireRecord(body, "fields"),
      collectedAt: requireString(body, "collectedAt"),
      ...(body.retentionUntil !== undefined ? { retentionUntil: requireString(body, "retentionUntil") } : {}),
    });
    persist();
    send(response, result.accepted ? 201 : 200, result);
    return;
  }

  // 出库预评估（dry-run，不产生出库登记）
  if (method === "POST" && url.pathname === "/exports/evaluate") {
    const request_ = await readExportRequest(request);
    send(response, 200, service.evaluate(request_));
    return;
  }

  // 执行出库：核对六要素、最小字段交付、披露阈值拦截
  if (method === "POST" && url.pathname === "/exports") {
    const request_ = await readExportRequest(request);
    const result = service.executeExport(request_);
    persist();
    send(response, result.decision.allowed ? 201 : 422, result);
    return;
  }

  // 谱系反查：合法来源、到期动作、全部下游去向
  if (method === "GET" && segments[0] === "datasets" && segments.length === 3 && segments[2] === "lineage") {
    send(response, 200, service.traceDataset(segments[1] ?? ""));
    return;
  }

  // 下游处置事项
  if (method === "GET" && url.pathname === "/disposal-tasks") {
    send(response, 200, { tasks: service.listDisposalTasks(url.searchParams.get("consumerId")) });
    return;
  }
  if (
    method === "POST" &&
    segments[0] === "disposal-tasks" &&
    segments.length === 3 &&
    segments[2] === "complete"
  ) {
    const task = service.completeDisposalTask(segments[1] ?? "");
    persist();
    send(response, 200, task);
    return;
  }

  // 到期清扫
  if (method === "POST" && url.pathname === "/maintenance/expiry-sweep") {
    const result = service.runExpirySweep();
    persist();
    send(response, 200, result);
    return;
  }

  // 合规证明与审计账本（不含个人数据）
  if (method === "GET" && url.pathname === "/compliance/proofs") {
    send(response, 200, { proofs: service.proofs() });
    return;
  }
  if (method === "GET" && url.pathname === "/audit") {
    send(response, 200, { entries: service.auditLog() });
    return;
  }

  send(response, 404, { error: "not_found" });
}

async function readExportRequest(request: IncomingMessage): Promise<ExportRequest> {
  const body = await readJsonObject(request);
  return {
    datasetId: requireString(body, "datasetId"),
    projectId: requireString(body, "projectId"),
    purpose: requireString(body, "purpose"),
    role: requireString(body, "role"),
    consumerId: requireString(body, "consumerId"),
    requestedFields: body.requestedFields !== undefined ? requireStringArray(body, "requestedFields") : null,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServiceError(400, "invalid_body", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 必须为非空字符串`);
  }
  return value;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 必须为数字`);
  }
  return value;
}

function requireStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 必须为字符串数组`);
  }
  return value as string[];
}

function requireNumberArray(body: Record<string, unknown>, key: string): number[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 必须为数字数组`);
  }
  return value as number[];
}

function requireRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function requireEnumValue<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ServiceError(400, "invalid_field", `字段 ${key} 取值必须是 ${allowed.join("/")}`);
  }
  return value as T;
}

function requireEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  return requireEnumValue(body[key], key, allowed);
}

function requireEnumArray<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] {
  const values = requireStringArray(body, key);
  return values.map((value) => requireEnumValue(value, key, allowed));
}

function requireFieldPolicy(body: Record<string, unknown>): Record<string, string[]> {
  const value = body.fieldPolicy;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, "invalid_field", "字段 fieldPolicy 必须为 目的->字段数组 的对象");
  }
  const policy: Record<string, string[]> = {};
  for (const [purpose, fields] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) {
      throw new ServiceError(400, "invalid_field", `fieldPolicy.${purpose} 必须为字符串数组`);
    }
    policy[purpose] = fields as string[];
  }
  return policy;
}
