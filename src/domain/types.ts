/** 同意状态，与 reference/domain.json 的 consent_states 对齐。 */
export type ConsentState = "pending" | "granted" | "restricted" | "withdrawn" | "expired";

/** 数据来源，与 reference/domain.json 的 data_sources 对齐。 */
export type DataSource = "survey" | "sensor" | "observation" | "derived_dataset";

/** 保留到期后的处置动作，与 reference/domain.json 的 expiry_actions 对齐。 */
export type ExpiryAction = "delete" | "anonymize" | "review_hold";

/** 访问角色。数据保护负责人拥有审计与谱系查询的特权。 */
export type Role = "researcher" | "analyst" | "ml_engineer" | "data_protection_officer" | "system";

export type RecordStatus = "active" | "quarantined" | "deleted" | "anonymized" | "expired";

export type DatasetStatus =
  | "active"
  | "disposition_pending"
  | "purged"
  | "destroyed"
  | "anonymized"
  | "expired";

/** 撤回同意时对可定位记录的处置方式。 */
export type WithdrawalAction = "delete" | "anonymize";

/** 研究方案的一个版本；版本变化会触发既有同意的覆盖重估。 */
export interface ProtocolVersion {
  version: string;
  purposes: string[];
  sources: DataSource[];
  requiresReconsent: boolean;
  effectiveFrom: string;
  note?: string;
}

export interface Project {
  projectId: string;
  name: string;
  allowedRoles: Role[];
  allowedFields: string[];
  disclosureThreshold: number;
  retentionDays: number;
  expiryAction: ExpiryAction;
  withdrawalAction: WithdrawalAction;
  identifyingFields: string[];
  protocolVersions: ProtocolVersion[];
  currentProtocolVersion: string;
  createdAt: string;
}

export interface Consent {
  consentId: string;
  participantId: string;
  projectId: string;
  protocolVersion: string;
  purposes: string[];
  sources: DataSource[];
  state: ConsentState;
  grantedAt: string;
  validUntil: string;
  withdrawnAt?: string;
  note?: string;
}

export interface DataRecord {
  recordId: string;
  participantId: string;
  projectId: string;
  source: DataSource;
  protocolVersion: string;
  collectedAt: string;
  fields: Record<string, unknown>;
  status: RecordStatus;
  statusReason?: string;
}

export interface DatasetRow {
  participantKey?: string;
  [field: string]: unknown;
}

export interface Dataset {
  datasetId: string;
  projectId: string;
  name: string;
  purpose: string;
  protocolVersion: string;
  createdAt: string;
  createdBy: string;
  rowCount: number;
  participantCount: number;
  deliveredFields: string[];
  sourceRecordIds: string[];
  basisConsentIds: string[];
  parentDatasetId?: string;
  retentionExpiresAt: string;
  expiryAction: ExpiryAction;
  status: DatasetStatus;
  statusReason?: string;
  rows: DatasetRow[];
}

/** 数据集的下游接收方。 */
export interface Consumer {
  consumerId: string;
  datasetId: string;
  name: string;
  role: Role | "external";
  registeredAt: string;
}

/** 撤回后发给下游使用者的处置事项。 */
export interface DispositionNotice {
  noticeId: string;
  withdrawalId: string;
  datasetId: string;
  consumerId: string;
  action: "purge_participant_rows" | "destroy_dataset";
  participantLocator: string;
  issuedAt: string;
  acknowledgedAt?: string;
}

export interface Withdrawal {
  withdrawalId: string;
  participantId: string;
  projectId?: string;
  initiatedAt: string;
  completedAt?: string;
}

/**
 * 合规证明：只含计数、数据集/通知标识与密钥散列定位子，
 * 不含任何个人数据（无原始参与标识、无记录内容）。
 */
export interface ComplianceProof {
  proofId: string;
  withdrawalId: string;
  participantLocator: string;
  issuedAt: string;
  consentsWithdrawn: number;
  recordsDeleted: number;
  recordsAnonymized: number;
  datasetsAffected: string[];
  noticesIssued: string[];
  auditHash: string;
}

/** 撤回墓碑：阻止迟到的离线数据重建已撤回身份。 */
export interface Tombstone {
  participantId: string;
  projectId: string | null;
  withdrawalId: string;
  createdAt: string;
}

/** 追加式审计条目，哈希链防篡改；details 不得包含个人数据。 */
export interface AuditEntry {
  seq: number;
  at: string;
  event: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
