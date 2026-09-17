import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { GovernanceService } from "../src/domain/service.js";
import { pid } from "./helpers.js";

interface Api {
  base: string;
  close: () => Promise<void>;
}

async function startApi(): Promise<Api> {
  const service = new GovernanceService({
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    secret: "http-test-secret",
  });
  const server = createApp({ service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("HTTP 全流程：登记→采集→出库→撤回→谱系→证明", async () => {
  const api = await startApi();
  try {
    const protocol = await post(api.base, "/protocols", {
      projectId: "flow-study",
      version: 1,
      purposes: ["flow_analysis"],
      allowedSources: ["survey", "sensor"],
      fieldPolicy: { flow_analysis: ["zone", "dwellSeconds"] },
      allowedRoles: ["researcher"],
      disclosureThreshold: 3,
      retentionDays: 90,
    });
    assert.equal(protocol.status, 201);

    const dataset = await post(api.base, "/datasets", {
      datasetId: "ds-1",
      projectId: "flow-study",
      sources: ["survey", "sensor"],
      expiryAction: "delete",
      retentionUntil: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(dataset.status, 201);

    for (const i of [1, 2, 3]) {
      const consent = await post(api.base, "/consents", {
        participantId: pid(i),
        projectId: "flow-study",
        source: "survey",
        purposes: ["flow_analysis"],
        protocolVersions: [1],
        retentionUntil: "2026-12-31T00:00:00.000Z",
      });
      assert.equal(consent.status, 201);
      const record = await post(api.base, "/records", {
        recordId: `rec-${i}`,
        participantId: pid(i),
        datasetId: "ds-1",
        source: "survey",
        fields: { zone: "hall-a", dwellSeconds: 100 + i },
        collectedAt: "2026-09-16T10:00:00.000Z",
      });
      assert.equal(record.status, 201);
    }

    // 目的不符：422
    const denied = await post(api.base, "/exports", {
      datasetId: "ds-1",
      projectId: "flow-study",
      purpose: "age_model_training",
      role: "researcher",
      consumerId: "vision-team",
    });
    assert.equal(denied.status, 422);
    assert.ok(
      denied.json.decision.denials.some((d: { code: string }) => d.code === "purpose_not_permitted"),
    );

    // 合规出库：201 + 最小字段
    const exported = await post(api.base, "/exports", {
      datasetId: "ds-1",
      projectId: "flow-study",
      purpose: "flow_analysis",
      role: "researcher",
      consumerId: "analytics-team",
      requestedFields: ["zone", "dwellSeconds", "name"],
    });
    assert.equal(exported.status, 201);
    assert.deepEqual(exported.json.decision.minimizedFields, ["zone", "dwellSeconds"]);
    assert.equal(exported.json.rows.length, 3);

    // 撤回
    const withdrawn = await post(api.base, "/consents/withdrawals", { participantId: pid(1) });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.json.recordsDeleted, 1);
    assert.equal(withdrawn.json.disposalTasksIssued, 1);

    // 迟到补传被拦截
    const late = await post(api.base, "/records", {
      recordId: "late-1",
      participantId: pid(1),
      datasetId: "ds-1",
      source: "sensor",
      fields: { zone: "hall-b" },
      collectedAt: "2026-09-16T09:00:00.000Z",
    });
    assert.equal(late.status, 200);
    assert.equal(late.json.accepted, false);
    assert.equal(late.json.reason, "identity_retired");

    // 谱系反查
    const lineage = await fetch(`${api.base}/datasets/ds-1/lineage`);
    assert.equal(lineage.status, 200);
    const lineageJson = await lineage.json();
    assert.equal(lineageJson.downstream.length, 1);
    assert.equal(lineageJson.downstream[0].disposalStatus, "disposal_requested");

    // 下游处置事项
    const tasks = await fetch(`${api.base}/disposal-tasks?consumerId=analytics-team`);
    const tasksJson = await tasks.json();
    assert.equal(tasksJson.tasks.length, 1);
    const completed = await post(api.base, `/disposal-tasks/${tasksJson.tasks[0].taskId}/complete`, {});
    assert.equal(completed.status, 200);
    assert.equal(completed.json.status, "completed");

    // 合规证明不含明文参与标识
    const proofs = await fetch(`${api.base}/compliance/proofs`);
    const proofsJson = await proofs.json();
    assert.ok(proofsJson.proofs.length >= 2);
    assert.equal(JSON.stringify(proofsJson).includes(pid(1)), false);
  } finally {
    await api.close();
  }
});

test("非法请求得到明确错误", async () => {
  const api = await startApi();
  try {
    const badJson = await fetch(`${api.base}/protocols`, { method: "POST", body: "not-json" });
    assert.equal(badJson.status, 400);

    const missing = await post(api.base, "/protocols", { projectId: "x" });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, "invalid_field");

    const unknown = await fetch(`${api.base}/datasets/nope/lineage`);
    assert.equal(unknown.status, 404);

    const badId = await post(api.base, "/consents", {
      participantId: "张三",
      projectId: "flow-study",
      source: "survey",
      purposes: ["flow_analysis"],
      protocolVersions: [1],
      retentionUntil: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error, "invalid_participant_id");
  } finally {
    await api.close();
  }
});
