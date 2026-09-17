import { createServer, type Server } from "node:http";

import { createRequestHandler } from "./http.js";
import { GovernanceService } from "./service.js";

export const serviceName = "观众研究隐私治理服务";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export interface AppDeps {
  service?: GovernanceService;
  persist?: () => void;
}

export function createApp(deps: AppDeps = {}): Server {
  const service = deps.service ?? new GovernanceService();
  const persist = deps.persist ?? null;
  const handle = createRequestHandler(service, persist, healthPayload);
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  });
}
