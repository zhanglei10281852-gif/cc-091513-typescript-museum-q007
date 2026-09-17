import { consentKey, type Store } from "./store.js";
import {
  isValidParticipantId,
  type ConsentRecord,
  type DataRecord,
  type DenialReason,
  type ExportDecision,
  type ExportRequest,
  type ResearchProtocol,
} from "./types.js";

/**
 * 直接标识符全局黑名单：即使方案 fieldPolicy 误配也永不出库（纵深防御）。
 */
export const PROHIBITED_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "email",
  "phone",
  "idNumber",
  "faceTemplate",
  "deviceId",
  "exactGps",
]);

export interface ExportEvaluation {
  decision: ExportDecision;
  eligible: DataRecord[];
  protocol: ResearchProtocol | null;
}

function consentCovers(
  consent: ConsentRecord,
  purpose: string,
  protocolVersion: number,
  deliverFields: string[],
  now: Date,
): boolean {
  if (consent.state === "restricted") {
    // 受限同意：交付字段必须全部落在其白名单内。
    if (!deliverFields.every((field) => consent.restrictedFields.includes(field))) return false;
  } else if (consent.state !== "granted") {
    return false;
  }
  if (!consent.purposes.includes(purpose)) return false;
  if (!consent.protocolVersions.includes(protocolVersion)) return false;
  if (Date.parse(consent.retentionUntil) <= now.getTime()) return false;
  return true;
}

/**
 * 出库闸门：在任何新导出发生前核对研究目的、数据来源、同意范围、
 * 保留期限、可访问角色与随机参与标识，只做字段最小化，
 * 并在去重样本低于披露阈值时拒绝出库。
 */
export function evaluateExport(store: Store, request: ExportRequest, now: Date): ExportEvaluation {
  const denials: DenialReason[] = [];
  const protocol = store.currentProtocol(request.projectId);
  const dataset = store.datasets.get(request.datasetId) ?? null;

  if (!protocol) {
    denials.push({ code: "project_unknown", message: `项目 ${request.projectId} 未注册研究方案` });
  }
  if (!dataset) {
    denials.push({ code: "dataset_unknown", message: `数据集 ${request.datasetId} 不存在` });
  }

  if (protocol) {
    if (!protocol.allowedRoles.includes(request.role)) {
      denials.push({
        code: "role_not_permitted",
        message: `角色 ${request.role} 不在方案允许的可访问角色内`,
      });
    }
    if (!protocol.purposes.includes(request.purpose)) {
      denials.push({
        code: "purpose_not_permitted",
        message: `研究目的 ${request.purpose} 超出方案 v${protocol.version} 登记的目的范围`,
      });
    }
  }

  if (protocol && dataset) {
    const foreignSources = dataset.sources.filter((source) => !protocol.allowedSources.includes(source));
    if (foreignSources.length > 0) {
      denials.push({
        code: "source_not_permitted",
        message: `数据来源 ${foreignSources.join(", ")} 未获方案 v${protocol.version} 授权`,
      });
    }
    if (dataset.expiredAt !== null || Date.parse(dataset.retentionUntil) <= now.getTime()) {
      denials.push({ code: "retention_expired", message: `数据集 ${dataset.datasetId} 已过保留期限` });
    }
  }

  // 字段最小化：申请字段 ∩ 方案允许字段 − 全局禁止字段。
  const allowedFields = protocol ? (protocol.fieldPolicy[request.purpose] ?? []) : [];
  const requestedFields = request.requestedFields ?? allowedFields;
  const minimizedFields = requestedFields.filter(
    (field) => allowedFields.includes(field) && !PROHIBITED_FIELDS.has(field),
  );
  const droppedFields = requestedFields.filter((field) => !minimizedFields.includes(field));
  if (protocol && minimizedFields.length === 0) {
    denials.push({
      code: "no_deliverable_fields",
      message: `目的 ${request.purpose} 下没有可交付字段（申请字段均被策略剔除）`,
    });
  }

  // 逐记录核对：随机参与标识、记录保留期、隔离状态、同意覆盖。
  const eligible: DataRecord[] = [];
  if (protocol && dataset) {
    for (const record of store.recordsOfDataset(dataset.datasetId)) {
      if (record.anonymized || record.held) continue;
      if (record.participantId === null || !isValidParticipantId(record.participantId)) continue;
      if (Date.parse(record.retentionUntil) <= now.getTime()) continue;
      const consent = store.consents.get(consentKey(protocol.projectId, record.participantId));
      if (!consent || !consentCovers(consent, request.purpose, protocol.version, minimizedFields, now)) {
        continue;
      }
      eligible.push(record);
    }
  }

  const participants = new Set(eligible.map((record) => record.participantId));
  const threshold = protocol?.disclosureThreshold ?? null;
  if (protocol && dataset && threshold !== null && participants.size < threshold) {
    denials.push({
      code: "below_disclosure_threshold",
      message: `去重参与者 ${participants.size} 低于披露阈值 ${threshold}，拒绝出库`,
    });
  }

  return {
    decision: {
      allowed: denials.length === 0,
      denials,
      minimizedFields,
      droppedFields,
      eligibleRecords: eligible.length,
      eligibleParticipants: participants.size,
      disclosureThreshold: threshold,
      protocolVersion: protocol?.version ?? null,
    },
    eligible,
    protocol,
  };
}
