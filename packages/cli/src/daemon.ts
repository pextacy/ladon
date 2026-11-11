import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LADON_VERSION } from "@ladon/core";
import { DAEMON_PORT, daemonToken, loadConfig, PATHS } from "./config.js";
import { gate, type GateResult } from "./gate.js";
import { gateEnv, loadLadonEnv, notify, sharedKeyBridge } from "./runtime.js";
import { ConfigWatcher, withConfigAlerts } from "./watcher.js";

const GateBody = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(4096),
  transcriptPath: z.string().max(4096).optional(),
  userRequest: z.string().max(4000).optional(),
  recentAgentSteps: z.array(z.string().max(400)).max(20).optional(),
  agent: z.string().max(40).optional(),
});

export function slimResult(r: GateResult) {
  return {
    decision: r.decision,
    verdict: r.verdict,
    outcome: r.outcome,
    display: r.display,
    agentText: r.agentText,
    durationMs: r.durationMs,
    approval: r.approval,
    ...(r.notice ? { notice: r.notice } : {}),
    reports: r.reports.map((x) => ({ target: x.target, version: x.version, verdict: x.verdict, score: x.score, hits: x.hits, fastPath: x.fastPath })),
  };
}
export type SlimResult = ReturnType<typeof slimResult>;

function log(msg: string) {
  try {
    appendFileSync(PATHS.daemonLog, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** One approval at a time: the Key can only show one request. */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

export async function runDaemon(port = DAEMON_PORT) {
  loadLadonEnv();
  const token = daemonToken();
  const tok = Buffer.from(token);
  const env = { ...(await gateEnv()), approvalLock: serialized };
  const watcher = new ConfigWatcher();
  const announce = (alerts: { detail: string }[]) => {
    for (const a of alerts) {
      log(`watch: ${a.detail}`);
      notify("Ladon — AI tool config changed", a.detail);
    }
  };

  const server = createServer(async (req, res) => {
    // Only same-machine tools with the token file may call us; browsers can't (no CORS, token required).
    if (req.headers.origin) return send(res, 403, { error: "no browser access" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      const cfg = loadConfig();
      return send(res, 200, { ok: true, version: LADON_VERSION, pid: process.pid, key: !!cfg.key, passkeys: cfg.passkeys.length, ai: !!env.intent });
    }
    const given = Buffer.from(String(req.headers["x-ladon-token"] ?? ""));
    if (given.length !== tok.length || !timingSafeEqual(given, tok)) return send(res, 401, { error: "bad token" });

    if (req.method === "POST" && url.pathname === "/gate") {
      let body;
      try {
        body = GateBody.parse(await readBody(req));
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
      }
      const input = {
        command: body.command,
        cwd: body.cwd,
        ...(body.transcriptPath ? { transcriptPath: body.transcriptPath } : {}),
        ...(body.userRequest ? { userRequest: body.userRequest } : {}),
        ...(body.recentAgentSteps ? { recentAgentSteps: body.recentAgentSteps } : {}),
        ...(body.agent ? { agent: body.agent } : {}),
        onStatus: (m: string) => log(m.replace(/\x1b\[[0-9;]*m/g, "")),
      };
      try {
        // Verdicts run concurrently; only approvals are serialized (env.approvalLock).
        const r = await gate({ ...input, onStatus: (m) => {
          input.onStatus(m);
          if (m.includes("HOLD")) notify("Ladon — install held", m.split("\n")[0]!.replace(/\x1b\[[0-9;]*m/g, ""));
        } }, env);
        log(`${r.decision} ${r.verdict} ${r.outcome} ${body.command.slice(0, 200)}`);
        // guard-the-guards: remember this project, check it if new, and hand pending config alerts to the agent
        announce(watcher.touch(body.cwd));
        return send(res, 200, withConfigAlerts(slimResult(r), watcher.take()));
      } catch (e) {
        log(`error ${e instanceof Error ? e.stack : String(e)}`);
        return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    send(res, 404, { error: "not found" });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  log(`daemon ${LADON_VERSION} listening on 127.0.0.1:${port} (pid ${process.pid}, ai ${env.intent ? "on" : "off"})`);

  // guard-the-guards: re-check global + recently used project agent configs every 30 s
  const watchTimer = setInterval(() => announce(watcher.tick()), 30_000);
  watchTimer.unref();

  const shutdown = async () => {
    await sharedKeyBridge().close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
