import { DAY_MS, DIRECT_IDENTIFIER_FIELDS } from "../domain/constants.js";
import type {
  Consumer,
  DataRecord,
  Dataset,
  DataSource,
  Role,
} from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { exportParticipantKey, newId } from "../core/crypto.js";
import type { ServiceDeps } from "./deps.js";
import {
  currentProtocol,
  findCoveringConsent,
  findProject,
  recordExpired,
  uniq,
} from "./queries.js";

export type ExportDenialReason =
  | "role_not_permitted"
  | "purpose_mismatch"
  | "source_not_permitted"
  | "no_deliverable_fields"
  | "no_eligible_records"
  | "below_disclosure_threshold";

export interface ExportRequest {
  projectId: string;
  purpose: string;
  sources: DataSource[];
  fields: string[];
  actor: string;
  role: Role;
}

export interface ExportDecision {
  approved: boolean;
  reasons: ExportDenialReason[];
  deliveredFields: string[];
  droppedFields: string[];
  eligibleRecords: number;
  eligibleParticipants: number;
  datasetId?: string;
}

export interface RegisterConsumerInput {
  name: string;
  role?: Role | "external";
}

export interface DeriveInput {
  name: string;
  purpose: string;
  consumerName?: string;
}

export interface DeriveDecision {
  approved: boolean;
  reasons: ExportDenialReason[];
  datasetId?: string;
}

/**
 * 导出网关：任何新导出发生前，核对研究目的、数据来源、同意范围、
 * 保留期限、可访问角色，只交付当前项目允许的最小字段，
 * 并在样本低于披露阈值时拒绝出库。
 */
export class ExportService {
  constructor(private readonly deps: ServiceDeps) {}

  requestExport(request: ExportRequest): ExportDecision {
    const { store, audit, clock } = this.deps;
    const state = store.state;
    const project = findProject(state, request.projectId);
    if (!project) {
      throw new DomainError("not_found", `项目不存在: ${request.projectId}`);
    }
    const protocol = currentProtocol(project);
    if (!protocol) {
      throw new DomainError("invalid", "项目缺少当前方案版本");
    }

    const reasons: ExportDenialReason[] = [];
    if (!project.allowedRoles.includes(request.role)) {
      reasons.push("role_not_permitted");
    }
    if (!protocol.purposes.includes(request.purpose)) {
      reasons.push("purpose_mismatch");
    }
    if (request.sources.some((source) => !protocol.sources.includes(source))) {
      reasons.push("source_not_permitted");
    }
    const allowed = new Set(project.allowedFields);
    const deliveredFields = uniq(request.fields).filter(
      (field) => allowed.has(field) && !DIRECT_IDENTIFIER_FIELDS.includes(field),
    );
    const droppedFields = uniq(request.fields).filter(
      (field) => !deliveredFields.includes(field),
    );
    if (deliveredFields.length === 0) {
      reasons.push("no_deliverable_fields");
    }
    if (reasons.length > 0) {
      audit.record("export_denied", {
        projectId: project.projectId,
        purpose: request.purpose,
        actor: request.actor,
        role: request.role,
        reasons,
      });
      return {
        approved: false,
        reasons,
        deliveredFields,
        droppedFields,
        eligibleRecords: 0,
        eligibleParticipants: 0,
      };
    }

    const now = clock.now();
    const eligible: Array<{ record: DataRecord; consentId: string }> = [];
    for (const record of state.records) {
      if (record.projectId !== project.projectId || record.status !== "active") {
        continue;
      }
      if (!request.sources.includes(record.source)) {
        continue;
      }
      if (recordExpired(project, record, now)) {
        continue;
      }
      const consent = findCoveringConsent(state, project, record.participantId, {
        purpose: request.purpose,
        source: record.source,
        now,
      });
      if (!consent) {
        continue;
      }
      eligible.push({ record, consentId: consent.consentId });
    }

    const participants = new Set(eligible.map((entry) => entry.record.participantId));
    if (eligible.length === 0) {
      reasons.push("no_eligible_records");
    } else if (participants.size < project.disclosureThreshold) {
      reasons.push("below_disclosure_threshold");
    }
    if (reasons.length > 0) {
      audit.record("export_denied", {
        projectId: project.projectId,
        purpose: request.purpose,
        actor: request.actor,
        role: request.role,
        reasons,
        eligibleRecords: eligible.length,
        eligibleParticipants: participants.size,
      });
      return {
        approved: false,
        reasons,
        deliveredFields,
        droppedFields,
        eligibleRecords: eligible.length,
        eligibleParticipants: participants.size,
      };
    }

    const datasetId = newId("ds");
    const rows = eligible.map((entry) => ({
      participantKey: exportParticipantKey(state.secret, datasetId, entry.record.participantId),
      ...pickFields(entry.record.fields, deliveredFields),
    }));
    const nowIso = now.toISOString();
    const dataset: Dataset = {
      datasetId,
      projectId: project.projectId,
      name: `${project.name} 导出 ${nowIso}`,
      purpose: request.purpose,
      protocolVersion: protocol.version,
      createdAt: nowIso,
      createdBy: request.actor,
      rowCount: rows.length,
      participantCount: participants.size,
      deliveredFields,
      sourceRecordIds: eligible.map((entry) => entry.record.recordId),
      basisConsentIds: uniq(eligible.map((entry) => entry.consentId)),
      retentionExpiresAt: new Date(now.getTime() + project.retentionDays * DAY_MS).toISOString(),
      expiryAction: project.expiryAction,
      status: "active",
      rows,
    };
    state.datasets.push(dataset);
    const consumer: Consumer = {
      consumerId: newId("consm"),
      datasetId,
      name: request.actor,
      role: request.role,
      registeredAt: nowIso,
    };
    state.consumers.push(consumer);
    audit.record("export_approved", {
      projectId: project.projectId,
      datasetId,
      purpose: request.purpose,
      actor: request.actor,
      role: request.role,
      rowCount: rows.length,
      participantCount: participants.size,
      deliveredFields,
    });
    return {
      approved: true,
      reasons: [],
      deliveredFields,
      droppedFields,
      eligibleRecords: eligible.length,
      eligibleParticipants: participants.size,
      datasetId,
    };
  }

