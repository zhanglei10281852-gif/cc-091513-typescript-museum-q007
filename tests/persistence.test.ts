import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MutableClock } from "../src/core/clock.js";
import { Store } from "../src/core/store.js";
import { DEFAULT_DOMAIN_REFERENCE } from "../src/domain/constants.js";
import { GovernanceService } from "../src/service.js";
import { START_ISO, consentAndIngest, makeService, seedProject } from "./helpers.js";

test("状态持久化后撤回墓碑与审计链仍然有效", () => {
  const dir = mkdtempSync(join(tmpdir(), "gov-state-"));
  const file = join(dir, "state.json");
  const clock = new MutableClock(START_ISO);

  const store1 = Store.load(file);
  const service1 = new GovernanceService({
    store: store1,
    clock,
    reference: DEFAULT_DOMAIN_REFERENCE,
  });
  const project = seedProject(service1);
  consentAndIngest(service1, project.projectId, ["p1", "p2", "p3"]);
  const { withdrawal } = service1.withdraw({ participantId: "p1" });
  store1.save();

  // 模拟重启：从快照恢复
  const store2 = Store.load(file);
  const service2 = new GovernanceService({
    store: store2,
    clock,
    reference: DEFAULT_DOMAIN_REFERENCE,
  });

  // 迟到补传仍被拦截，已撤回身份不得重建
  const late = service2.ingestRecord(project.projectId, {
    participantId: "p1",
    source: "sensor",
    fields: { zone: "hall-2" },
  });
  assert.equal(late.outcome, "dropped_withdrawn");

  // 审计链与合规证明在重启后仍可验证、可查询
  assert.equal(service2.verifyAudit().valid, true);
  const proof = service2.getWithdrawalProof(withdrawal.withdrawalId);
  assert.equal(proof.recordsDeleted, 1);
  assert.ok(!JSON.stringify(proof).includes('"p1"'));
});

test("审计日志拒绝写入个人数据字段", () => {
  const { service } = makeService();
  assert.throws(() => service.audit.record("probe", { participantId: "p1" }), /个人数据/);
  assert.throws(
    () => service.audit.record("probe", { nested: { fields: { zone: "A" } } }),
    /个人数据/,
  );
});
