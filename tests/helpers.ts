import { MutableClock } from "../src/core/clock.js";
import { DEFAULT_DOMAIN_REFERENCE } from "../src/domain/constants.js";
import type { Project } from "../src/domain/types.js";
import { GovernanceService } from "../src/service.js";
import type { CreateProjectInput } from "../src/services/projects.js";

export const START_ISO = "2026-09-17T09:00:00.000Z";
export const FAR_FUTURE = "2028-01-01T00:00:00.000Z";
export const DAY_MS = 86_400_000;

export function makeService(startIso: string = START_ISO): {
  service: GovernanceService;
  clock: MutableClock;
} {
  const clock = new MutableClock(startIso);
  const service = new GovernanceService({ clock, reference: DEFAULT_DOMAIN_REFERENCE });
  return { service, clock };
}

export function seedProject(
  service: GovernanceService,
  overrides: Partial<CreateProjectInput> = {},
): Project {
  return service.createProject({
    name: "新展厅停留路径研究",
    purposes: ["dwell_path_analysis"],
    sources: ["survey", "sensor"],
    allowedRoles: ["researcher", "analyst"],
    allowedFields: ["zone", "dwellSeconds", "pathSequence"],
    disclosureThreshold: 3,
    retentionDays: 180,
    expiryAction: "delete",
    withdrawalAction: "delete",
    identifyingFields: ["faceTemplate"],
    ...overrides,
  });
}

export const DEFAULT_FIELDS: Record<string, unknown> = {
  zone: "hall-1",
  dwellSeconds: 120,
  pathSequence: ["entrance", "hall-1"],
};

/** 为若干参与者登记同意并采集一条问卷记录。 */
export function consentAndIngest(
  service: GovernanceService,
  projectId: string,
  participantIds: string[],
  fields: Record<string, unknown> = DEFAULT_FIELDS,
): void {
  for (const participantId of participantIds) {
    service.grantConsent({
      participantId,
      projectId,
      purposes: ["dwell_path_analysis"],
      sources: ["survey"],
      validUntil: FAR_FUTURE,
    });
    service.ingestRecord(projectId, {
      participantId,
      source: "survey",
      fields,
    });
  }
}

export function exportDwellPaths(
  service: GovernanceService,
  projectId: string,
  fields: string[] = ["zone", "dwellSeconds"],
) {
  return service.requestExport({
    projectId,
    purpose: "dwell_path_analysis",
    sources: ["survey"],
    fields,
    actor: "researcher-1",
    role: "researcher",
  });
}
