import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "./app.js";
import { GovernanceService } from "./domain/service.js";
import { Store } from "./domain/store.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.DATA_DIR ?? ".runtime";
const statePath = join(dataDir, "state.json");

// 生产部署必须固定 GOVERNANCE_SECRET：指纹与墓碑依赖同一密钥对账。
const secret = process.env.GOVERNANCE_SECRET ?? randomUUID();
if (!process.env.GOVERNANCE_SECRET) {
  process.stderr.write("warning: GOVERNANCE_SECRET 未设置，使用临时密钥，重启后指纹无法对账\n");
}

const store = existsSync(statePath)
  ? Store.restore(JSON.parse(readFileSync(statePath, "utf8")) as ReturnType<Store["snapshot"]>)
  : new Store();

const service = new GovernanceService({ secret, store });
const persist = (): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(service.snapshot(), null, 2));
};

createApp({ service, persist }).listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
