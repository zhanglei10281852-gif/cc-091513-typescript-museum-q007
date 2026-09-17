import { randomUUID } from "node:crypto";

import { chainHash, fingerprint, GENESIS_HASH } from "./crypto.js";
import { evaluateExport, PROHIBITED_FIELDS } from "./export-gate.js";
import { consentKey, Store } from "./store.js";
import {
  CONSENT_STATES,
  DATA_SOURCES,
  EXPIRY_ACTIONS,
  isValidParticipantId,
  type ConsentRecord,
  type ConsentState,
  type DataRecord,
  type Dataset,
  type DataSourceType,
  type DisposalTask,
  type ExportDecision,
  type ExportRecord,
  type ExportRequest,
  type ExpiryAction,
  type LedgerEntry,
  type LedgerKind,
  type ResearchProtocol,
} from "./types.js";

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface GovernanceOptions {
  now?: () => Date;
  /** HMAC 密钥：生产环境必须固定（GOVERNANCE_SECRET），否则重启后指纹对账失效。 */
  secret?: string;
  store?: Store;
}

export interface ReevaluationResult {
  projectId: string;
  version: number;
  coveredCount: number;
  /** 既有同意未覆盖新版本的参与者指纹（不含个人数据）。 */
  requiresReconsent: string[];
}

export interface WithdrawalResult {
  consentsWithdrawn: number;
  recordsDeleted: number;
  recordsAnonymized: number;
  recordsHeld: number;
  disposalTasksIssued: number;
  proofId: string | null;
}

export interface IngestResult {
  accepted: boolean;
  recordId: string;
  reason: string | null;
}

export interface ExportExecution {
  decision: ExportDecision;
  exportId: string | null;
  rows: Array<Record<string, unknown>> | null;
}

export interface SweepResult {
  datasetsExpired: string[];
  recordsDeleted: number;
  recordsAnonymized: number;
  recordsHeld: number;
  consentsExpired: number;
  disposalTasksIssued: number;
}

export interface DatasetLineage {
  datasetId: string;
  projectId: string;
  protocolVersion: number;
  sources: DataSourceType[];
  upstreamDatasetIds: string[];
  expiryAction: ExpiryAction;
  retentionUntil: string;
  expiredAt: string | null;
  records: { total: number; active: number; anonymized: number; held: number };
  consentCoverage: Record<ConsentState, number>;
  downstream: Array<{
    exportId: string;
    consumerId: string;
    purpose: string;
    role: string;
    fields: string[];
    rowCount: number;
    createdAt: string;
    disposalStatus: string;
  }>;
}

/** 匿名化时删除的准标识符字段（在全局禁止字段基础上追加）。 */
const QUASI_IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  ...PROHIBITED_FIELDS,
  "exactTimestamp",
  "zonePath",
  "sessionToken",
]);

export class GovernanceService {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly secret: string;

  constructor(options: GovernanceOptions = {}) {
    this.store = options.store ?? new Store();
    this.now = options.now ?? (() => new Date());
    this.secret = options.secret ?? randomUUID();
  }

  // ---------------------------------------------------------------- 研究方案

