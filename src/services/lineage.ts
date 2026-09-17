import type { Consent } from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { participantLocator } from "../core/crypto.js";
import type { GovernanceState } from "../core/store.js";
import { findProject } from "./queries.js";

export interface DatasetLineage {
  datasetId: string;
  name: string;
  status: string;
  purpose: string;
  protocolVersion: string;
  createdAt: string;
  createdBy: string;
  project: {
    projectId: string;
    name?: string;
    currentProtocolVersion?: string;
  };
  lawfulBasis: {
    purpose: string;
    protocolVersion: string;
    consents: Array<{
      consentId: string;
      participantLocator: string;
      state: string;
      validUntil: string;
    }>;
    sourceBreakdown: Record<string, number>;
    recordStatusBreakdown: Record<string, number>;
  };
  retention: {
    expiresAt: string;
    expiryAction: string;
    status: string;
  };
  downstream: {
    consumers: Array<{
      consumerId: string;
      name: string;
      role: string;
      registeredAt: string;
    }>;
    derivedDatasets: Array<{
      datasetId: string;
      name: string;
      purpose: string;
      status: string;
    }>;
    dispositionNotices: Array<{
      noticeId: string;
      consumerId: string;
      action: string;
      issuedAt: string;
      acknowledgedAt: string | null;
    }>;
  };
}

/**
 * 从数据集反查：合法来源（同意与方案版本）、到期动作、全部下游去向。
 * 参与者仅以密钥散列定位子出现，谱系视图不含个人数据。
 */
export function buildDatasetLineage(
  state: GovernanceState,
  datasetId: string,
): DatasetLineage {
  const dataset = state.datasets.find((entry) => entry.datasetId === datasetId);
  if (!dataset) {
    throw new DomainError("not_found", `数据集不存在: ${datasetId}`);
  }
  const project = findProject(state, dataset.projectId);
  const basisConsents = dataset.basisConsentIds
    .map((consentId) => state.consents.find((consent) => consent.consentId === consentId))
    .filter((consent): consent is Consent => consent !== undefined);

  const sourceBreakdown: Record<string, number> = {};
  const recordStatusBreakdown: Record<string, number> = {};
  for (const recordId of dataset.sourceRecordIds) {
    const record = state.records.find((entry) => entry.recordId === recordId);
    if (!record) {
      continue;
    }
    sourceBreakdown[record.source] = (sourceBreakdown[record.source] ?? 0) + 1;
    recordStatusBreakdown[record.status] = (recordStatusBreakdown[record.status] ?? 0) + 1;
  }

  const consumers = state.consumers.filter((entry) => entry.datasetId === dataset.datasetId);
  const derived = state.datasets.filter((entry) => entry.parentDatasetId === dataset.datasetId);
  const notices = state.notices.filter((entry) => entry.datasetId === dataset.datasetId);

  return {
    datasetId: dataset.datasetId,
    name: dataset.name,
    status: dataset.status,
    purpose: dataset.purpose,
    protocolVersion: dataset.protocolVersion,
    createdAt: dataset.createdAt,
    createdBy: dataset.createdBy,
    project: {
      projectId: dataset.projectId,
      ...(project
        ? { name: project.name, currentProtocolVersion: project.currentProtocolVersion }
        : {}),
    },
    lawfulBasis: {
      purpose: dataset.purpose,
      protocolVersion: dataset.protocolVersion,
      consents: basisConsents.map((consent) => ({
        consentId: consent.consentId,
        participantLocator: participantLocator(state.secret, consent.participantId),
        state: consent.state,
        validUntil: consent.validUntil,
      })),
      sourceBreakdown,
      recordStatusBreakdown,
    },
    retention: {
      expiresAt: dataset.retentionExpiresAt,
      expiryAction: dataset.expiryAction,
      status: dataset.status,
    },
    downstream: {
      consumers: consumers.map((consumer) => ({
        consumerId: consumer.consumerId,
        name: consumer.name,
        role: consumer.role,
        registeredAt: consumer.registeredAt,
      })),
      derivedDatasets: derived.map((child) => ({
        datasetId: child.datasetId,
        name: child.name,
        purpose: child.purpose,
        status: child.status,
      })),
      dispositionNotices: notices.map((notice) => ({
        noticeId: notice.noticeId,
        consumerId: notice.consumerId,
        action: notice.action,
        issuedAt: notice.issuedAt,
        acknowledgedAt: notice.acknowledgedAt ?? null,
      })),
    },
  };
}
