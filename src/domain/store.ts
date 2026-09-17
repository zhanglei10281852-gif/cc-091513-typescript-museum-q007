import type {
  ConsentRecord,
  DataRecord,
  Dataset,
  DisposalTask,
  ExportRecord,
  LedgerEntry,
  ResearchProtocol,
} from "./types.js";

export function consentKey(projectId: string, participantId: string): string {
  return `${projectId}#${participantId}`;
}

interface StoreSnapshot {
  protocols: Array<[string, ResearchProtocol[]]>;
  consents: Array<[string, ConsentRecord]>;
  records: Array<[string, DataRecord]>;
  datasets: Array<[string, Dataset]>;
  exports: Array<[string, ExportRecord]>;
  disposalTasks: Array<[string, DisposalTask]>;
  tombstones: string[];
  ledger: LedgerEntry[];
}

/**
 * 内存存储。生产部署通过 snapshot()/restore() 把状态落入 .runtime/，
 * 更换实现（如 Postgres）时只需保持本类的读写契约。
 */
export class Store {
  readonly protocols = new Map<string, ResearchProtocol[]>();
  readonly consents = new Map<string, ConsentRecord>();
  readonly records = new Map<string, DataRecord>();
  readonly datasets = new Map<string, Dataset>();
  readonly exports = new Map<string, ExportRecord>();
  readonly disposalTasks = new Map<string, DisposalTask>();
  /** 已撤回身份的指纹墓碑：迟到补传命中即丢弃，身份不可重建。 */
  readonly tombstones = new Set<string>();
  readonly ledger: LedgerEntry[] = [];

  currentProtocol(projectId: string): ResearchProtocol | null {
    const versions = this.protocols.get(projectId);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1] ?? null;
  }

  recordsOfDataset(datasetId: string): DataRecord[] {
    const out: DataRecord[] = [];
    for (const record of this.records.values()) {
      if (record.datasetId === datasetId) out.push(record);
    }
    return out;
  }

  exportsOfDataset(datasetId: string): ExportRecord[] {
    const out: ExportRecord[] = [];
    for (const exportRecord of this.exports.values()) {
      if (exportRecord.datasetId === datasetId) out.push(exportRecord);
    }
    return out;
  }

  snapshot(): StoreSnapshot {
    return {
      protocols: [...this.protocols.entries()],
      consents: [...this.consents.entries()],
      records: [...this.records.entries()],
      datasets: [...this.datasets.entries()],
      exports: [...this.exports.entries()],
      disposalTasks: [...this.disposalTasks.entries()],
      tombstones: [...this.tombstones],
      ledger: [...this.ledger],
    };
  }

  static restore(snapshot: StoreSnapshot): Store {
    const store = new Store();
    for (const [key, value] of snapshot.protocols) store.protocols.set(key, value);
    for (const [key, value] of snapshot.consents) store.consents.set(key, value);
    for (const [key, value] of snapshot.records) store.records.set(key, value);
    for (const [key, value] of snapshot.datasets) store.datasets.set(key, value);
    for (const [key, value] of snapshot.exports) store.exports.set(key, value);
    for (const [key, value] of snapshot.disposalTasks) store.disposalTasks.set(key, value);
    for (const value of snapshot.tombstones) store.tombstones.add(value);
    store.ledger.push(...snapshot.ledger);
    return store;
  }
}
