import { GovernanceService } from "../src/domain/service.js";
import type { DataSourceType, ExpiryAction } from "../src/domain/types.js";

export const NOW = new Date("2026-09-17T10:00:00.000Z");
export const FUTURE = "2026-12-31T00:00:00.000Z";
export const SECRET = "test-secret";

export interface TestClock {
  now: () => Date;
  advanceMs: (ms: number) => void;
}

export function makeClock(start: Date = NOW): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

export function makeService(clock: TestClock = makeClock()): GovernanceService {
  return new GovernanceService({ now: clock.now, secret: SECRET });
}

/** 生成符合随机参与标识格式的测试标识。 */
export function pid(n: number): string {
  return `pt_${String(n).padStart(12, "0")}`;
}

export const PROJECT = "flow-study";

export function registerFlowProtocol(
  service: GovernanceService,
  overrides: Partial<Parameters<GovernanceService["registerProtocol"]>[0]> = {},
): void {
  service.registerProtocol({
    projectId: PROJECT,
    version: 1,
    purposes: ["flow_analysis", "demographic_analysis"],
    allowedSources: ["survey", "sensor", "derived_dataset"],
    fieldPolicy: {
      flow_analysis: ["zone", "dwellSeconds", "pathSequence"],
      demographic_analysis: ["ageBand"],
    },
    allowedRoles: ["researcher", "dpo"],
    disclosureThreshold: 3,
    retentionDays: 90,
    ...overrides,
  });
}

export function addConsent(
  service: GovernanceService,
  participantId: string,
  overrides: Partial<Parameters<GovernanceService["registerConsent"]>[0]> = {},
): void {
  service.registerConsent({
    participantId,
    projectId: PROJECT,
    source: "survey",
    purposes: ["flow_analysis"],
    protocolVersions: [1],
    retentionUntil: FUTURE,
    ...overrides,
  });
}

export function addDataset(
  service: GovernanceService,
  datasetId: string,
  overrides: Partial<Parameters<GovernanceService["registerDataset"]>[0]> = {},
): void {
  service.registerDataset({
    datasetId,
    projectId: PROJECT,
    sources: ["survey", "sensor"],
    expiryAction: "delete",
    retentionUntil: FUTURE,
    ...overrides,
  });
}

export function addRecord(
  service: GovernanceService,
  recordId: string,
  participantId: string,
  datasetId: string,
  fields: Record<string, unknown> = {},
  source: DataSourceType = "survey",
): void {
  service.ingest({
    recordId,
    participantId,
    datasetId,
    source,
    fields: { zone: "hall-a", dwellSeconds: 120, ...fields },
    collectedAt: "2026-09-16T14:23:11.000Z",
  });
}

/** 标准场景：方案 v1 + 数据集 + n 个已同意参与者各一条记录。 */
export function seedCohort(
  service: GovernanceService,
  datasetId: string,
  count: number,
  options: { expiryAction?: ExpiryAction; purposes?: string[] } = {},
): string[] {
  registerFlowProtocol(service);
  addDataset(service, datasetId, options.expiryAction ? { expiryAction: options.expiryAction } : {});
  const participants: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const participantId = pid(i);
    participants.push(participantId);
    addConsent(service, participantId, {
      purposes: options.purposes ?? ["flow_analysis"],
    });
    addRecord(service, `rec-${datasetId}-${i}`, participantId, datasetId);
  }
  return participants;
}
