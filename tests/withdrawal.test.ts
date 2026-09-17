import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAR_FUTURE,
  consentAndIngest,
  exportDwellPaths,
  makeService,
  seedProject,
} from "./helpers.js";

test("撤回：记录删除、下游通知、合规证明不含个人数据", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3", "p4"]);

  const datasetId = exportDwellPaths(service, project.projectId).datasetId as string;
  service.registerConsumer(datasetId, { name: "analytics-team" });
  const derived = service.deriveDataset(
    datasetId,
    { name: "路径特征集", purpose: "dwell_path_analysis", consumerName: "ml-team" },
    "researcher-1",
  );
  assert.equal(derived.approved, true);

  const { proof } = service.withdraw({ participantId: "p1" });

  // 同意全部撤回
  assert.ok(service.findConsents("p1").every((consent) => consent.state === "withdrawn"));

  // 可定位记录已删除
  const records = service.findRecords("p1");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "deleted");
  assert.deepEqual(records[0]?.fields, {});

  // 数据集进入处置流程，服务端留存副本已清除该参与者行
  const dataset = service.getDataset(datasetId);
  assert.equal(dataset.status, "disposition_pending");
  assert.equal(dataset.rowCount, 3);
  const child = service.getDataset(derived.datasetId as string);
  assert.equal(child.status, "disposition_pending");

  // 下游通知：导出数据集 2 个消费者 + 派生数据集 1 个
  const notices = service.listNotices();
  assert.equal(notices.length, 3);
  assert.equal(
    notices.find((notice) => notice.datasetId === child.datasetId)?.action,
    "destroy_dataset",
  );
  assert.ok(
    notices
      .filter((notice) => notice.datasetId === datasetId)
      .every((notice) => notice.action === "purge_participant_rows"),
  );

  // 合规证明不含个人数据
  const proofJson = JSON.stringify(proof);
  assert.ok(!proofJson.includes('"p1"'));
  assert.ok(!proofJson.includes("participantId"));
  assert.equal(proof.recordsDeleted, 1);
  assert.equal(proof.consentsWithdrawn, 1);
  assert.equal(proof.datasetsAffected.length, 2);
  assert.equal(proof.noticesIssued.length, 3);

  // 审计链完整
  assert.equal(service.verifyAudit().valid, true);
});

test("撤回后离线传感器补传不得重建已撤回身份", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  service.grantConsent({
    participantId: "p5",
    projectId: project.projectId,
    purposes: ["dwell_path_analysis"],
    sources: ["sensor"],
    validUntil: FAR_FUTURE,
  });
  service.withdraw({ participantId: "p1" });

  const single = service.ingestRecord(project.projectId, {
    participantId: "p1",
    source: "sensor",
    fields: { zone: "hall-2" },
  });
  assert.equal(single.outcome, "dropped_withdrawn");

  const outcomes = service.ingestBatch(project.projectId, "sensor", [
    { participantId: "p1", fields: { zone: "hall-2" } },
    { participantId: "p5", fields: { zone: "hall-2" } },
  ]);
  assert.equal(outcomes[0]?.outcome, "dropped_withdrawn");
  assert.equal(outcomes[1]?.outcome, "accepted");

  // 被丢弃的补传没有产生任何记录
  assert.equal(service.findRecords("p1").length, 1);
});

test("匿名化策略：撤回后记录不可逆匿名化且不再参与导出", () => {
  const { service } = makeService();
  const project = seedProject(service, { withdrawalAction: "anonymize" });
  for (const pid of ["p1", "p2", "p3"]) {
    service.grantConsent({
      participantId: pid,
      projectId: project.projectId,
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      validUntil: FAR_FUTURE,
    });
    service.ingestRecord(project.projectId, {
      participantId: pid,
      source: "survey",
      fields: { zone: "hall-1", faceTemplate: `tpl-${pid}` },
    });
  }

  const { proof } = service.withdraw({ participantId: "p1" });
  assert.equal(proof.recordsAnonymized, 1);
  assert.equal(proof.recordsDeleted, 0);

  const anonymized = service.store.state.records.find(
    (record) => record.status === "anonymized",
  );
  assert.ok(anonymized);
  assert.ok(anonymized.participantId.startsWith("anon_"));
  assert.equal(anonymized.fields["faceTemplate"], undefined);
  assert.equal(anonymized.fields["zone"], "hall-1");

  // 匿名化记录无同意可依，导出只剩 2 人 → 低于阈值
  const decision = exportDwellPaths(service, project.projectId);
  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("below_disclosure_threshold"));
});

test("下游确认处置后数据集状态收尾", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  const datasetId = exportDwellPaths(service, project.projectId).datasetId as string;
  service.withdraw({ participantId: "p1" });

  const notices = service.listNotices().filter((notice) => notice.datasetId === datasetId);
  assert.equal(notices.length, 1);
  for (const notice of notices) {
    service.acknowledgeNotice(notice.noticeId, notice.consumerId);
  }
  assert.equal(service.getDataset(datasetId).status, "purged");
});

test("参与者重新同意后墓碑解除，可恢复采集", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  service.withdraw({ participantId: "p1" });
  assert.equal(
    service.ingestRecord(project.projectId, { participantId: "p1", source: "survey" }).outcome,
    "dropped_withdrawn",
  );

  service.grantConsent({
    participantId: "p1",
    projectId: project.projectId,
    purposes: ["dwell_path_analysis"],
    sources: ["survey"],
    validUntil: FAR_FUTURE,
  });
  const reingested = service.ingestRecord(project.projectId, {
    participantId: "p1",
    source: "survey",
    fields: { zone: "hall-3" },
  });
  assert.equal(reingested.outcome, "accepted");
});

test("撤回未知参与标识返回未找到", () => {
  const { service } = makeService();
  assert.throws(() => service.withdraw({ participantId: "ghost" }), /未找到/);
});
