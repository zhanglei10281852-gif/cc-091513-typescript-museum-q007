import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAY_MS,
  consentAndIngest,
  exportDwellPaths,
  makeService,
  seedProject,
} from "./helpers.js";

test("批准的导出只交付最小字段与按数据集重键控的假名标识", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3", "p4"]);

  const decision = service.requestExport({
    projectId: project.projectId,
    purpose: "dwell_path_analysis",
    sources: ["survey"],
    fields: ["zone", "dwellSeconds", "name"],
    actor: "researcher-1",
    role: "researcher",
  });

  assert.equal(decision.approved, true);
  assert.deepEqual([...decision.deliveredFields].sort(), ["dwellSeconds", "zone"]);
  assert.deepEqual(decision.droppedFields, ["name"]);

  const dataset = service.getDataset(decision.datasetId as string);
  assert.equal(dataset.rowCount, 4);
  assert.equal(dataset.participantCount, 4);
  const rawIds = new Set(["p1", "p2", "p3", "p4"]);
  for (const row of dataset.rows) {
    assert.ok(typeof row.participantKey === "string");
    assert.ok(!rawIds.has(row.participantKey as string));
    assert.equal(row["name"], undefined);
    assert.equal(row["zone"], "hall-1");
  }
  assert.ok(!JSON.stringify(dataset.rows).includes('"p1"'));
});

test("同一参与者在不同数据集中的假名键不同，防止跨数据集关联", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const first = service.getDataset(exportDwellPaths(service, project.projectId).datasetId as string);
  const second = service.getDataset(exportDwellPaths(service, project.projectId).datasetId as string);
  assert.notDeepEqual(
    first.rows.map((row) => row.participantKey).sort(),
    second.rows.map((row) => row.participantKey).sort(),
  );
});

test("目的不符：仅限动线研究的同意不得用于年龄识别模型训练", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const decision = service.requestExport({
    projectId: project.projectId,
    purpose: "age_model_training",
    sources: ["sensor"],
    fields: ["zone"],
    actor: "ml-1",
    role: "researcher",
  });

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("purpose_mismatch"));
});

test("角色不符：未授权角色拒绝出库", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const decision = service.requestExport({
    projectId: project.projectId,
    purpose: "dwell_path_analysis",
    sources: ["survey"],
    fields: ["zone"],
    actor: "ml-1",
    role: "ml_engineer",
  });

  assert.equal(decision.approved, false);
  assert.deepEqual(decision.reasons, ["role_not_permitted"]);
});

test("来源不符：方案未声明的数据来源被拒绝", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const decision = service.requestExport({
    projectId: project.projectId,
    purpose: "dwell_path_analysis",
    sources: ["observation"],
    fields: ["zone"],
    actor: "researcher-1",
    role: "researcher",
  });

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("source_not_permitted"));
});

test("样本低于披露阈值时拒绝出库", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2"]);

  const decision = exportDwellPaths(service, project.projectId);

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("below_disclosure_threshold"));
  assert.equal(decision.eligibleParticipants, 2);
});

test("保留期已过的记录不参与导出", () => {
  const { service, clock } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  clock.advance(181 * DAY_MS);
  const decision = exportDwellPaths(service, project.projectId);

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("no_eligible_records"));
});

test("同意有效期过后记录不再可导出", () => {
  const { service, clock } = makeService();
  const project = seedProject(service);
  for (const pid of ["p1", "p2", "p3"]) {
    service.grantConsent({
      participantId: pid,
      projectId: project.projectId,
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      validUntil: "2026-09-20T00:00:00.000Z",
    });
    service.ingestRecord(project.projectId, {
      participantId: pid,
      source: "survey",
      fields: { zone: "hall-1" },
    });
  }

  clock.advance(4 * DAY_MS);
  const decision = exportDwellPaths(service, project.projectId);

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("no_eligible_records"));
});

test("请求字段全部不可交付时拒绝", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const decision = exportDwellPaths(service, project.projectId, ["name", "email"]);

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("no_deliverable_fields"));
});

test("派生数据集用途漂移被拒绝，同用途派生被允许", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  const datasetId = exportDwellPaths(service, project.projectId).datasetId as string;

  const drift = service.deriveDataset(
    datasetId,
    { name: "年龄识别训练集", purpose: "age_model_training" },
    "ml-1",
  );
  assert.equal(drift.approved, false);
  assert.ok(drift.reasons.includes("purpose_mismatch"));

  const legit = service.deriveDataset(
    datasetId,
    { name: "路径特征集", purpose: "dwell_path_analysis" },
    "researcher-1",
  );
  assert.equal(legit.approved, true);
});
