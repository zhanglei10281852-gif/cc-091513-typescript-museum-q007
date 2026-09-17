import { AuditLog } from "./core/audit.js";
import { SystemClock, type Clock } from "./core/clock.js";
import { participantLocator } from "./core/crypto.js";
import { Store, emptyState } from "./core/store.js";
import { DEFAULT_DOMAIN_REFERENCE, type DomainReference } from "./domain/constants.js";
import type {
  AuditEntry,
  ComplianceProof,
  Consent,
  Consumer,
  DataRecord,
  Dataset,
  DataSource,
  DispositionNotice,
  Project,
} from "./domain/types.js";
import { DomainError } from "./core/errors.js";
import type { ServiceDeps } from "./services/deps.js";
import {
  ConsentService,
  type GrantConsentInput,
} from "./services/consents.js";
import {
  ExportService,
  type DeriveDecision,
  type DeriveInput,
  type ExportDecision,
  type ExportRequest,
  type RegisterConsumerInput,
} from "./services/exports.js";
import { buildDatasetLineage, type DatasetLineage } from "./services/lineage.js";
import {
  ProjectService,
  type AddProtocolVersionInput,
  type CreateProjectInput,
} from "./services/projects.js";
import {
  RecordService,
  type IngestRecordInput,
  type IngestResult,
  type RetentionSweepResult,
} from "./services/records.js";
import {
  WithdrawalService,
  type WithdrawInput,
  type WithdrawResult,
} from "./services/withdrawals.js";

export interface GovernanceServiceOptions {
  store?: Store;
  clock?: Clock;
  reference?: DomainReference;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  currentProtocolVersion: string;
  purposes: string[];
  sources: DataSource[];
}

export interface BatchIngestItem {
  participantId: string;
  collectedAt?: string;
  fields?: Record<string, unknown>;
}

/**
 * 门面：组合各业务服务，并编排跨服务动作
 * （同意登记后的隔离激活与墓碑解除、方案版本后的同意重估）。
 */
export class GovernanceService {
  readonly store: Store;
  readonly clock: Clock;
  readonly reference: DomainReference;
  readonly audit: AuditLog;

  private readonly projects: ProjectService;
  private readonly consents: ConsentService;
  private readonly records: RecordService;
  private readonly exports: ExportService;
  private readonly withdrawals: WithdrawalService;

  constructor(options: GovernanceServiceOptions = {}) {
    this.store = options.store ?? new Store(emptyState());
    this.clock = options.clock ?? new SystemClock();
    this.reference = options.reference ?? DEFAULT_DOMAIN_REFERENCE;
    this.audit = new AuditLog(this.store.state.audit, this.clock);
    const deps: ServiceDeps = {
      store: this.store,
      audit: this.audit,
      clock: this.clock,
      reference: this.reference,
    };
    this.projects = new ProjectService(deps);
    this.consents = new ConsentService(deps);
    this.records = new RecordService(deps);
    this.exports = new ExportService(deps);
    this.withdrawals = new WithdrawalService(deps);
  }

  // ---- 项目与方案版本 ----

  createProject(input: CreateProjectInput): Project {
    return this.projects.create(input);
  }

  getProject(projectId: string): Project {
    return this.projects.get(projectId);
  }

  listProjects(): ProjectSummary[] {
    return this.store.state.projects.map((project) => {
      const protocol = project.protocolVersions.find(
        (version) => version.version === project.currentProtocolVersion,
      );
      return {
        projectId: project.projectId,
        name: project.name,
        currentProtocolVersion: project.currentProtocolVersion,
        purposes: protocol?.purposes ?? [],
        sources: protocol?.sources ?? [],
      };
    });
  }

  addProtocolVersion(
    projectId: string,
    input: AddProtocolVersionInput,
  ): { project: Project; version: string; carried: number; restricted: number } {
    const { project, version } = this.projects.addVersion(projectId, input);
    const outcome = this.consents.reevaluateForProtocol(project, version);
    this.audit.record("protocol_version_added", {
      projectId: project.projectId,
      version: version.version,
      requiresReconsent: version.requiresReconsent,
      consentsCarried: outcome.carried,
      consentsRestricted: outcome.restricted,
    });
    return { project, version: version.version, ...outcome };
  }

  // ---- 同意 ----

  grantConsent(input: GrantConsentInput): Consent {
    const consent = this.consents.grant(input);
    const lifted = this.consents.liftTombstones(input.participantId, input.projectId);
    if (lifted > 0) {
      this.audit.record("tombstone_lifted", {
        projectId: input.projectId,
        participantLocator: participantLocator(this.store.state.secret, input.participantId),
        lifted,
      });
    }
    const activated = this.records.activateQuarantined(input.participantId, input.projectId);
    if (activated > 0) {
      this.audit.record("records_activated", {
        projectId: input.projectId,
        count: activated,
      });
    }
    return consent;
  }

  findConsents(participantId: string): Consent[] {
    return this.store.state.consents.filter(
      (consent) => consent.participantId === participantId,
    );
  }

  // ---- 采集与补传 ----

  ingestRecord(projectId: string, input: IngestRecordInput): IngestResult {
    return this.records.ingest(projectId, input);
  }

  ingestBatch(
    projectId: string,
    source: DataSource,
    items: BatchIngestItem[],
  ): Array<IngestResult & { index: number }> {
    return items.map((item, index) => ({
      index,
      ...this.records.ingest(projectId, { ...item, source }),
    }));
  }

  findRecords(participantId: string): DataRecord[] {
    return this.store.state.records.filter((record) => record.participantId === participantId);
  }

  // ---- 导出 ----

  requestExport(request: ExportRequest): ExportDecision {
    return this.exports.requestExport(request);
  }

  getDataset(datasetId: string): Dataset {
    const dataset = this.store.state.datasets.find((entry) => entry.datasetId === datasetId);
    if (!dataset) {
      throw new DomainError("not_found", `数据集不存在: ${datasetId}`);
    }
    return dataset;
  }

  registerConsumer(datasetId: string, input: RegisterConsumerInput): Consumer {
    return this.exports.registerConsumer(datasetId, input);
  }

  deriveDataset(datasetId: string, input: DeriveInput, actor: string): DeriveDecision {
    return this.exports.deriveDataset(datasetId, input, actor);
  }

  getDatasetLineage(datasetId: string): DatasetLineage {
    return buildDatasetLineage(this.store.state, datasetId);
  }

  // ---- 撤回 ----

  withdraw(input: WithdrawInput): WithdrawResult {
    return this.withdrawals.withdraw(input);
  }

  getWithdrawalProof(withdrawalId: string): ComplianceProof {
    return this.withdrawals.getProof(withdrawalId);
  }

  acknowledgeNotice(noticeId: string, consumerId: string): DispositionNotice {
    return this.withdrawals.acknowledgeNotice(noticeId, consumerId);
  }

  listNotices(): DispositionNotice[] {
    return [...this.store.state.notices];
  }

  // ---- 保留期限与审计 ----

  runRetentionSweep(): RetentionSweepResult {
    return this.records.retentionSweep();
  }

  auditTrail(limit = 200): AuditEntry[] {
    return this.audit.all.slice(-limit);
  }

  verifyAudit(): { valid: boolean; entries: number; firstFailure?: number } {
    return this.audit.verify();
  }
}
