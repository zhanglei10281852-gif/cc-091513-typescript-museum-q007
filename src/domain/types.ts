/**
 * 领域类型定义。
 *
 * 枚举取值与 reference/domain.json 保持一致（由 tests/reference-sync.test.ts 守护）。
 */

export const CONSENT_STATES = ["pending", "granted", "restricted", "withdrawn", "expired"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const DATA_SOURCES = ["survey", "sensor", "observation", "derived_dataset"] as const;
export type DataSourceType = (typeof DATA_SOURCES)[number];

export const EXPIRY_ACTIONS = ["delete", "anonymize", "review_hold"] as const;
export type ExpiryAction = (typeof EXPIRY_ACTIONS)[number];

/**
 * 随机参与标识：采集侧为每次研究参与生成的伪匿名主键。
 * 业务记录只允许引用该标识，禁止姓名、证件号、邮箱等直接标识符。
 */
export const PARTICIPANT_ID_PATTERN = /^pt_[a-z0-9]{12,}$/;

export function isValidParticipantId(value: string): boolean {
  return PARTICIPANT_ID_PATTERN.test(value);
}

/** 研究方案（按版本注册，版本只增不减）。 */
export interface ResearchProtocol {
  projectId: string;
  version: number;
  /** 本版本允许的研究目的，如 flow_analysis。 */
  purposes: string[];
  /** 本版本允许使用的数据来源。 */
  allowedSources: DataSourceType[];
  /** 目的 -> 允许出库字段 的最小化策略。 */
  fieldPolicy: Record<string, string[]>;
  /** 可访问角色。 */
  allowedRoles: string[];
  /** 披露阈值：去重参与者低于该值拒绝出库。 */
  disclosureThreshold: number;
  retentionDays: number;
  registeredAt: string;
}

/** 同意记录：某参与标识对某项目若干方案版本、若干目的的授权。 */
export interface ConsentRecord {
  projectId: string;
  participantId: string;
  source: DataSourceType;
  state: ConsentState;
  purposes: string[];
  /** 同意书覆盖的方案版本；版本升级后需重新判断是否覆盖。 */
  protocolVersions: number[];
  /** state 为 restricted 时允许出库的字段白名单。 */
  restrictedFields: string[];
  grantedAt: string;
  withdrawnAt: string | null;
  retentionUntil: string;
}

/** 可定位的业务记录（匿名化后 participantId 置空，不再可定位）。 */
export interface DataRecord {
  recordId: string;
  participantId: string | null;
  datasetId: string;
  source: DataSourceType;
  fields: Record<string, unknown>;
  collectedAt: string;
  retentionUntil: string;
  anonymized: boolean;
  /** review_hold 到期动作：保留但隔离，禁止出库。 */
  held: boolean;
}

export interface Dataset {
  datasetId: string;
  projectId: string;
  /** 生成该数据集时使用的方案版本（谱系证据）。 */
  protocolVersion: number;
  sources: DataSourceType[];
  /** 上游数据集（派生数据集的合法来源链）。 */
  upstreamDatasetIds: string[];
  /** 到期动作：删除 / 不可逆匿名化 / 复核隔离。 */
  expiryAction: ExpiryAction;
  retentionUntil: string;
  createdAt: string;
  expiredAt: string | null;
}

export type DisposalStatus = "active" | "disposal_requested" | "disposed";

/** 出库登记：谱系中追溯下游去向的依据。 */
export interface ExportRecord {
  exportId: string;
  datasetId: string;
  projectId: string;
  protocolVersion: number;
  purpose: string;
  role: string;
  consumerId: string;
  fields: string[];
  rowCount: number;
  participantCount: number;
  /** HMAC 指纹，用于撤回/到期时定位下游副本；不含个人数据。 */
  participantFingerprints: string[];
  createdAt: string;
  disposalStatus: DisposalStatus;
}

/** 下游处置事项：撤回或到期时派发给数据使用方。 */
export interface DisposalTask {
  taskId: string;
  exportId: string;
  consumerId: string;
  reason: "consent_withdrawn" | "retention_expired";
  status: "pending" | "completed";
  createdAt: string;
  completedAt: string | null;
}

export type LedgerKind = "audit" | "proof";

/**
 * 合规账本条目（hash 链）。proof 类条目即可对外出示的合规证明：
 * 只含 HMAC 指纹与计数，不含任何个人数据。
 */
export interface LedgerEntry {
  entryId: string;
  kind: LedgerKind;
  eventType: string;
  subjectFingerprint: string | null;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
  createdAt: string;
}

export type DenialCode =
  | "project_unknown"
  | "dataset_unknown"
  | "role_not_permitted"
  | "purpose_not_permitted"
  | "source_not_permitted"
  | "retention_expired"
  | "no_deliverable_fields"
  | "below_disclosure_threshold";

export interface DenialReason {
  code: DenialCode;
  message: string;
}

export interface ExportRequest {
  datasetId: string;
  projectId: string;
  purpose: string;
  role: string;
  consumerId: string;
  /** null 表示申请方未指定，按方案策略交付允许的最小字段集。 */
  requestedFields: string[] | null;
}

export interface ExportDecision {
  allowed: boolean;
  denials: DenialReason[];
  /** 实际交付字段 = 申请字段 ∩ 方案允许字段 − 全局禁止字段。 */
  minimizedFields: string[];
  /** 申请但被策略剔除的字段。 */
  droppedFields: string[];
  eligibleRecords: number;
  eligibleParticipants: number;
  disclosureThreshold: number | null;
  protocolVersion: number | null;
}
