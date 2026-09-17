import type { Consent, DataSource, Project, ProtocolVersion } from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { newId, participantLocator } from "../core/crypto.js";
import type { ServiceDeps } from "./deps.js";
import { currentProtocol, findProject, uniq } from "./queries.js";

export interface GrantConsentInput {
  participantId: string;
  projectId: string;
  purposes: string[];
  sources: DataSource[];
  validUntil: string;
}

export class ConsentService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * 登记同意。同意范围不得超出项目当前方案版本声明的目的与来源，
   * 且始终绑定当前方案版本。
   */
  grant(input: GrantConsentInput): Consent {
    const { store, audit, clock, reference } = this.deps;
    const project = findProject(store.state, input.projectId);
    if (!project) {
      throw new DomainError("not_found", `项目不存在: ${input.projectId}`);
    }
    const protocol = currentProtocol(project);
    if (!protocol) {
      throw new DomainError("invalid", "项目缺少当前方案版本");
    }
    for (const source of input.sources) {
      if (!reference.dataSources.includes(source)) {
        throw new DomainError("invalid", `未知数据来源: ${source}`);
      }
      if (!protocol.sources.includes(source)) {
        throw new DomainError(
          "invalid",
          `数据来源 ${source} 超出方案版本 ${protocol.version} 的声明范围`,
        );
      }
    }
    for (const purpose of input.purposes) {
      if (!protocol.purposes.includes(purpose)) {
        throw new DomainError(
          "invalid",
          `研究目的 ${purpose} 超出方案版本 ${protocol.version} 的声明范围`,
        );
      }
    }
    const validUntilMs = Date.parse(input.validUntil);
    if (Number.isNaN(validUntilMs)) {
      throw new DomainError("invalid", "validUntil 不是合法时间");
    }
    if (validUntilMs <= clock.now().getTime()) {
      throw new DomainError("invalid", "validUntil 已过期");
    }

    const consent: Consent = {
      consentId: newId("con"),
      participantId: input.participantId,
      projectId: project.projectId,
      protocolVersion: protocol.version,
      purposes: uniq(input.purposes),
      sources: uniq(input.sources),
      state: "granted",
      grantedAt: clock.now().toISOString(),
      validUntil: new Date(validUntilMs).toISOString(),
    };
    store.state.consents.push(consent);
    audit.record("consent_granted", {
      consentId: consent.consentId,
      projectId: consent.projectId,
      protocolVersion: consent.protocolVersion,
      participantLocator: participantLocator(store.state.secret, consent.participantId),
    });
    return consent;
  }

  /**
   * 方案版本变化后重估既有同意：
   * - 非实质性变更且既有同意覆盖新版本范围 → 自动延续；
   * - 否则转入 restricted，重新同意前不得用于导出。
   */
  reevaluateForProtocol(
    project: Project,
    version: ProtocolVersion,
  ): { carried: number; restricted: number } {
    let carried = 0;
    let restricted = 0;
    for (const consent of this.deps.store.state.consents) {
      if (consent.projectId !== project.projectId) {
        continue;
      }
      if (consent.state !== "granted" && consent.state !== "restricted") {
        continue;
      }
      if (consent.protocolVersion === version.version) {
        consent.state = "granted";
        carried += 1;
        continue;
      }
      const covers =
        version.purposes.every((purpose) => consent.purposes.includes(purpose)) &&
        version.sources.every((source) => consent.sources.includes(source));
      if (!version.requiresReconsent && covers) {
        consent.protocolVersion = version.version;
        consent.state = "granted";
        consent.note = "carried_forward";
        carried += 1;
      } else {
        consent.state = "restricted";
        consent.note = `pending_reconsent_for_${version.version}`;
        restricted += 1;
      }
    }
    return { carried, restricted };
  }

  /** 参与者重新同意时解除对应撤回墓碑，允许恢复采集。 */
  liftTombstones(participantId: string, projectId: string): number {
    const state = this.deps.store.state;
    const before = state.tombstones.length;
    state.tombstones = state.tombstones.filter(
      (tombstone) =>
        !(
          tombstone.participantId === participantId &&
          (tombstone.projectId === null || tombstone.projectId === projectId)
        ),
    );
    return before - state.tombstones.length;
  }
}
