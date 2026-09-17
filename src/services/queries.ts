import type { Consent, DataRecord, DataSource, Project, ProtocolVersion } from "../domain/types.js";
import { DAY_MS } from "../domain/constants.js";
import type { GovernanceState } from "../core/store.js";

export function findProject(state: GovernanceState, projectId: string): Project | undefined {
  return state.projects.find((project) => project.projectId === projectId);
}

export function currentProtocol(project: Project): ProtocolVersion | undefined {
  return project.protocolVersions.find(
    (version) => version.version === project.currentProtocolVersion,
  );
}

export interface CoverageQuery {
  purpose?: string;
  source: DataSource;
  now: Date;
}

/**
 * 找到一条覆盖给定用途/来源且当前有效的同意。
 * 同意必须处于 granted、与项目当前方案版本一致、且在有效期内。
 */
export function findCoveringConsent(
  state: GovernanceState,
  project: Project,
  participantId: string,
  query: CoverageQuery,
): Consent | undefined {
  return state.consents.find(
    (consent) =>
      consent.participantId === participantId &&
      consent.projectId === project.projectId &&
      consent.state === "granted" &&
      consent.protocolVersion === project.currentProtocolVersion &&
      consent.sources.includes(query.source) &&
      (query.purpose === undefined || consent.purposes.includes(query.purpose)) &&
      Date.parse(consent.validUntil) > query.now.getTime(),
  );
}

/** 撤回墓碑命中即禁止为该参与者重建任何记录。 */
export function isTombstoned(
  state: GovernanceState,
  participantId: string,
  projectId: string,
): boolean {
  return state.tombstones.some(
    (tombstone) =>
      tombstone.participantId === participantId &&
      (tombstone.projectId === null || tombstone.projectId === projectId),
  );
}

export function recordExpired(project: Project, record: DataRecord, now: Date): boolean {
  return Date.parse(record.collectedAt) + project.retentionDays * DAY_MS <= now.getTime();
}

export function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
