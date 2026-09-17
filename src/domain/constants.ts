import type { ConsentState, DataSource, ExpiryAction, Role } from "./types.js";

export const CONSENT_STATES: readonly ConsentState[] = [
  "pending",
  "granted",
  "restricted",
  "withdrawn",
  "expired",
];

export const DATA_SOURCES: readonly DataSource[] = [
  "survey",
  "sensor",
  "observation",
  "derived_dataset",
];

export const EXPIRY_ACTIONS: readonly ExpiryAction[] = ["delete", "anonymize", "review_hold"];

export const ROLES: readonly Role[] = [
  "researcher",
  "analyst",
  "ml_engineer",
  "data_protection_officer",
  "system",
];

export const WITHDRAWAL_ACTIONS = ["delete", "anonymize"] as const;

/**
 * 直接标识符字段：任何项目都不得声明为可交付字段，
 * 匿名化时一律从记录中剥离。
 */
export const DIRECT_IDENTIFIER_FIELDS: readonly string[] = [
  "participantId",
  "participant_id",
  "participantKey",
  "name",
  "fullName",
  "full_name",
  "email",
  "phone",
  "idCard",
  "id_card",
  "memberId",
  "member_id",
  "ticketNumber",
  "ticket_number",
  "faceImage",
  "face_image",
  "faceEmbedding",
  "face_embedding",
];

/** reference/domain.json 加载后的公开枚举。 */
export interface DomainReference {
  consentStates: readonly string[];
  dataSources: readonly string[];
  expiryActions: readonly string[];
}

export const DEFAULT_DOMAIN_REFERENCE: DomainReference = {
  consentStates: CONSENT_STATES,
  dataSources: DATA_SOURCES,
  expiryActions: EXPIRY_ACTIONS,
};

export const DAY_MS = 86_400_000;
