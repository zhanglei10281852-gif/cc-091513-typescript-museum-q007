import { createHash, createHmac, randomUUID } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * 参与定位子：对随机参与标识的密钥散列。
 * 用于审计日志、处置通知与合规证明中引用参与者，而不暴露原始标识。
 */
export function participantLocator(secret: string, participantId: string): string {
  return hmacHex(secret, `participant:${participantId}`);
}

/**
 * 按数据集重新键控的假名标识：同一参与者在不同数据集中得到不同键，
 * 防止跨数据集关联。
 */
export function exportParticipantKey(
  secret: string,
  datasetId: string,
  participantId: string,
): string {
  return hmacHex(secret, `export:${datasetId}:${participantId}`);
}