  registerProtocol(input: {
    projectId: string;
    version: number;
    purposes: string[];
    allowedSources: DataSourceType[];
    fieldPolicy: Record<string, string[]>;
    allowedRoles: string[];
    disclosureThreshold: number;
    retentionDays: number;
  }): { protocol: ResearchProtocol; reevaluation: ReevaluationResult | null } {
    requireNonEmpty(input.projectId, "projectId");
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new ServiceError(400, "invalid_version", "方案版本必须为正整数");
    }
    if (input.purposes.length === 0) throw new ServiceError(400, "invalid_purposes", "目的列表不能为空");
    if (input.allowedRoles.length === 0) throw new ServiceError(400, "invalid_roles", "可访问角色不能为空");
    if (!Number.isInteger(input.disclosureThreshold) || input.disclosureThreshold < 1) {
      throw new ServiceError(400, "invalid_threshold", "披露阈值必须为正整数");
    }
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
      throw new ServiceError(400, "invalid_retention", "保留期限必须为正整数天数");
    }
    for (const source of input.allowedSources) {
      if (!DATA_SOURCES.includes(source)) {
        throw new ServiceError(400, "invalid_source", `未知数据来源 ${source}`);
      }
    }
    for (const purpose of Object.keys(input.fieldPolicy)) {
      if (!input.purposes.includes(purpose)) {
        throw new ServiceError(400, "invalid_field_policy", `字段策略指向未登记的目的 ${purpose}`);
      }
    }

    const existing = this.store.protocols.get(input.projectId) ?? [];
    const latest = existing.length > 0 ? existing[existing.length - 1] : undefined;
    if (latest && input.version <= latest.version) {
      throw new ServiceError(409, "version_not_advanced", `方案版本必须大于当前版本 v${latest.version}`);
    }

    const protocol: ResearchProtocol = {
      projectId: input.projectId,
      version: input.version,
      purposes: [...input.purposes],
      allowedSources: [...input.allowedSources],
      fieldPolicy: Object.fromEntries(
        Object.entries(input.fieldPolicy).map(([purpose, fields]) => [purpose, [...fields]]),
      ),
      allowedRoles: [...input.allowedRoles],
      disclosureThreshold: input.disclosureThreshold,
      retentionDays: input.retentionDays,
      registeredAt: this.now().toISOString(),
    };
    existing.push(protocol);
    existing.sort((a, b) => a.version - b.version);
    this.store.protocols.set(input.projectId, existing);

    // 方案版本变化：重新判断既有同意是否覆盖新版本。
    let reevaluation: ReevaluationResult | null = null;
    if (latest) {
      reevaluation = this.reevaluateConsents(input.projectId, input.version);
    }
    this.appendLedger("audit", "protocol_registered", null, {
      projectId: input.projectId,
      version: input.version,
      reevaluation,
    });
    return { protocol, reevaluation };
  }

  private reevaluateConsents(projectId: string, version: number): ReevaluationResult {
    const requiresReconsent: string[] = [];
    let coveredCount = 0;
    for (const consent of this.store.consents.values()) {
      if (consent.projectId !== projectId) continue;
      if (consent.state !== "granted" && consent.state !== "restricted") continue;
      if (consent.protocolVersions.includes(version)) {
        coveredCount += 1;
      } else {
        requiresReconsent.push(fingerprint(this.secret, consent.participantId));
      }
    }
    const result: ReevaluationResult = {
      projectId,
      version,
      coveredCount,
      requiresReconsent: requiresReconsent.sort(),
    };
    this.appendLedger("audit", "consent_reevaluated", null, { ...result });
    return result;
  }

  // ---------------------------------------------------------------- 同意

  registerConsent(input: {
    participantId: string;
    projectId: string;
    source: DataSourceType;
    state?: ConsentState;
    purposes: string[];
    protocolVersions: number[];
    restrictedFields?: string[];
    grantedAt?: string;
    retentionUntil: string;
  }): ConsentRecord {
    if (!isValidParticipantId(input.participantId)) {
      throw new ServiceError(400, "invalid_participant_id", "参与标识不符合随机参与标识格式");
    }
    if (this.store.tombstones.has(fingerprint(this.secret, input.participantId))) {
      throw new ServiceError(409, "identity_retired", "该参与标识已撤回并封存，重新参与须使用新的随机标识");
    }
    if (!this.store.currentProtocol(input.projectId)) {
      throw new ServiceError(404, "project_unknown", `项目 ${input.projectId} 未注册研究方案`);
    }
    if (!DATA_SOURCES.includes(input.source)) {
      throw new ServiceError(400, "invalid_source", `未知数据来源 ${input.source}`);
    }
    if (input.purposes.length === 0 || input.protocolVersions.length === 0) {
      throw new ServiceError(400, "invalid_scope", "同意必须声明目的与覆盖的方案版本");
    }
    const state = input.state ?? "granted";
    if (!CONSENT_STATES.includes(state)) {
      throw new ServiceError(400, "invalid_state", `未知同意状态 ${state}`);
    }
    const restrictedFields = input.restrictedFields ?? [];
    if (state === "restricted" && restrictedFields.length === 0) {
      throw new ServiceError(400, "invalid_restriction", "受限同意必须给出字段白名单");
    }
    assertFuture(input.retentionUntil, this.now(), "retentionUntil");

    const consent: ConsentRecord = {
      projectId: input.projectId,
      participantId: input.participantId,
      source: input.source,
      state,
      purposes: [...input.purposes],
      protocolVersions: [...input.protocolVersions],
      restrictedFields: [...restrictedFields],
      grantedAt: input.grantedAt ?? this.now().toISOString(),
      withdrawnAt: null,
      retentionUntil: input.retentionUntil,
    };
    this.store.consents.set(consentKey(consent.projectId, consent.participantId), consent);
    this.appendLedger("audit", "consent_registered", fingerprint(this.secret, consent.participantId), {
      projectId: consent.projectId,
      state: consent.state,
      purposes: consent.purposes,
      protocolVersions: consent.protocolVersions,
    });
    return consent;
  }

  /**
   * 撤回同意：可定位记录按数据集到期动作删除或不可逆匿名化，
   * 下游使用方收到处置事项，并留下不含个人数据的合规证明。
   * 之后该参与标识进入墓碑，离线补传也无法重建身份。
   */
  withdraw(participantId: string, projectId: string | null = null): WithdrawalResult {
    if (!isValidParticipantId(participantId)) {
      throw new ServiceError(400, "invalid_participant_id", "参与标识不符合随机参与标识格式");
    }
    const now = this.now();
    const subjectFingerprint = fingerprint(this.secret, participantId);

    let consentsWithdrawn = 0;
    for (const consent of this.store.consents.values()) {
      if (consent.participantId !== participantId) continue;
      if (projectId !== null && consent.projectId !== projectId) continue;
      if (consent.state === "withdrawn") continue;
      consent.state = "withdrawn";
      consent.withdrawnAt = now.toISOString();
      consentsWithdrawn += 1;
    }

    let recordsDeleted = 0;
    let recordsAnonymized = 0;
    let recordsHeld = 0;
    for (const record of [...this.store.records.values()]) {
      if (record.participantId !== participantId || record.anonymized) continue;
      const dataset = this.store.datasets.get(record.datasetId);
      if (projectId !== null && dataset && dataset.projectId !== projectId) continue;
      const action = dataset?.expiryAction ?? "delete";
      if (action === "delete") {
        this.store.records.delete(record.recordId);
        recordsDeleted += 1;
      } else if (action === "anonymize") {
        anonymizeRecord(record);
        recordsAnonymized += 1;
      } else {
        record.held = true;
        recordsHeld += 1;
      }
    }

    const disposalTasksIssued = this.issueDisposalTasks(
      (exportRecord) =>
        exportRecord.disposalStatus === "active" &&
        (projectId === null || exportRecord.projectId === projectId) &&
        exportRecord.participantFingerprints.includes(subjectFingerprint),
      "consent_withdrawn",
    );

    this.store.tombstones.add(subjectFingerprint);

    const firstPass =
      consentsWithdrawn > 0 || recordsDeleted + recordsAnonymized + recordsHeld > 0 || disposalTasksIssued > 0;
    let proofId: string | null = null;
    if (firstPass) {
      const proof = this.appendLedger("proof", "consent_withdrawn", subjectFingerprint, {
        projectId,
        consentsWithdrawn,
        recordsDeleted,
        recordsAnonymized, // 不可逆匿名化：链接已切断，无法回溯
        recordsHeld,
        disposalTasksIssued,
      });
      proofId = proof.entryId;
    }
    return { consentsWithdrawn, recordsDeleted, recordsAnonymized, recordsHeld, disposalTasksIssued, proofId };
  }

  // ---------------------------------------------------------------- 数据集与采集

  registerDataset(input: {
    datasetId: string;
    projectId: string;
    sources: DataSourceType[];
    upstreamDatasetIds?: string[];
    expiryAction: ExpiryAction;
    retentionUntil: string;
  }): Dataset {
    requireNonEmpty(input.datasetId, "datasetId");
    if (this.store.datasets.has(input.datasetId)) {
      throw new ServiceError(409, "dataset_exists", `数据集 ${input.datasetId} 已存在`);
    }
    const protocol = this.store.currentProtocol(input.projectId);
    if (!protocol) {
      throw new ServiceError(404, "project_unknown", `项目 ${input.projectId} 未注册研究方案`);
    }
    if (input.sources.length === 0) {
      throw new ServiceError(400, "invalid_sources", "数据来源不能为空");
    }
    for (const source of input.sources) {
      if (!DATA_SOURCES.includes(source)) {
        throw new ServiceError(400, "invalid_source", `未知数据来源 ${source}`);
      }
    }
    if (!EXPIRY_ACTIONS.includes(input.expiryAction)) {
      throw new ServiceError(400, "invalid_expiry_action", `未知到期动作 ${input.expiryAction}`);
    }
    const upstream = input.upstreamDatasetIds ?? [];
    for (const upstreamId of upstream) {
      if (!this.store.datasets.has(upstreamId)) {
        throw new ServiceError(404, "upstream_unknown", `上游数据集 ${upstreamId} 不存在`);
      }
    }
    assertFuture(input.retentionUntil, this.now(), "retentionUntil");

    const dataset: Dataset = {
      datasetId: input.datasetId,
      projectId: input.projectId,
      protocolVersion: protocol.version,
      sources: [...input.sources],
      upstreamDatasetIds: [...upstream],
      expiryAction: input.expiryAction,
      retentionUntil: input.retentionUntil,
      createdAt: this.now().toISOString(),
      expiredAt: null,
    };
    this.store.datasets.set(dataset.datasetId, dataset);
    this.appendLedger("audit", "dataset_registered", null, {
      datasetId: dataset.datasetId,
      projectId: dataset.projectId,
      protocolVersion: dataset.protocolVersion,
      sources: dataset.sources,
      upstreamDatasetIds: dataset.upstreamDatasetIds,
      expiryAction: dataset.expiryAction,
      retentionUntil: dataset.retentionUntil,
    });
    return dataset;
  }

  /**
   * 采集/补传入口。命中撤回墓碑的数据直接丢弃——
   * 离线传感器补传不得重建已撤回身份。
   */
  ingest(input: {
    recordId?: string;
    participantId: string;
    datasetId: string;
    source: DataSourceType;
    fields: Record<string, unknown>;
    collectedAt: string;
    retentionUntil?: string;
  }): IngestResult {
    const dataset = this.store.datasets.get(input.datasetId);
    if (!dataset) throw new ServiceError(404, "dataset_unknown", `数据集 ${input.datasetId} 不存在`);
    if (!isValidParticipantId(input.participantId)) {
      throw new ServiceError(400, "invalid_participant_id", "参与标识不符合随机参与标识格式");
    }
    if (!dataset.sources.includes(input.source)) {
      throw new ServiceError(400, "source_not_in_dataset", `来源 ${input.source} 不属于数据集 ${input.datasetId}`);
    }

    const subjectFingerprint = fingerprint(this.secret, input.participantId);
    if (this.store.tombstones.has(subjectFingerprint)) {
      this.appendLedger("audit", "late_arrival_blocked", subjectFingerprint, {
        datasetId: input.datasetId,
        source: input.source,
        collectedAt: input.collectedAt,
      });
      return { accepted: false, recordId: input.recordId ?? "", reason: "identity_retired" };
    }

    const recordId = input.recordId ?? randomUUID();
    if (this.store.records.has(recordId)) {
      throw new ServiceError(409, "record_exists", `记录 ${recordId} 已存在`);
    }
    // 记录级保留期限不得超出数据集保留期限（取更严格者）。
    let retentionUntil = input.retentionUntil ?? dataset.retentionUntil;
    if (Date.parse(retentionUntil) > Date.parse(dataset.retentionUntil)) {
      retentionUntil = dataset.retentionUntil;
    }
    const record: DataRecord = {
      recordId,
      participantId: input.participantId,
      datasetId: input.datasetId,
      source: input.source,
      fields: { ...input.fields },
      collectedAt: input.collectedAt,
      retentionUntil,
      anonymized: false,
      held: false,
    };
    this.store.records.set(recordId, record);
    return { accepted: true, recordId, reason: null };
  }

  // ---------------------------------------------------------------- 出库

  evaluate(request: ExportRequest): ExportDecision {
    return evaluateExport(this.store, request, this.now()).decision;
  }

  executeExport(request: ExportRequest): ExportExecution {
    const evaluation = evaluateExport(this.store, request, this.now());
    const { decision, eligible, protocol } = evaluation;

    if (!decision.allowed || !protocol) {
      this.appendLedger("audit", "export_denied", null, {
        datasetId: request.datasetId,
        projectId: request.projectId,
        purpose: request.purpose,
        role: request.role,
        consumerId: request.consumerId,
        denials: decision.denials.map((denial) => denial.code),
      });
      return { decision, exportId: null, rows: null };
    }

    const rows = eligible.map((record) => {
      const row: Record<string, unknown> = { participantId: record.participantId };
      for (const field of decision.minimizedFields) {
        if (field in record.fields) row[field] = record.fields[field];
      }
      return row;
    });

    const fingerprints = [
      ...new Set(eligible.map((record) => fingerprint(this.secret, record.participantId ?? ""))),
    ].sort();
    const exportRecord: ExportRecord = {
      exportId: randomUUID(),
      datasetId: request.datasetId,
      projectId: request.projectId,
      protocolVersion: protocol.version,
      purpose: request.purpose,
      role: request.role,
      consumerId: request.consumerId,
      fields: [...decision.minimizedFields],
      rowCount: rows.length,
      participantCount: fingerprints.length,
      participantFingerprints: fingerprints,
      createdAt: this.now().toISOString(),
      disposalStatus: "active",
    };
    this.store.exports.set(exportRecord.exportId, exportRecord);
    const proof = this.appendLedger("proof", "export_approved", null, {
      exportId: exportRecord.exportId,
      datasetId: exportRecord.datasetId,
      projectId: exportRecord.projectId,
      protocolVersion: exportRecord.protocolVersion,
      purpose: exportRecord.purpose,
      role: exportRecord.role,
      consumerId: exportRecord.consumerId,
      fields: exportRecord.fields,
      droppedFields: decision.droppedFields,
      rowCount: exportRecord.rowCount,
      participantCount: exportRecord.participantCount,
    });
    return { decision: { ...decision }, exportId: exportRecord.exportId, rows };
  }

  // ---------------------------------------------------------------- 到期处置

  /** 到期清扫：对超过保留期限的同意、记录与数据集执行登记的到期动作。 */
  runExpirySweep(): SweepResult {
    const now = this.now();
    const result: SweepResult = {
      datasetsExpired: [],
      recordsDeleted: 0,
      recordsAnonymized: 0,
      recordsHeld: 0,
      consentsExpired: 0,
      disposalTasksIssued: 0,
    };

    for (const consent of this.store.consents.values()) {
      if (
        (consent.state === "granted" || consent.state === "restricted" || consent.state === "pending") &&
        Date.parse(consent.retentionUntil) <= now.getTime()
      ) {
        consent.state = "expired";
        result.consentsExpired += 1;
      }
    }

    // 数据集级到期：整集处置，并通知全部下游。
    for (const dataset of this.store.datasets.values()) {
      if (dataset.expiredAt !== null || Date.parse(dataset.retentionUntil) > now.getTime()) continue;
      dataset.expiredAt = now.toISOString();
      result.datasetsExpired.push(dataset.datasetId);
      for (const record of this.store.recordsOfDataset(dataset.datasetId)) {
        if (record.anonymized || record.held) continue;
        applyExpiryAction(this.store, record, dataset.expiryAction, result);
      }
      result.disposalTasksIssued += this.issueDisposalTasks(
        (exportRecord) => exportRecord.datasetId === dataset.datasetId && exportRecord.disposalStatus === "active",
        "retention_expired",
      );
      this.appendLedger("proof", "dataset_expired", null, {
        datasetId: dataset.datasetId,
        expiryAction: dataset.expiryAction,
      });
    }

    // 记录级到期（数据集未到期但记录保留期已满）。
    const expiredFingerprints = new Set<string>();
    for (const record of [...this.store.records.values()]) {
      if (record.anonymized || record.held) continue;
      if (Date.parse(record.retentionUntil) > now.getTime()) continue;
      const dataset = this.store.datasets.get(record.datasetId);
      if (!dataset || dataset.expiredAt !== null) continue; // 已在数据集级处理
      if (record.participantId) expiredFingerprints.add(fingerprint(this.secret, record.participantId));
      applyExpiryAction(this.store, record, dataset?.expiryAction ?? "delete", result);
    }
    if (expiredFingerprints.size > 0) {
      result.disposalTasksIssued += this.issueDisposalTasks(
        (exportRecord) =>
          exportRecord.disposalStatus === "active" &&
          exportRecord.participantFingerprints.some((fp) => expiredFingerprints.has(fp)),
        "retention_expired",
      );
      this.appendLedger("proof", "records_expired", null, {
        affectedFingerprints: [...expiredFingerprints].sort(),
        recordsDeleted: result.recordsDeleted,
        recordsAnonymized: result.recordsAnonymized,
        recordsHeld: result.recordsHeld,
      });
    }

    if (
      result.datasetsExpired.length > 0 ||
      result.consentsExpired > 0 ||
      result.recordsDeleted + result.recordsAnonymized + result.recordsHeld > 0
    ) {
      this.appendLedger("audit", "expiry_sweep_completed", null, { ...result });
    }
    return result;
  }

  // ---------------------------------------------------------------- 下游处置

  private issueDisposalTasks(
    match: (exportRecord: ExportRecord) => boolean,
    reason: DisposalTask["reason"],
  ): number {
    let issued = 0;
    for (const exportRecord of this.store.exports.values()) {
      if (!match(exportRecord)) continue;
      exportRecord.disposalStatus = "disposal_requested";
      const task: DisposalTask = {
        taskId: randomUUID(),
        exportId: exportRecord.exportId,
        consumerId: exportRecord.consumerId,
        reason,
        status: "pending",
        createdAt: this.now().toISOString(),
        completedAt: null,
      };
      this.store.disposalTasks.set(task.taskId, task);
      issued += 1;
    }
    return issued;
  }

  listDisposalTasks(consumerId: string | null): DisposalTask[] {
    const tasks = [...this.store.disposalTasks.values()];
    return consumerId === null ? tasks : tasks.filter((task) => task.consumerId === consumerId);
  }

  completeDisposalTask(taskId: string): DisposalTask {
    const task = this.store.disposalTasks.get(taskId);
    if (!task) throw new ServiceError(404, "task_unknown", `处置事项 ${taskId} 不存在`);
    if (task.status === "completed") return task;
    task.status = "completed";
    task.completedAt = this.now().toISOString();

    const siblings = [...this.store.disposalTasks.values()].filter((t) => t.exportId === task.exportId);
    if (siblings.every((t) => t.status === "completed")) {
      const exportRecord = this.store.exports.get(task.exportId);
      if (exportRecord) exportRecord.disposalStatus = "disposed";
    }
    this.appendLedger("audit", "disposal_completed", null, {
      taskId: task.taskId,
      exportId: task.exportId,
      consumerId: task.consumerId,
      reason: task.reason,
    });
    return task;
  }

  // ---------------------------------------------------------------- 谱系反查

  /** 从数据集反查：合法来源、到期动作与全部下游去向。 */
  traceDataset(datasetId: string): DatasetLineage {
    const dataset = this.store.datasets.get(datasetId);
    if (!dataset) throw new ServiceError(404, "dataset_unknown", `数据集 ${datasetId} 不存在`);

    const upstream = new Set<string>();
    const walk = (ids: string[]) => {
      for (const id of ids) {
        if (upstream.has(id)) continue;
        upstream.add(id);
        const parent = this.store.datasets.get(id);
        if (parent) walk(parent.upstreamDatasetIds);
      }
    };
    walk(dataset.upstreamDatasetIds);

    const records = this.store.recordsOfDataset(datasetId);
    const consentCoverage: Record<ConsentState, number> = {
      pending: 0,
      granted: 0,
      restricted: 0,
      withdrawn: 0,
      expired: 0,
    };
    let active = 0;
    let anonymized = 0;
    let held = 0;
    for (const record of records) {
      if (record.anonymized) {
        anonymized += 1;
        continue;
      }
      if (record.held) {
        held += 1;
        continue;
      }
      active += 1;
      const consent = record.participantId
        ? this.store.consents.get(consentKey(dataset.projectId, record.participantId))
        : undefined;
      consentCoverage[consent?.state ?? "pending"] += 1;
    }

    return {
      datasetId: dataset.datasetId,
      projectId: dataset.projectId,
      protocolVersion: dataset.protocolVersion,
      sources: [...dataset.sources],
      upstreamDatasetIds: [...upstream].sort(),
      expiryAction: dataset.expiryAction,
      retentionUntil: dataset.retentionUntil,
      expiredAt: dataset.expiredAt,
      records: { total: records.length, active, anonymized, held },
      consentCoverage,
      downstream: this.store.exportsOfDataset(datasetId).map((exportRecord) => ({
        exportId: exportRecord.exportId,
        consumerId: exportRecord.consumerId,
        purpose: exportRecord.purpose,
        role: exportRecord.role,
        fields: [...exportRecord.fields],
        rowCount: exportRecord.rowCount,
        createdAt: exportRecord.createdAt,
        disposalStatus: exportRecord.disposalStatus,
      })),
    };
  }

  // ---------------------------------------------------------------- 账本

  /** 合规证明：只含指纹与计数，可对外出示。 */
  proofs(): LedgerEntry[] {
    return this.store.ledger.filter((entry) => entry.kind === "proof");
  }

  auditLog(): LedgerEntry[] {
    return [...this.store.ledger];
  }

  snapshot(): ReturnType<Store["snapshot"]> {
    return this.store.snapshot();
  }

  private appendLedger(
    kind: LedgerKind,
    eventType: string,
    subjectFingerprint: string | null,
    details: Record<string, unknown>,
  ): LedgerEntry {
    const previousHash =
      this.store.ledger.length > 0
        ? (this.store.ledger[this.store.ledger.length - 1]?.hash ?? GENESIS_HASH)
        : GENESIS_HASH;
    const entryId = randomUUID();
    const createdAt = this.now().toISOString();
    const hash = chainHash(
      previousHash,
      JSON.stringify({ entryId, kind, eventType, subjectFingerprint, details, createdAt }),
    );
    const entry: LedgerEntry = {
      entryId,
      kind,
      eventType,
      subjectFingerprint,
      details,
      previousHash,
      hash,
      createdAt,
    };
    this.store.ledger.push(entry);
    return entry;
  }
}

