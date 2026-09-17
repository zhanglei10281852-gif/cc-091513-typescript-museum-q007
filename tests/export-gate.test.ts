import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExportRequest } from "../src/domain/types.js";
import {
  addConsent,
  addDataset,
  addRecord,
  makeClock,
  makeService,
  pid,
  PROJECT,
  registerFlowProtocol,
  seedCohort,
} from "./helpers.js";

function request(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    datasetId: "ds-1",
    projectId: PROJECT,
    purpose: "flow_analysis",
    role: "researcher",
    consumerId: "analytics-team",
    requestedFields: null,
    ...overrides,
  };
}

test("合规出库：核对通过并只交付方案允许的最小字段", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 4);

  const result = service.executeExport(
    request({ requestedFields: ["zone", "dwellSeconds", "name", "rawVideo"] }),
  );

  assert.equal(result.decision.allowed, true);
  assert.deepEqual(result.decision.minimizedFields, ["zone", "dwellSeconds"]);
  assert.deepEqual(result.decision.droppedFields, ["name", "rawVideo"]);
  assert.equal(result.decision.eligibleParticipants, 4);
  assert.ok(result.exportId);
  assert.equal(result.rows?.length, 4);
  for (const row of result.rows ?? []) {
    assert.deepEqual(Object.keys(row).sort(), ["dwellSeconds", "participantId", "zone"]);
    assert.match(String(row.participantId), /^pt_[a-z0-9]{12,}$/);
  }
});

test("未指定字段时按方案策略交付最小字段集", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 3);

  const result = service.executeExport(request());

  assert.equal(result.decision.allowed, true);
  assert.deepEqual(result.decision.minimizedFields, ["zone", "dwellSeconds", "pathSequence"]);
});

test("角色不在方案允许范围内时拒绝出库", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 3);

  const decision = service.evaluate(request({ role: "marketing" }));

  assert.equal(decision.allowed, false);
  assert.ok(decision.denials.some((denial) => denial.code === "role_not_permitted"));
});

test("研究目的超出方案登记范围时拒绝出库（年龄识别模型场景）", () => {
  const service = makeService();
  // 摄像头派生数据，观众只同意了动线研究
  seedCohort(service, "ds-1", 3);

  const decision = service.evaluate(request({ purpose: "age_model_training" }));

  assert.equal(decision.allowed, false);
  assert.ok(decision.denials.some((denial) => denial.code === "purpose_not_permitted"));
});

test("目的在方案内但既有同意未覆盖时，样本低于阈值拒绝出库", () => {
  const service = makeService();
  // 方案允许 demographic_analysis，但观众只同意了 flow_analysis
  seedCohort(service, "ds-1", 4);

  const decision = service.evaluate(request({ purpose: "demographic_analysis" }));

  assert.equal(decision.allowed, false);
  assert.equal(decision.eligibleParticipants, 0);
  assert.ok(decision.denials.some((denial) => denial.code === "below_disclosure_threshold"));
});

test("数据来源未获方案授权时拒绝出库", () => {
  const service = makeService();
  registerFlowProtocol(service); // allowedSources: survey, sensor
  addDataset(service, "ds-1", { sources: ["observation"] });

  const decision = service.evaluate(request());

  assert.equal(decision.allowed, false);
  assert.ok(decision.denials.some((denial) => denial.code === "source_not_permitted"));
});

test("数据集超过保留期限时拒绝出库", () => {
  const clock = makeClock();
  const service = makeService(clock);
  seedCohort(service, "ds-1", 3);

  clock.advanceMs(200 * 24 * 60 * 60 * 1000); // 超过数据集保留期限
  const decision = service.evaluate(request());

  assert.equal(decision.allowed, false);
  assert.ok(decision.denials.some((denial) => denial.code === "retention_expired"));
});

test("去重参与者低于披露阈值时拒绝出库", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 2); // 阈值 3

  const decision = service.evaluate(request());

  assert.equal(decision.allowed, false);
  assert.equal(decision.eligibleParticipants, 2);
  assert.ok(decision.denials.some((denial) => denial.code === "below_disclosure_threshold"));
});

test("受限同意只在其字段白名单内计入样本", () => {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-1");
  for (const i of [1, 2]) {
    addConsent(service, pid(i));
    addRecord(service, `rec-${i}`, pid(i), "ds-1");
  }
  // 第三位观众仅受限同意 zone 字段
  addConsent(service, pid(3), { state: "restricted", restrictedFields: ["zone"] });
  addRecord(service, "rec-3", pid(3), "ds-1");

  const wide = service.evaluate(request({ requestedFields: ["zone", "dwellSeconds"] }));
  assert.equal(wide.eligibleParticipants, 2);
  assert.ok(wide.denials.some((denial) => denial.code === "below_disclosure_threshold"));

  const narrow = service.evaluate(request({ requestedFields: ["zone"] }));
  assert.equal(narrow.eligibleParticipants, 3);
  assert.equal(narrow.allowed, true);
});

test("方案升级后既有同意不覆盖新版本，对应参与者被排除", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 3);
  service.registerProtocol({
    projectId: PROJECT,
    version: 2,
    purposes: ["flow_analysis"],
    allowedSources: ["survey", "sensor"],
    fieldPolicy: { flow_analysis: ["zone", "dwellSeconds", "pathSequence"] },
    allowedRoles: ["researcher", "dpo"],
    disclosureThreshold: 3,
    retentionDays: 90,
  });

  const decision = service.evaluate(request());

  assert.equal(decision.protocolVersion, 2);
  assert.equal(decision.eligibleParticipants, 0);
  assert.equal(decision.allowed, false);
});

test("出库登记与合规证明只含指纹，不含明文参与标识", () => {
  const service = makeService();
  const participants = seedCohort(service, "ds-1", 3);

  const result = service.executeExport(request());
  assert.equal(result.decision.allowed, true);

  const ledgerJson = JSON.stringify(service.auditLog());
  for (const participantId of participants) {
    assert.equal(ledgerJson.includes(participantId), false, "账本不得包含明文参与标识");
  }
  const proofs = service.proofs();
  assert.ok(proofs.some((entry) => entry.eventType === "export_approved"));
});

test("拒绝出库时留下审计记录", () => {
  const service = makeService();
  seedCohort(service, "ds-1", 3);

  const result = service.executeExport(request({ purpose: "age_model_training" }));

  assert.equal(result.decision.allowed, false);
  assert.equal(result.exportId, null);
  const denied = service.auditLog().filter((entry) => entry.eventType === "export_denied");
  assert.equal(denied.length, 1);
  assert.ok(
    (denied[0]?.details.denials as string[]).includes("purpose_not_permitted"),
    "审计应记录全部拒绝原因",
  );
});
