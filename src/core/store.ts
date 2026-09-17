import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  AuditEntry,
  ComplianceProof,
  Consent,
  Consumer,
  DataRecord,
  Dataset,
  DispositionNotice,
  Project,
  Tombstone,
  Withdrawal,
} from "../domain/types.js";

export interface GovernanceState {
  /** 服务级密钥：用于参与定位子与导出假名键的 HMAC。 */
  secret: string;
  projects: Project[];
  consents: Consent[];
  records: DataRecord[];
  datasets: Dataset[];
  consumers: Consumer[];
  notices: DispositionNotice[];
  withdrawals: Withdrawal[];
  proofs: ComplianceProof[];
  tombstones: Tombstone[];
  audit: AuditEntry[];
}

export function emptyState(): GovernanceState {
  return {
    secret: randomBytes(32).toString("hex"),
    projects: [],
    consents: [],
    records: [],
    datasets: [],
    consumers: [],
    notices: [],
    withdrawals: [],
    proofs: [],
    tombstones: [],
    audit: [],
  };
}

/**
 * 内存状态 + 可选 JSON 快照持久化（写入 .runtime/）。
 * 快照包含密钥与撤回墓碑，保证重启后迟到数据仍无法重建已撤回身份。
 */
export class Store {
  readonly state: GovernanceState;
  readonly #path: string | undefined;

  constructor(state?: GovernanceState, path?: string) {
    this.state = state ?? emptyState();
    this.#path = path;
  }

  static load(path: string): Store {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GovernanceState>;
      return new Store({ ...emptyState(), ...parsed }, path);
    }
    return new Store(emptyState(), path);
  }

  save(): void {
    if (this.#path === undefined) {
      return;
    }
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.#path);
  }
}
