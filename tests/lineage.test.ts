import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAY_MS,
  consentAndIngest,
  exportDwellPaths,
  makeService,
  seedProject,
} from "./helpers.js";

test("从数据集反查合法来源、到期动作与全部下游去向", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  const datasetId = exportDwellPaths(service, project.projectId).datasetId as string;
  service.registerConsumer(datasetId, { name: "analytics-team" });
  service.deriveDataset(
    datasetId,
    { name: "路径特征集", purpose: "dwell_path_analysis" },
    "researcher-1",
  );

  const lineage = service.getDatasetLineage(datasetId);

  // 合法来源：同意清单（仅密钥散列定位子）与来源构成
  assert.equal(lineage.lawfulBasis.consents.length, 3);
  assert.equal(lineage.lawfulBasis.purpose, "dwell_path_analysis");
  assert.equal(lineage.lawfulBasis.protocolVersion, "1.0.0");
  assert.equal(lineage.lawfulBasis.sourceBreakdown["survey"], 3);
  for (const consent of lineage.lawfulBasis.consents) {
    assert.ok(!["p1", "p2", "p3"].includes(consent.participantLocator));
    assert.equal(consent.state, "granted");
  }

  // 到期动作
  assert.equal(lineage.retention.expiryAction, "delete");
  assert.ok(Date.parse(lineage.retention.expiresAt) > Date.parse("2026-09-17T00:00:00Z"));

  // 全部下游去向
  assert.equal(lineage.downstream.consumers.length, 2);
  assert.ok(lineage.downstream.consumers.some((consumer) => consumer.name === "analytics-team"));
  assert.equal(lineage.downstream.derivedDatasets.length, 1);
  assert.equal(lineage.downstream.dispositionNotices.length, 0);

  // 撤回后谱系反映处置事项与记录状态
  service.withdraw({ participantId: "p2" });
  const after = service.getDatasetLineage(datasetId);
  assert.equal(after.status, "disposition_pending");
  assert.equal(after.downstream.dispositionNotices.length, 2);
  assert.equal(after.lawfulBasis.recordStatusBreakdown["deleted"], 1);
  assert.equal(
    after.lawfulBasis.consents.find((consent) => consent.state === "withdrawn") !== undefined,
    true,
  );
});

test("保留巡检对到期记录与数据集执行到期动作", () => {
  const { service, clock } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  const datasetId = exportDwellPaths(service, project.projectId).datasetId as string;

  clock.advance(181 * DAY_MS);
  const result = service.runRetentionSweep();

  assert.equal(result.recordsDeleted, 3);
  assert.equal(result.datasetsDestroyed, 1);
  assert.equal(result.consentsExpired, 0);
  const dataset = service.getDataset(datasetId);
  assert.equal(dataset.status, "destroyed");
  assert.deepEqual(dataset.rows, []);
  assert.equal(service.verifyAudit().valid, true);
});

test("匿名化到期动作剥离可识别字段并重键参与标识", () => {
  const { service, clock } = makeService();
  const project = seedProject(service, { expiryAction: "anonymize" });
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"], {
    zone: "hall-1",
    faceTemplate: "tpl-x",
  });

  clock.advance(181 * DAY_MS);
  const result = service.runRetentionSweep();

  assert.equal(result.recordsAnonymized, 3);
  for (const record of service.store.state.records) {
    assert.equal(record.status, "anonymized");
    assert.ok(record.participantId.startsWith("anon_"));
    assert.equal(record.fields["faceTemplate"], undefined);
    assert.equal(record.fields["zone"], "hall-1");
  }
});

test("review_hold 到期动作将记录挂起待审", () => {
  const { service, clock } = makeService();
  const project = seedProject(service, { expiryAction: "review_hold" });
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  clock.advance(181 * DAY_MS);
  const result = service.runRetentionSweep();

  assert.equal(result.recordsHeld, 3);
  for (const record of service.store.state.records) {
    assert.equal(record.status, "expired");
    assert.equal(record.statusReason, "review_hold");
  }
});

test("同意有效期过后巡检将其推进为 expired", () => {
  const { service, clock } = makeService();
  const project = seedProject(service);
  service.grantConsent({
    participantId: "p1",
    projectId: project.projectId,
    purposes: ["dwell_path_analysis"],
    sources: ["survey"],
    validUntil: "2026-09-20T00:00:00.000Z",
  });

  clock.advance(4 * DAY_MS);
  const result = service.runRetentionSweep();

  assert.equal(result.consentsExpired, 1);
  assert.equal(service.findConsents("p1")[0]?.state, "expired");
});
