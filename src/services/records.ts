import { randomUUID } from "node:crypto";

import { DAY_MS, DIRECT_IDENTIFIER_FIELDS } from "../domain/constants.js";
import type { DataRecord, DataSource, Project, ProtocolVersion } from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { newId, participantLocator } from "../core/crypto.js";
import type { ServiceDeps } from "./deps.js";
import {
  currentProtocol,
  findCoveringConsent,
  findProject,
  isTombstoned,
  recordExpired,
} from "./queries.js";

export type IngestOutcome = "accepted" | "quarantined" | "dropped_withdrawn" | "rejected_expired";

export interface IngestRecordInput {
  participantId: string;
  source: DataSource;
  collectedAt?: string;
  fields?: Record<string, unknown>;
}

export interface IngestResult {
  outcome: IngestOutcome;
  recordId?: string;
  reason?: string;
}

export interface RetentionSweepResult {
  consentsExpired: number;
  recordsDeleted: number;
  recordsAnonymized: number;
  recordsHeld: number;
  datasetsDestroyed: number;
  datasetsAnonymized: number;
  datasetsHeld: number;
}

/**
 * 不可逆匿名化：剥离直接标识符与项目声明的可识别字段，
 * 并将参与标识重键为无映射的随机值。
 */
export function anonymizeRecord(project: Project, record: DataRecord, reason: string): void {
  const strip = new Set<string>([...DIRECT_IDENTIFIER_FIELDS, ...project.identifyingFields]);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    if (!strip.has(key)) {
      kept[key] = value;
    }
  }
  record.fields = kept;
  record.participantId = `anon_${randomUUID()}`;
  record.status = "anonymized";
  record.statusReason = reason;
}

