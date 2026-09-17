import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExportRequest } from "../src/domain/types.js";
import { addConsent, addDataset, addRecord, makeClock, makeService, pid, PROJECT, registerFlowProtocol } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function requestFor(datasetId: string): ExportRequest {
  return {
    datasetId,
    projectId: PROJECT,
    purpose: "flow_analysis",
    role: "researcher",
    consumerId: "analytics-team",
    requestedFields: null,
  };
}

test("到期清扫按登记的到期动作处置记录并通知下游", () => {
  const clock = makeClock();
  const service = makeService(clock);
  registerFlowProtocol(service);
  addDataset(service, "ds-del", { expiryAction: "delete", retentionUntil: "2026-09-20T00:00:00.000Z" });
  addDataset(service, "ds-anon", { expiryAction: "anonymize", retentionUntil: "2026-09-20T00:00:00.000Z" });
  addDataset(service, "ds-hold", { expiryAction: "review_hold", retentionUntil: "2026-09-20T00:00:00.000Z" });
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i), { retentionUntil: "2026-09-20T00:00:00.000Z" });
    addRecord(service, `del-${i}`, pid(i), "ds-del");
    addRecord(service, `anon-${i}`, pid(i), "ds-anon");
    addRecord(service, `hold-${i}`, pid(i), "ds-hold");
  }
  service.executeExport(requestFor("ds-del"));

  clock.advanceMs(5 * DAY_MS); // 超过全部保留期限
  const result = service.runExpirySweep();

  assert.deepEqual(result.datasetsExpired.sort(), ["ds-anon", "ds-del", "ds-hold"]);
  assert.equal(result.recordsDeleted, 3);
  assert.equal(result.recordsAnonymized, 3);
  assert.equal(result.recordsHeld, 3);
  assert.equal(result.consentsExpired, 3);
  assert.equal(result.disposalTasksIssued, 1);

  const tasks = service.listDisposalTasks("analytics-team");
  assert.equal(tasks[0]?.reason, "retention_expired");

  // 到期数据集不得再出库
  const decision = service.evaluate(requestFor("ds-del"));
  assert.ok(decision.denials.some((denial) => denial.code === "retention_expired"));

  // 隔离数据集的记录保留但不可出库
  const holdLineage = service.traceDataset("ds-hold");
  assert.equal(holdLineage.records.held, 3);
  assert.equal(service.evaluate(requestFor("ds-hold")).eligibleParticipants, 0);

  // 留下合规证明
  assert.ok(service.proofs().some((entry) => entry.eventType === "dataset_expired"));
});

test("记录级保留期早于数据集时也按到期动作处置", () => {
  const clock = makeClock();
  const service = makeService(clock);
  registerFlowProtocol(service);
  addDataset(service, "ds-1", { expiryAction: "delete", retentionUntil: "2026-12-31T00:00:00.000Z" });
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i));
    addRecord(service, `rec-${i}`, pid(i), "ds-1");
  }
  // 一条记录保留期更短
  service.ingest({
    recordId: "rec-short",
    participantId: pid(1),
    datasetId: "ds-1",
    source: "survey",
    fields: { zone: "hall-c" },
    collectedAt: "2026-09-16T10:00:00.000Z",
    retentionUntil: "2026-09-18T00:00:00.000Z",
  });

  clock.advanceMs(2 * DAY_MS); // 仅超过 rec-short 的保留期
  const result = service.runExpirySweep();

  assert.equal(result.datasetsExpired.length, 0);
  assert.equal(result.recordsDeleted, 1);
  assert.ok(service.proofs().some((entry) => entry.eventType === "records_expired"));
});

test("记录保留期不得超出数据集保留期", () => {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-1", { retentionUntil: "2026-10-01T00:00:00.000Z" });
  addConsent(service, pid(1));

  service.ingest({
    recordId: "rec-1",
    participantId: pid(1),
    datasetId: "ds-1",
    source: "survey",
    fields: {},
    collectedAt: "2026-09-16T10:00:00.000Z",
    retentionUntil: "2027-06-01T00:00:00.000Z",
  });

  const record = service.snapshot().records.find(([id]) => id === "rec-1")?.[1];
  assert.equal(record?.retentionUntil, "2026-10-01T00:00:00.000Z", "记录保留期应被截断到数据集保留期");
});