  /** 登记数据集的下游接收方，纳入谱系与撤回通知范围。 */
  registerConsumer(datasetId: string, input: RegisterConsumerInput): Consumer {
    const { store, audit, clock } = this.deps;
    const dataset = store.state.datasets.find((entry) => entry.datasetId === datasetId);
    if (!dataset) {
      throw new DomainError("not_found", `数据集不存在: ${datasetId}`);
    }
    const consumer: Consumer = {
      consumerId: newId("consm"),
      datasetId,
      name: input.name,
      role: input.role ?? "external",
      registeredAt: clock.now().toISOString(),
    };
    store.state.consumers.push(consumer);
    audit.record("consumer_registered", {
      datasetId,
      consumerId: consumer.consumerId,
      consumerName: consumer.name,
    });
    return consumer;
  }

  /**
   * 从既有数据集派生新数据集。派生用途必须与原出口用途一致，
   * 防止“摄像头派生数据被拿去训练年龄识别模型”式的目的漂移。
   */
  deriveDataset(datasetId: string, input: DeriveInput, actor: string): DeriveDecision {
    const { store, audit, clock } = this.deps;
    const state = store.state;
    const parent = state.datasets.find((entry) => entry.datasetId === datasetId);
    if (!parent) {
      throw new DomainError("not_found", `数据集不存在: ${datasetId}`);
    }
    if (parent.status !== "active") {
      throw new DomainError("conflict", `数据集状态 ${parent.status} 不允许派生`);
    }
    if (input.purpose !== parent.purpose) {
      audit.record("derive_denied", {
        parentDatasetId: parent.datasetId,
        purpose: input.purpose,
        actor,
        reasons: ["purpose_mismatch"],
      });
      return { approved: false, reasons: ["purpose_mismatch"] };
    }
    const nowIso = clock.now().toISOString();
    const child: Dataset = {
      datasetId: newId("ds"),
      projectId: parent.projectId,
      name: input.name,
      purpose: parent.purpose,
      protocolVersion: parent.protocolVersion,
      createdAt: nowIso,
      createdBy: actor,
      rowCount: 0,
      participantCount: parent.participantCount,
      deliveredFields: [],
      sourceRecordIds: [...parent.sourceRecordIds],
      basisConsentIds: [...parent.basisConsentIds],
      parentDatasetId: parent.datasetId,
      retentionExpiresAt: parent.retentionExpiresAt,
      expiryAction: parent.expiryAction,
      status: "active",
      rows: [],
    };
    state.datasets.push(child);
    const consumer: Consumer = {
      consumerId: newId("consm"),
      datasetId: child.datasetId,
      name: input.consumerName ?? actor,
      role: "external",
      registeredAt: nowIso,
    };
    state.consumers.push(consumer);
    audit.record("dataset_derived", {
      parentDatasetId: parent.datasetId,
      datasetId: child.datasetId,
      purpose: child.purpose,
      actor,
    });
    return { approved: true, reasons: [], datasetId: child.datasetId };
  }
}

function pickFields(
  fields: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      picked[key] = fields[key];
    }
  }
  return picked;
}