export class RecordService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * 采集/补传一条记录。撤回墓碑优先于一切：
   * 已撤回身份即使离线传感器稍后补传也不得重建。
   */
  ingest(projectId: string, input: IngestRecordInput): IngestResult {
    const { store, audit, clock, reference } = this.deps;
    const state = store.state;
    const project = findProject(state, projectId);
    if (!project) {
      throw new DomainError("not_found", `项目不存在: ${projectId}`);
    }
    if (!reference.dataSources.includes(input.source)) {
      throw new DomainError("invalid", `未知数据来源: ${input.source}`);
    }
    const protocol = currentProtocol(project);
    if (!protocol) {
      throw new DomainError("invalid", "项目缺少当前方案版本");
    }
    const locator = participantLocator(state.secret, input.participantId);

    if (isTombstoned(state, input.participantId, projectId)) {
      audit.record("late_record_dropped", {
        projectId,
        source: input.source,
        participantLocator: locator,
        reason: "withdrawn_identity",
      });
      return { outcome: "dropped_withdrawn", reason: "withdrawn_identity" };
    }

    const collectedAt = input.collectedAt ?? clock.now().toISOString();
    const collectedMs = Date.parse(collectedAt);
    if (Number.isNaN(collectedMs)) {
      throw new DomainError("invalid", "collectedAt 不是合法时间");
    }

    if (!protocol.sources.includes(input.source)) {
      return this.quarantine(project, protocol, input, collectedAt, "source_not_in_protocol");
    }
    if (collectedMs + project.retentionDays * DAY_MS <= clock.now().getTime()) {
      audit.record("record_rejected", {
        projectId,
        source: input.source,
        participantLocator: locator,
        reason: "retention_expired",
      });
      return { outcome: "rejected_expired", reason: "retention_expired" };
    }
    const consent = findCoveringConsent(state, project, input.participantId, {
      source: input.source,
      now: clock.now(),
    });
    if (!consent) {
      return this.quarantine(project, protocol, input, collectedAt, "no_covering_consent");
    }

    const record = this.createRecord(project, protocol, input, collectedAt, "active");
    audit.record("record_ingested", {
      recordId: record.recordId,
      projectId,
      source: input.source,
      participantLocator: locator,
    });
    return { outcome: "accepted", recordId: record.recordId };
  }

  /** 同意补齐后，将此前因缺少同意而隔离的记录转为可用。 */
  activateQuarantined(participantId: string, projectId: string): number {
    const state = this.deps.store.state;
    const project = findProject(state, projectId);
    if (!project) {
      return 0;
    }
    let activated = 0;
    for (const record of state.records) {
      if (record.participantId !== participantId || record.projectId !== projectId) {
        continue;
      }
      if (record.status !== "quarantined" || record.statusReason !== "no_covering_consent") {
        continue;
      }
      const consent = findCoveringConsent(state, project, participantId, {
        source: record.source,
        now: this.deps.clock.now(),
      });
      if (!consent) {
        continue;
      }
      record.status = "active";
      delete record.statusReason;
      activated += 1;
    }
    return activated;
  }

  /** 保留期限巡检：对到期同意、记录与数据集执行到期动作。 */
  retentionSweep(): RetentionSweepResult {
    const { store, audit, clock } = this.deps;
    const state = store.state;
    const now = clock.now();
    const result: RetentionSweepResult = {
      consentsExpired: 0,
      recordsDeleted: 0,
      recordsAnonymized: 0,
      recordsHeld: 0,
      datasetsDestroyed: 0,
      datasetsAnonymized: 0,
      datasetsHeld: 0,
    };

    for (const consent of state.consents) {
      if (
        (consent.state === "granted" || consent.state === "restricted") &&
        Date.parse(consent.validUntil) <= now.getTime()
      ) {
        consent.state = "expired";
        result.consentsExpired += 1;
      }
    }

    for (const record of state.records) {
      if (record.status !== "active" && record.status !== "quarantined") {
        continue;
      }
      const project = findProject(state, record.projectId);
      if (!project || !recordExpired(project, record, now)) {
        continue;
      }
      if (project.expiryAction === "delete") {
        record.status = "deleted";
        record.fields = {};
        record.statusReason = "retention_expired";
        result.recordsDeleted += 1;
      } else if (project.expiryAction === "anonymize") {
        anonymizeRecord(project, record, "retention_expired");
        result.recordsAnonymized += 1;
      } else {
        record.status = "expired";
        record.statusReason = "review_hold";
        result.recordsHeld += 1;
      }
    }

    for (const dataset of state.datasets) {
      if (dataset.status !== "active" && dataset.status !== "disposition_pending") {
        continue;
      }
      if (Date.parse(dataset.retentionExpiresAt) > now.getTime()) {
        continue;
      }
      if (dataset.expiryAction === "delete") {
        dataset.status = "destroyed";
        dataset.rows = [];
        dataset.rowCount = 0;
        result.datasetsDestroyed += 1;
      } else if (dataset.expiryAction === "anonymize") {
        dataset.status = "anonymized";
        dataset.rows = dataset.rows.map((row) => {
          const rest = { ...row };
          delete rest["participantKey"];
          return rest;
        });
        result.datasetsAnonymized += 1;
      } else {
        dataset.status = "expired";
        dataset.statusReason = "review_hold";
        result.datasetsHeld += 1;
      }
      audit.record("dataset_retention_applied", {
        datasetId: dataset.datasetId,
        action: dataset.expiryAction,
      });
    }

    audit.record("retention_sweep", { ...result });
    return result;
  }

  private quarantine(
    project: Project,
    protocol: ProtocolVersion,
    input: IngestRecordInput,
    collectedAt: string,
    reason: string,
  ): IngestResult {
    const record = this.createRecord(project, protocol, input, collectedAt, "quarantined", reason);
    this.deps.audit.record("record_quarantined", {
      recordId: record.recordId,
      projectId: project.projectId,
      source: input.source,
      participantLocator: participantLocator(this.deps.store.state.secret, input.participantId),
      reason,
    });
    return { outcome: "quarantined", recordId: record.recordId, reason };
  }

  private createRecord(
    project: Project,
    protocol: ProtocolVersion,
    input: IngestRecordInput,
    collectedAt: string,
    status: DataRecord["status"],
    reason?: string,
  ): DataRecord {
    const record: DataRecord = {
      recordId: newId("rec"),
      participantId: input.participantId,
      projectId: project.projectId,
      source: input.source,
      protocolVersion: protocol.version,
      collectedAt,
      fields: { ...(input.fields ?? {}) },
      status,
      ...(reason !== undefined ? { statusReason: reason } : {}),
    };
    this.deps.store.state.records.push(record);
    return record;
  }
}
