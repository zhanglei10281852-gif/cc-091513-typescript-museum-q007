import { createApp } from "./app.js";
import { Store } from "./core/store.js";
import { loadDomainReference } from "./domain/reference.js";
import { GovernanceService } from "./service.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const stateFile = process.env.STATE_FILE ?? ".runtime/state.json";

const store = Store.load(stateFile);
const service = new GovernanceService({ store, reference: loadDomainReference() });
const app = createApp({
  service,
  persist: () => {
    store.save();
  },
});

app.listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
