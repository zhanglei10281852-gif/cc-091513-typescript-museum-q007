import type { AuditEntry } from "../domain/types.js";
import type { Clock } from "./clock.js";
import { sha256Hex } from "./crypto.js";

const GENESIS = "GENESIS";

/**
 * 审计详情中禁止出现的键：凡是可能承载个人数据的字段
 * （原始参与标识、记录内容、导出行）都不得写入审计日志。
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "participantId",
  "participant_id",
  "participantKey",
  "fields",
  "rows",
  "payload",
]);

/** 追加式哈希链审计日志。条目只含事件元数据，不含个人数据。 */
export class AuditLog {
  readonly #entries: AuditEntry[];
  readonly #clock: Clock;

  constructor(entries: AuditEntry[], clock: Clock) {
    this.#entries = entries;
    this.#clock = clock;
  }

  get all(): readonly AuditEntry[] {
    return this.#entries;
  }

  get headHash(): string {
    const last = this.#entries.at(-1);
    return last ? last.hash : GENESIS;
  }

  record(event: string, details: Record<string, unknown> = {}): AuditEntry {
    assertAuditSafe(details);
    const prevHash = this.headHash;
    const seq = this.#entries.length;
    const at = this.#clock.now().toISOString();
    const hash = sha256Hex(stableStringify({ seq, at, event, details, prevHash }));
    const entry: AuditEntry = { seq, at, event, details, prevHash, hash };
    this.#entries.push(entry);
    return entry;
  }

  verify(): { valid: boolean; entries: number; firstFailure?: number } {
    let prev = GENESIS;
    for (const entry of this.#entries) {
      const expected = sha256Hex(
        stableStringify({
          seq: entry.seq,
          at: entry.at,
          event: entry.event,
          details: entry.details,
          prevHash: entry.prevHash,
        }),
      );
      if (entry.prevHash !== prev || entry.hash !== expected) {
        return { valid: false, entries: this.#entries.length, firstFailure: entry.seq };
      }
      prev = entry.hash;
    }
    return { valid: true, entries: this.#entries.length };
  }
}

function assertAuditSafe(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAuditSafe(item, `${path}[${index}].`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_KEYS.has(key)) {
        throw new Error(`审计日志不得包含个人数据字段: ${path}${key}`);
      }
      assertAuditSafe(nested, `${path}${key}.`);
    }
  }
}

/** 键排序后的确定性序列化，保证哈希可重放验证。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
  }
  return value;
}
