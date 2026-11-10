import { KeyHello, KeyRequest, KeyResponse, verifyKeyResponse } from "@ladon/core";
import { loadConfig, loadState, saveState } from "../config.js";
import { listKeyPorts, openSerial, type SerialLink } from "./serial.js";
import type { ApprovalOutcome, Approver, PendingApproval } from "./types.js";

type Opener = () => Promise<SerialLink>;

/** Find the configured / attached Key and open it. */
export const defaultOpener: Opener = async () => {
  const cfg = loadConfig();
  const path = process.env.LADON_KEY_PORT ?? cfg.key?.path ?? (await listKeyPorts())[0]?.path;
  if (!path) throw new Error("no Ladon Key connected");
  return openSerial(path);
};

function waitFor<T>(link: SerialLink, match: (msg: unknown) => T | undefined, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      off();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(new Error("aborted")));
    const off = link.onLine((line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // firmware debug output
      }
      const m = match(msg);
      if (m !== undefined) done(() => resolve(m));
      else if (typeof msg === "object" && msg && (msg as { t?: string }).t === "err") done(() => reject(new Error(`Key error: ${String((msg as { msg?: unknown }).msg)}`)));
    });
    const timer = setTimeout(() => done(() => reject(new Error("Key did not answer"))), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function keyHello(link: SerialLink): Promise<KeyHello> {
  const p = waitFor(link, (m) => {
    const r = KeyHello.safeParse(m);
    return r.success ? r.data : undefined;
  }, 3000);
  await link.write(JSON.stringify({ t: "hello" }));
  return p;
}

/**
 * The daemon owns one serial connection. A request shows on the Key's screen; only a physical
 * hold-to-approve produces a signature that verifies against the paired public key.
 */
export class KeyBridge implements Approver {
  readonly via = "key" as const;
  private link: SerialLink | null = null;
  constructor(private readonly open: Opener = defaultOpener) {}

  private async connect(): Promise<SerialLink> {
    if (this.link) return this.link;
    this.link = await this.open();
    return this.link;
  }

  async close() {
    await this.link?.close().catch(() => {});
    this.link = null;
  }

  async ready() {
    const cfg = loadConfig();
    if (!cfg.key) return { ok: false, detail: "no Ladon Key paired (ladon key pair)" };
    try {
      const link = await this.connect();
      const hello = await keyHello(link);
      if (hello.pk !== cfg.key.publicKey) return { ok: false, detail: "connected Key is not the paired one" };
      return { ok: true, detail: `Ladon Key on ${link.path}` };
    } catch (e) {
      await this.close();
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async request(req: PendingApproval, signal: AbortSignal, onStatus?: (m: string) => void): Promise<ApprovalOutcome> {
    const cfg = loadConfig();
    if (!cfg.key) return { kind: "unavailable", detail: "no Ladon Key paired" };
    let link: SerialLink;
    try {
      link = await this.connect();
    } catch (e) {
      return { kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
    }
    const msg = KeyRequest.parse({ t: "req", id: req.id, pkg: req.pkg.slice(0, 240), score: req.score, why: req.why.slice(0, 3).map((w) => w.slice(0, 120)), h: req.h, n: req.n, exp: req.exp });
    const ms = Math.max(1000, req.exp * 1000 - Date.now() + 5000);
    const resP = waitFor(link, (m) => {
      const r = KeyResponse.safeParse(m);
      return r.success && r.data.id === req.id ? r.data : undefined;
    }, ms, signal);
    try {
      await link.write(JSON.stringify({ t: "time", now: Math.floor(Date.now() / 1000) }));
      await link.write(JSON.stringify(msg));
    } catch (e) {
      await this.close();
      return { kind: "unavailable", detail: `cannot talk to Key: ${e instanceof Error ? e.message : String(e)}` };
    }
    onStatus?.("waiting for the Ladon Key");
    let res: KeyResponse;
    try {
      res = await resP;
    } catch (e) {
      await link.write(JSON.stringify({ t: "cancel", id: req.id })).catch(() => {});
      if (signal.aborted) return { kind: "timeout", detail: "cancelled" };
      return { kind: "timeout", detail: e instanceof Error ? e.message : String(e) };
    }
    const state = loadState();
    const v = verifyKeyResponse(req, res, { publicKeyHex: cfg.key.publicKey, lastCounter: state.keyCounter, usedNonces: new Set(state.usedNonces) });
    if (!v.ok) return { kind: "rejected", via: "key", detail: v.error }; // unverifiable ⇒ never an approval
    state.keyCounter = v.ctr;
    state.usedNonces.push(req.n);
    saveState(state);
    if (res.reason === "timeout") return { kind: "timeout", detail: "no press on the Ladon Key in time" };
    return v.approved ? { kind: "approved", via: "key", detail: "approved on Ladon Key" } : { kind: "rejected", via: "key", detail: "rejected on Ladon Key" };
  }
}
