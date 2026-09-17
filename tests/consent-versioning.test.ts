import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAR_FUTURE,
  consentAndIngest,
  exportDwellPaths,
  makeService,
  seedProject,
} from "./helpers.js";

test("方案版本升级要求重新同意时，既有同意被限制且导出被拒", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);
  assert.equal(exportDwellPaths(service, project.projectId).approved, true);

  const outcome = service.addProtocolVersion(project.projectId, {
    version: "2.0.0",
    purposes: ["dwell_path_analysis"],
    sources: ["survey", "sensor"],
    requiresReconsent: true,
  });
  assert.equal(outcome.restricted, 3);
  assert.equal(outcome.carried, 0);
  assert.ok(
    service
      .findConsents("p1")
      .every((consent) => consent.state === "restricted"),
  );

  const denied = exportDwellPaths(service, project.projectId);
  assert.equal(denied.approved, false);
  assert.ok(denied.reasons.includes("no_eligible_records"));

  // 重新同意后恢复导出
  for (const pid of ["p1", "p2", "p3"]) {
    service.grantConsent({
      participantId: pid,
      projectId: project.projectId,
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      validUntil: FAR_FUTURE,
    });
  }
  assert.equal(exportDwellPaths(service, project.projectId).approved, true);
});

test("非实质性变更且范围被既有同意覆盖时自动延续", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const outcome = service.addProtocolVersion(project.projectId, {
    version: "1.1.0",
    purposes: ["dwell_path_analysis"],
    sources: ["survey"],
    requiresReconsent: false,
  });

  assert.equal(outcome.carried, 3);
  assert.equal(outcome.restricted, 0);
  assert.ok(
    service
      .findConsents("p1")
      .every(
        (consent) => consent.state === "granted" && consent.protocolVersion === "1.1.0",
      ),
  );
  assert.equal(exportDwellPaths(service, project.projectId).approved, true);
});

test("非实质性变更但目的扩张超出同意范围时转入受限", () => {
  const { service } = makeService();
  const project = seedProject(service);
  consentAndIngest(service, project.projectId, ["p1", "p2", "p3"]);

  const outcome = service.addProtocolVersion(project.projectId, {
    version: "1.2.0",
    purposes: ["dwell_path_analysis", "age_model_training"],
    sources: ["survey"],
    requiresReconsent: false,
  });

  assert.equal(outcome.restricted, 3);
  const denied = exportDwellPaths(service, project.projectId);
  assert.equal(denied.approved, false);
});

test("重复登记同一方案版本被拒绝", () => {
  const { service } = makeService();
  const project = seedProject(service);
  service.addProtocolVersion(project.projectId, {
    version: "2.0.0",
    purposes: ["dwell_path_analysis"],
    sources: ["survey"],
    requiresReconsent: true,
  });
  assert.throws(
    () =>
      service.addProtocolVersion(project.projectId, {
        version: "2.0.0",
        purposes: ["dwell_path_analysis"],
        sources: ["survey"],
        requiresReconsent: true,
      }),
    /已存在/,
  );
});