function anonymizeRecord(record: DataRecord): void {
  // 不可逆匿名化：切断与参与标识的链接，不保留任何映射。
  record.participantId = null;
  record.anonymized = true;
  record.held = false;
  for (const field of Object.keys(record.fields)) {
    if (QUASI_IDENTIFIER_FIELDS.has(field)) delete record.fields[field];
  }
  // 采集时间泛化到天，降低再识别风险。
  record.collectedAt = record.collectedAt.slice(0, 10);
}

function applyExpiryAction(
  store: Store,
  record: DataRecord,
  action: ExpiryAction,
  result: { recordsDeleted: number; recordsAnonymized: number; recordsHeld: number },
): void {
  if (action === "delete") {
    store.records.delete(record.recordId);
    result.recordsDeleted += 1;
  } else if (action === "anonymize") {
    anonymizeRecord(record);
    result.recordsAnonymized += 1;
  } else {
    record.held = true;
    result.recordsHeld += 1;
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ServiceError(400, "invalid_input", `${field} 不能为空`);
}

function assertFuture(iso: string, now: Date, field: string): void {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) throw new ServiceError(400, "invalid_date", `${field} 不是合法时间`);
  if (time <= now.getTime()) {
    throw new ServiceError(400, "invalid_retention", `${field} 必须晚于当前时间`);
  }
}
