import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceError } from "../src/domain/service.js";
import type { ExportRequest } from "../src/domain/types.js";
import {
  addConsent,
  addDataset,
  addRecord,
  makeService,
  pid,
  PROJECT,
  registerFlowProtocol,
} from "./helpers.js";

const EXPORT_REQUEST: ExportRequest = {
  datasetId: "ds-del",
  projectId: PROJECT,
  purpose: "flow_analysis",
  role: "researcher",
  consumerId: "analytics-team",
  requestedFields: null,
};

/**
 * 场景：观众数据分布在两个数据集（删除型 / 匿名化型），
 * 且已有下游团队拿到过出库副本。
 */
function setup() {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-del", { expiryAction: "delete" });
  addDataset(service, "ds-anon", { expiryAction: "anonymize" });
  for (const i of [1, 2, 3, 4]) {
    addConsent(service, pid(i));
    addRecord(service, `del-${i}`, pid(i), "ds-del");
    addRecord(service, `anon-${i}`, pid(i), "ds-anon", { exactTimestamp: "2026-09-16T14:23:11.123Z" });
  }
  const exported = service.executeExport(EXPORT_REQUEST);
  assert.equal(exported.decision.allowed, true);
  return { service, exportId: exported.exportId ?? "" };
}

test("撤回后：删除型数据集移除记录，匿名化型数据集不可逆匿名化", () => {
  const { service } = setup();

  const result = service.withdraw(pid(1));

  assert.equal(result.consentsWithdrawn, 1);
  assert.equal(result.recordsDeleted, 1);
  assert.equal(result.recordsAnonymized, 1);

  const lineage = service.traceDataset("ds-anon");
  assert.equal(lineage.records.anonymized, 1);

  // 匿名化记录已切断与参与标识的链接，准标识符被移除、时间泛化到天
  const snapshot = service.snapshot();
  const anonymized = snapshot.records.find(([, record]) => record.recordId === "anon-1")?.[1];
  assert.ok(anonymized);
  assert.equal(anonymized.participantId, null);
  assert.equal(anonymized.anonymized, true);
  assert.equal("exactTimestamp" in anonymized.fields, false);
  assert.equal(anonymized.collectedAt, "2026-09-16");
});

test("撤回后下游使用方收到处置事项，出库登记转为待处置", () => {
  const { service, exportId } = setup();

  const result = service.withdraw(pid(2));

  assert.equal(result.disposalTasksIssued, 1);
  const tasks = service.listDisposalTasks("analytics-team");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.exportId, exportId);
  assert.equal(tasks[0]?.reason, "consent_withdrawn");
  assert.equal(tasks[0]?.status, "pending");

  const downstream = service.traceDataset("ds-del").downstream;
  assert.equal(downstream[0]?.disposalStatus, "disposal_requested");

  // 使用方完成处置后，出库登记转为已处置
  service.completeDisposalTask(tasks[0]?.taskId ?? "");
  assert.equal(service.traceDataset("ds-del").downstream[0]?.disposalStatus, "disposed");
});

test("合规证明不含个人数据，仅含指纹与计数", () => {
  const { service } = setup();

  const result = service.withdraw(pid(3));

  assert.ok(result.proofId);
  const proofs = service.proofs();
  const proof = proofs.find((entry) => entry.entryId === result.proofId);
  assert.ok(proof);
  assert.equal(proof.eventType, "consent_withdrawn");
  assert.match(proof.subjectFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(proofs).includes(pid(3)), false, "合规证明不得包含明文参与标识");
  assert.equal(proof.details.recordsDeleted, 1);
  assert.equal(proof.details.recordsAnonymized, 1);
});

test("离线传感器补传命中墓碑：不得重建已撤回身份", () => {
  const { service } = setup();
  service.withdraw(pid(4));

  // 离线设备稍后补传同一参与标识的数据
  const late = service.ingest({
    recordId: "late-1",
    participantId: pid(4),
    datasetId: "ds-del",
    source: "sensor",
    fields: { zone: "hall-b", dwellSeconds: 30 },
    collectedAt: "2026-09-16T09:00:00.000Z",
  });

  assert.equal(late.accepted, false);
  assert.equal(late.reason, "identity_retired");
  assert.equal(service.traceDataset("ds-del").records.total, 3, "补传记录不得入库");
  assert.ok(
    service.auditLog().some((entry) => entry.eventType === "late_arrival_blocked"),
    "应留下补传拦截审计",
  );
});

test("已撤回身份不得重新登记同意，重新参与须换新标识", () => {
  const { service } = setup();
  service.withdraw(pid(1));

  assert.throws(
    () => addConsent(service, pid(1)),
    (error: unknown) => error instanceof ServiceError && error.code === "identity_retired",
  );
});

test("撤回后该参与者不再进入出库样本", () => {
  const { service } = setup();
  service.withdraw(pid(1));

  const decision = service.evaluate(EXPORT_REQUEST);

  assert.equal(decision.eligibleParticipants, 3);
});

test("重复撤回幂等：不重复生成合规证明", () => {
  const { service } = setup();
  service.withdraw(pid(1));
  const proofsAfterFirst = service.proofs().length;

  const second = service.withdraw(pid(1));

  assert.equal(second.consentsWithdrawn, 0);
  assert.equal(second.recordsDeleted + second.recordsAnonymized + second.recordsHeld, 0);
  assert.equal(second.proofId, null);
  assert.equal(service.proofs().length, proofsAfterFirst);
});
