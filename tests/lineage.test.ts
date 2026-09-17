import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExportRequest } from "../src/domain/types.js";
import { addConsent, addDataset, addRecord, makeService, pid, PROJECT, registerFlowProtocol } from "./helpers.js";

function requestFor(datasetId: string, consumerId: string): ExportRequest {
  return {
    datasetId,
    projectId: PROJECT,
    purpose: "flow_analysis",
    role: "researcher",
    consumerId,
    requestedFields: null,
  };
}

/** 原始数据集 -> 派生数据集 -> 两个下游使用方。 */
function setup() {
  const service = makeService();
  registerFlowProtocol(service);
  addDataset(service, "ds-raw", { sources: ["survey", "sensor"] });
  addDataset(service, "ds-derived", {
    sources: ["derived_dataset"],
    upstreamDatasetIds: ["ds-raw"],
    expiryAction: "anonymize",
  });
  for (const i of [1, 2, 3]) {
    addConsent(service, pid(i));
    addRecord(service, `raw-${i}`, pid(i), "ds-raw");
    addRecord(service, `der-${i}`, pid(i), "ds-derived", {}, "derived_dataset");
  }
  service.executeExport(requestFor("ds-derived", "team-a"));
  service.executeExport(requestFor("ds-derived", "team-b"));
  return service;
}

test("从数据集反查合法来源链与到期动作", () => {
  const service = setup();

  const lineage = service.traceDataset("ds-derived");

  assert.equal(lineage.projectId, PROJECT);
  assert.equal(lineage.protocolVersion, 1);
  assert.deepEqual(lineage.sources, ["derived_dataset"]);
  assert.deepEqual(lineage.upstreamDatasetIds, ["ds-raw"], "派生数据集必须能反查上游来源");
  assert.equal(lineage.expiryAction, "anonymize");
  assert.equal(lineage.expiredAt, null);
  assert.equal(lineage.records.total, 3);
  assert.equal(lineage.consentCoverage.granted, 3);
});

test("从数据集反查全部下游去向", () => {
  const service = setup();

  const lineage = service.traceDataset("ds-derived");

  assert.equal(lineage.downstream.length, 2);
  assert.deepEqual(
    lineage.downstream.map((item) => item.consumerId).sort(),
    ["team-a", "team-b"],
  );
  assert.ok(lineage.downstream.every((item) => item.disposalStatus === "active"));
});

test("撤回传播后，谱系中的下游去向同步更新处置状态", () => {
  const service = setup();
  service.withdraw(pid(1));

  const lineage = service.traceDataset("ds-derived");

  assert.ok(lineage.downstream.every((item) => item.disposalStatus === "disposal_requested"));
  const tasksA = service.listDisposalTasks("team-a");
  const tasksB = service.listDisposalTasks("team-b");
  assert.equal(tasksA.length, 1);
  assert.equal(tasksB.length, 1);
});

test("谱系视图不包含明文参与标识", () => {
  const service = setup();

  const lineageJson = JSON.stringify(service.traceDataset("ds-derived"));

  for (const i of [1, 2, 3]) {
    assert.equal(lineageJson.includes(pid(i)), false);
  }
});
