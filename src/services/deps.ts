import type { AuditLog } from "../core/audit.js";
import type { Clock } from "../core/clock.js";
import type { Store } from "../core/store.js";
import type { DomainReference } from "../domain/constants.js";

/** 各业务服务共享的依赖。 */
export interface ServiceDeps {
  store: Store;
  audit: AuditLog;
  clock: Clock;
  reference: DomainReference;
}
