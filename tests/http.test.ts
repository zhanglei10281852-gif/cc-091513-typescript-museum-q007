import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { MutableClock } from "../src/core/clock.js";
import { DEFAULT_DOMAIN_REFERENCE } from "../src/domain/constants.js";
import { GovernanceService } from "../src/service.js";

const START_ISO = "2026-09-17T09:00:00.000Z";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const clock = new MutableClock(START_ISO);
  const service = new GovernanceService({ clock, reference: DEFAULT_DOMAIN_REFERENCE });
  const server = createApp({ service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const RESEARCHER = { "x-actor-role": "researcher", "x-actor-id": "r1" };
const DPO = { "x-actor-role": "data_protection_officer", "x-actor-id": "dpo-1" };

test("HTTP 端到端：建项、同意、采集、导出、谱系、撤回、补传拦截", async () => {
  await withServer(async (base) => {
    const projectRes = await post(base, "/projects", {
      name: "新展厅停留路径研究",
      purposes: ["dwell_path_analysis"],
      sources: ["survey", "sensor"],
      allowedRoles: ["researcher"],
      allowedFields: ["zone", "dwellSeconds"],
      disclosureThreshold: 3,
      retentionDays: 180,
      expiryAction: "delete",
    });
    assert.equal(projectRes.status, 201);
    const projectId = projectRes.body.projectId as string;

    for (const pid of ["p1", "p2", "p3"]) {
      const consentRes = await post(base, "/consents", {
        participantId: pid,
        projectId,
        purposes: ["dwell_path_analysis"],
        sources: ["survey"],
        validUntil: "2028-01-01T00:00:00.000Z",
      });
      assert.equal(consentRes.status, 201);
      const recordRes = await post(base, `/projects/${projectId}/records`, {
        participantId: pid,
        source: "survey",
        fields: { zone: "hall-1", dwellSeconds: 120 },
      });
      assert.equal(recordRes.status, 200);
      assert.equal(recordRes.body.outcome, "accepted");
    }

    // 目的漂移（年龄识别模型）被拒
    const drift = await post(
      base,
      "/exports",
      { projectId, purpose: "age_model_training", sources: ["survey"], fields: ["zone"] },
      RESEARCHER,
    );
    assert.equal(drift.status, 403);
    assert.ok(drift.body.reasons.includes("purpose_mismatch"));

    // 合规导出
    const approved = await post(
      base,
      "/exports",
      {
        projectId,
        purpose: "dwell_path_analysis",
        sources: ["survey"],
        fields: ["zone", "dwellSeconds"],
      },
      RESEARCHER,
    );
    assert.equal(approved.status, 201);
    const datasetId = approved.body.datasetId as string;
    assert.equal(approved.body.rows.length, 3);
    assert.ok(!JSON.stringify(approved.body.rows).includes('"p1"'));

    // 谱系仅数据保护负责人可查
    const forbidden = await fetch(`${base}/datasets/${datasetId}/lineage`);
    assert.equal(forbidden.status, 403);
    const lineageRes = await fetch(`${base}/datasets/${datasetId}/lineage`, { headers: DPO });
    assert.equal(lineageRes.status, 200);
    const lineage = (await lineageRes.json()) as Json;
    assert.equal(lineage.lawfulBasis.consents.length, 3);
    assert.equal(lineage.retention.expiryAction, "delete");

    // 撤回并出具证明
    const withdrawal = await post(base, "/withdrawals", { participantId: "p1" });
    assert.equal(withdrawal.status, 201);
    assert.ok(!JSON.stringify(withdrawal.body.proof).includes('"p1"'));
    const proofRes = await fetch(
      `${base}/withdrawals/${withdrawal.body.withdrawalId}/proof`,
    );
    assert.equal(proofRes.status, 200);

    // 迟到的离线补传被拦截
    const late = await post(base, `/projects/${projectId}/ingest-batch`, {
      source: "sensor",
      items: [{ participantId: "p1", fields: { zone: "hall-2" } }],
    });
    assert.equal(late.status, 200);
    assert.equal(late.body.outcomes[0].outcome, "dropped_withdrawn");

    // 审计链验证
    const verify = await fetch(`${base}/audit/verify`, { headers: DPO });
    assert.equal(verify.status, 200);
    assert.equal(((await verify.json()) as Json).valid, true);
  });
});

test("HTTP 校验：非法请求体与未知路由", async () => {
  await withServer(async (base) => {
    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);

    const badJson = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal(badJson.status, 400);

    const missing = await post(base, "/projects", { name: "x" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "invalid_field");

    const badRole = await post(
      base,
      "/exports",
      { projectId: "prj_x", purpose: "p", sources: [], fields: [] },
      { "x-actor-role": "superadmin" },
    );
    assert.equal(badRole.status, 400);
    assert.equal(badRole.body.error, "invalid_role");
  });
});

test("HTTP：方案版本升级后既有同意受限，重新同意后恢复导出", async () => {
  await withServer(async (base) => {
    const projectRes = await post(base, "/projects", {
      name: "新展厅停留路径研究",
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      allowedRoles: ["researcher"],
      allowedFields: ["zone"],
      disclosureThreshold: 2,
      retentionDays: 180,
      expiryAction: "delete",
    });
    const projectId = projectRes.body.projectId as string;
    for (const pid of ["p1", "p2"]) {
      await post(base, "/consents", {
        participantId: pid,
        projectId,
        purposes: ["dwell_path_analysis"],
        sources: ["survey"],
        validUntil: "2028-01-01T00:00:00.000Z",
      });
      await post(base, `/projects/${projectId}/records`, {
        participantId: pid,
        source: "survey",
        fields: { zone: "hall-1" },
      });
    }

    const versionRes = await post(base, `/projects/${projectId}/protocol-versions`, {
      version: "2.0.0",
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      requiresReconsent: true,
    });
    assert.equal(versionRes.status, 201);
    assert.equal(versionRes.body.restricted, 2);

    const denied = await post(
      base,
      "/exports",
      { projectId, purpose: "dwell_path_analysis", sources: ["survey"], fields: ["zone"] },
      RESEARCHER,
    );
    assert.equal(denied.status, 403);
    assert.ok(denied.body.reasons.includes("no_eligible_records"));
  });
});
