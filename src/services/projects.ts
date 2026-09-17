import { DIRECT_IDENTIFIER_FIELDS } from "../domain/constants.js";
import type {
  DataSource,
  ExpiryAction,
  Project,
  ProtocolVersion,
  Role,
  WithdrawalAction,
} from "../domain/types.js";
import { DomainError } from "../core/errors.js";
import { newId } from "../core/crypto.js";
import type { ServiceDeps } from "./deps.js";
import { currentProtocol, findProject, uniq } from "./queries.js";

export interface CreateProjectInput {
  name: string;
  purposes: string[];
  sources: DataSource[];
  allowedRoles: Role[];
  allowedFields: string[];
  disclosureThreshold: number;
  retentionDays: number;
  expiryAction: ExpiryAction;
  withdrawalAction: WithdrawalAction;
  identifyingFields: string[];
}

export interface AddProtocolVersionInput {
  version: string;
  purposes: string[];
  sources: DataSource[];
  requiresReconsent: boolean;
  note?: string;
}

export class ProjectService {
  constructor(private readonly deps: ServiceDeps) {}

  create(input: CreateProjectInput): Project {
    const { store, audit, clock } = this.deps;
    const forbidden = input.allowedFields.filter((field) =>
      DIRECT_IDENTIFIER_FIELDS.includes(field),
    );
    if (forbidden.length > 0) {
      throw new DomainError("invalid", `可交付字段包含直接标识符: ${forbidden.join(", ")}`);
    }
    if (input.purposes.length === 0) {
      throw new DomainError("invalid", "至少声明一个研究目的");
    }
    if (input.sources.length === 0) {
      throw new DomainError("invalid", "至少声明一个数据来源");
    }
    if (input.allowedRoles.length === 0) {
      throw new DomainError("invalid", "至少声明一个可访问角色");
    }
    if (!Number.isInteger(input.disclosureThreshold) || input.disclosureThreshold < 1) {
      throw new DomainError("invalid", "披露阈值必须是正整数");
    }
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
      throw new DomainError("invalid", "保留期限必须是正整数天数");
    }

    const now = clock.now().toISOString();
    const version: ProtocolVersion = {
      version: "1.0.0",
      purposes: uniq(input.purposes),
      sources: uniq(input.sources),
      requiresReconsent: false,
      effectiveFrom: now,
    };
    const project: Project = {
      projectId: newId("prj"),
      name: input.name,
      allowedRoles: [...input.allowedRoles],
      allowedFields: uniq(input.allowedFields),
      disclosureThreshold: input.disclosureThreshold,
      retentionDays: input.retentionDays,
      expiryAction: input.expiryAction,
      withdrawalAction: input.withdrawalAction,
      identifyingFields: uniq(input.identifyingFields),
      protocolVersions: [version],
      currentProtocolVersion: version.version,
      createdAt: now,
    };
    store.state.projects.push(project);
    audit.record("project_created", {
      projectId: project.projectId,
      projectName: project.name,
      purposes: version.purposes,
      sources: version.sources,
      disclosureThreshold: project.disclosureThreshold,
      retentionDays: project.retentionDays,
    });
    return project;
  }

  /**
   * 登记新方案版本并切换当前版本。
   * 既有同意的覆盖重估由门面层在调用后执行。
   */
  addVersion(
    projectId: string,
    input: AddProtocolVersionInput,
  ): { project: Project; version: ProtocolVersion } {
    const project = findProject(this.deps.store.state, projectId);
    if (!project) {
      throw new DomainError("not_found", `项目不存在: ${projectId}`);
    }
    if (project.protocolVersions.some((version) => version.version === input.version)) {
      throw new DomainError("conflict", `方案版本已存在: ${input.version}`);
    }
    if (input.purposes.length === 0) {
      throw new DomainError("invalid", "方案版本至少声明一个研究目的");
    }
    const version: ProtocolVersion = {
      version: input.version,
      purposes: uniq(input.purposes),
      sources: uniq(input.sources),
      requiresReconsent: input.requiresReconsent,
      effectiveFrom: this.deps.clock.now().toISOString(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    project.protocolVersions.push(version);
    project.currentProtocolVersion = version.version;
    return { project, version };
  }

  get(projectId: string): Project {
    const project = findProject(this.deps.store.state, projectId);
    if (!project) {
      throw new DomainError("not_found", `项目不存在: ${projectId}`);
    }
    if (!currentProtocol(project)) {
      throw new DomainError("invalid", "项目缺少当前方案版本");
    }
    return project;
  }
}
