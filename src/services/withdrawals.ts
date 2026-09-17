import type {
  ComplianceProof,
  Dataset,
  DispositionNotice,
  Tombstone,
  Withdrawal,
} from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { exportParticipantKey, newId, participantLocator } from "../core/crypto.js";
import type { ServiceDeps } from "./deps.js";
import { anonymizeRecord } from "./records.js";
import { findProject } from "./queries.js";

export interface WithdrawInput {
  participantId: string;
  projectId?: string;
}

export interface WithdrawResult {
  withdrawal: Withdrawal;
  proof: ComplianceProof;
}

/**
 * 撤回编排：可定位记录进入删除或不可逆匿名化流程，
 * 下游使用者收到处置事项，并出具不含个人数据的合规证明。
 */
export class WithdrawalService {
  constructor(private readonly deps: ServiceDeps) {}

  withdraw(input: WithdrawInput): WithdrawResult {
    const { store, audit, clock } = this.deps;
    const state = store.state;
    const known =
      state.consents.some((consent) => consent.participantId === input.participantId) ||
      state.records.some((record) => record.participantId === input.participantId);
    if (!known) {
      throw new DomainError("not_found", "未找到该参与标识的同意或记录");
    }

    const nowIso = clock.now().toISOString();
    const withdrawalId = newId("wd");
    const locator = participantLocator(state.secret, input.participantId);
    const inScope = (projectId: string): boolean =>
      input.projectId === undefined || input.projectId === projectId;

    // 1. 同意状态推进为 withdrawn。
    let consentsWithdrawn = 0;
    for (const consent of state.consents) {
      if (consent.participantId !== input.participantId || !inScope(consent.projectId)) {
        continue;
      }
      if (consent.state === "withdrawn") {
        continue;
      }
      consent.state = "withdrawn";
      consent.withdrawnAt = nowIso;
      consentsWithdrawn += 1;
    }

    // 2. 可定位记录进入删除或不可逆匿名化流程。
    let recordsDeleted = 0;
    let recordsAnonymized = 0;
    const affectedRecordIds = new Set<string>();
    for (const record of state.records) {
      if (record.participantId !== input.participantId || !inScope(record.projectId)) {
        continue;
      }
      if (record.status !== "active" && record.status !== "quarantined") {
        continue;
      }
      affectedRecordIds.add(record.recordId);
      const project = findProject(state, record.projectId);
      if (project && project.withdrawalAction === "anonymize") {
        anonymizeRecord(project, record, "consent_withdrawn");
        recordsAnonymized += 1;
      } else {
        record.status = "deleted";
        record.fields = {};
        record.statusReason = "consent_withdrawn";
        recordsDeleted += 1;
      }
    }

    // 3. 受影响数据集（含派生子孙）进入处置流程，通知全部下游使用者。
    const affected = collectAffectedDatasets(state.datasets, affectedRecordIds);
    const noticeIds: string[] = [];
    for (const dataset of affected) {
      if (dataset.status === "destroyed") {
        continue;
      }
      dataset.status = "disposition_pending";
      const isDerived = dataset.parentDatasetId !== undefined;
      if (isDerived) {
        dataset.rows = [];
        dataset.rowCount = 0;
      } else {
        const key = exportParticipantKey(state.secret, dataset.datasetId, input.participantId);
        dataset.rows = dataset.rows.filter((row) => row.participantKey !== key);
        dataset.rowCount = dataset.rows.length;
      }
      for (const consumer of state.consumers.filter(
        (entry) => entry.datasetId === dataset.datasetId,
      )) {
        const notice: DispositionNotice = {
          noticeId: newId("ntc"),
          withdrawalId,
          datasetId: dataset.datasetId,
          consumerId: consumer.consumerId,
          action: isDerived ? "destroy_dataset" : "purge_participant_rows",
          participantLocator: locator,
          issuedAt: nowIso,
        };
        state.notices.push(notice);
        noticeIds.push(notice.noticeId);
        audit.record("disposition_notice_issued", {
          noticeId: notice.noticeId,
          datasetId: dataset.datasetId,
          consumerId: consumer.consumerId,
          action: notice.action,
        });
      }
    }

    // 4. 撤回墓碑：迟到的离线补传不得重建已撤回身份。
    const duplicate = state.tombstones.some(
      (tombstone) =>
        tombstone.participantId === input.participantId &&
        tombstone.projectId === (input.projectId ?? null),
    );
    if (!duplicate) {
      const tombstone: Tombstone = {
        participantId: input.participantId,
        projectId: input.projectId ?? null,
        withdrawalId,
        createdAt: nowIso,
      };
      state.tombstones.push(tombstone);
    }

    // 5. 出具不含个人数据的合规证明。
    const withdrawal: Withdrawal = {
      withdrawalId,
      participantId: input.participantId,
      initiatedAt: nowIso,
      completedAt: nowIso,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    };
    state.withdrawals.push(withdrawal);
    audit.record("consent_withdrawn", {
      withdrawalId,
      participantLocator: locator,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      consentsWithdrawn,
      recordsDeleted,
      recordsAnonymized,
      datasetsAffected: affected.length,
      noticesIssued: noticeIds.length,
    });
    const proof: ComplianceProof = {
      proofId: newId("prf"),
      withdrawalId,
      participantLocator: locator,
      issuedAt: nowIso,
      consentsWithdrawn,
      recordsDeleted,
      recordsAnonymized,
      datasetsAffected: affected.map((dataset) => dataset.datasetId),
      noticesIssued: noticeIds,
      auditHash: audit.headHash,
    };
    state.proofs.push(proof);
    audit.record("withdrawal_proof_issued", {
      withdrawalId,
      proofId: proof.proofId,
    });
    return { withdrawal, proof };
  }

