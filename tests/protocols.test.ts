import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceError } from "../src/domain/service.js";
import type { ExportRequest } from "../src/domain/types.js";
import { addConsent, addDataset, addRecord, makeService, pid, PROJECT, registerFlowProtocol } from "./helpers.js";

function upgradeToV2(service: ReturnType<typeof makeService>) {
  return service.registerProtocol({
    projectId: PROJECT,
    version: 2,
    purposes: ["flow_analysis"],
    allowedSources: ["survey", "sensor"],
    fieldPolicy: { flow_analysis: ["zone", "dwellSeconds", "pathSequence"] },
    allowedRoles: ["researcher", "dpo"],
    disclosureThreshold: 3,
    retentionDays: 90,
  });
}

const REQUEST: ExportRequest = {
  datasetId: "ds-1",
  projectId: PROJECT,
  purpose: "flow_analysis",
  role: "researcher",
  consumerId: "analytics-team",
  requestedFields: null,
};

test("方案版本升级时重新判断既有同意是否覆盖", () => {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-1");
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i), { protocolVersions: [1] });
    addRecord(service, `rec-${i}`, pid(i), "ds-1");
  }

  const { reevaluation } = upgradeToV2(service);

  assert.ok(reevaluation);
  assert.equal(reevaluation.coveredCount, 0);
  assert.equal(reevaluation.requiresReconsent.length, 3);
  for (const fp of reevaluation.requiresReconsent) {
    assert.match(fp, /^[0-9a-f]{64}$/, "重估清单只含指纹，不含明文参与标识");
  }
  assert.ok(service.auditLog().some((entry) => entry.eventType === "consent_reevaluated"));
});

test("未覆盖新版本的同意在新方案下出库被排除，重新同意后恢复", () => {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-1");
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i), { protocolVersions: [1] });
    addRecord(service, `rec-${i}`, pid(i), "ds-1");
  }
  upgradeToV2(service);

  const blocked = service.evaluate(REQUEST);
  assert.equal(blocked.protocolVersion, 2);
  assert.equal(blocked.eligibleParticipants, 0);
  assert.equal(blocked.allowed, false);

  // 观众针对 v2 重新同意
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i), { protocolVersions: [1, 2] });
  }
  const allowed = service.evaluate(REQUEST);
  assert.equal(allowed.eligibleParticipants, 3);
  assert.equal(allowed.allowed, true);
});

test("部分观众覆盖新版本时按实际覆盖计算样本", () => {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-1");
  for (const i of [1, 2, 3, 4]) {
    addConsent(service, pid(i), { protocolVersions: i <= 3 ? [1, 2] : [1] });
    addRecord(service, `rec-${i}`, pid(i), "ds-1");
  }
  const { reevaluation } = upgradeToV2(service);

  assert.equal(reevaluation?.coveredCount, 3);
  assert.equal(reevaluation?.requiresReconsent.length, 1);

  const decision = service.evaluate(REQUEST);
  assert.equal(decision.eligibleParticipants, 3);
  assert.equal(decision.allowed, true);
});

test("方案版本只允许递增", () => {
  const service = makeService();
  registerFlowProtocol(service);
  upgradeToV2(service);

  assert.throws(
    () => upgradeToV2(service),
    (error: unknown) => error instanceof ServiceError && error.code === "version_not_advanced",
  );
});
