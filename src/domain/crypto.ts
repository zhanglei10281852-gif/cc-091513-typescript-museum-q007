import { createHash, createHmac } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

/**
 * 参与标识的不可逆指纹。合规证明、出库登记、撤回墓碑只保存指纹，
 * 没有服务密钥无法反推参与标识，因此账本可安全外发。
 */
export function fingerprint(secret: string, participantId: string): string {
  return createHmac("sha256", secret).update(`participant:${participantId}`).digest("hex");
}

/** 账本 hash 链：任何篡改都会使后续哈希失效。 */
export function chainHash(previousHash: string, payload: string): string {
  return createHash("sha256").update(`${previousHash}:${payload}`).digest("hex");
}