  /** 下游确认处置完成；数据集的全部通知确认后状态收尾。 */
  acknowledgeNotice(noticeId: string, consumerId: string): DispositionNotice {
    const { store, audit, clock } = this.deps;
    const state = store.state;
    const notice = state.notices.find((entry) => entry.noticeId === noticeId);
    if (!notice) {
      throw new DomainError("not_found", `处置通知不存在: ${noticeId}`);
    }
    if (notice.consumerId !== consumerId) {
      throw new DomainError("forbidden", "只能由通知对应的下游使用者确认");
    }
    notice.acknowledgedAt = clock.now().toISOString();
    audit.record("notice_acknowledged", {
      noticeId: notice.noticeId,
      datasetId: notice.datasetId,
      consumerId,
    });
    const pending = state.notices.some(
      (entry) => entry.datasetId === notice.datasetId && entry.acknowledgedAt === undefined,
    );
    const dataset = state.datasets.find((entry) => entry.datasetId === notice.datasetId);
    if (!pending && dataset && dataset.status === "disposition_pending") {
      dataset.status = dataset.parentDatasetId !== undefined ? "destroyed" : "purged";
      audit.record("dataset_disposition_complete", {
        datasetId: dataset.datasetId,
        status: dataset.status,
      });
    }
    return notice;
  }

  getProof(withdrawalId: string): ComplianceProof {
    const proof = this.deps.store.state.proofs.find(
      (entry) => entry.withdrawalId === withdrawalId,
    );
    if (!proof) {
      throw new DomainError("not_found", `撤回证明不存在: ${withdrawalId}`);
    }
    return proof;
  }
}

/** 直接受影响的数据集及其全部派生子孙。 */
function collectAffectedDatasets(
  datasets: Dataset[],
  affectedRecordIds: Set<string>,
): Dataset[] {
  const affected = new Map<string, Dataset>();
  const queue: Dataset[] = datasets.filter((dataset) =>
    dataset.sourceRecordIds.some((recordId) => affectedRecordIds.has(recordId)),
  );
  while (queue.length > 0) {
    const dataset = queue.shift();
    if (!dataset || affected.has(dataset.datasetId)) {
      continue;
    }
    affected.set(dataset.datasetId, dataset);
    for (const child of datasets.filter(
      (entry) => entry.parentDatasetId === dataset.datasetId,
    )) {
      queue.push(child);
    }
  }
  return [...affected.values()];
}
