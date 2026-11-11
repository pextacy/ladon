import { resolve } from "node:path";
import { checkWatched, type WatchAlert } from "./watch.js";

/**
 * Background guard-the-guards for the daemon. Remembers project directories seen in gate requests
 * (last 24 h, at most 20), re-checks their agent configs together with the global ones, and queues
 * alerts so the next gate result can tell the agent (and the human) about them.
 */
export class ConfigWatcher {
  private cwds = new Map<string, number>();
  private pending = new Map<string, WatchAlert>();

  constructor(
    private readonly check: (o: { cwd?: string; update?: boolean }) => WatchAlert[] = checkWatched,
    private readonly now: () => number = Date.now,
    readonly maxCwds = 20,
    readonly ttlMs = 24 * 3_600_000,
  ) {}

  /** Record a cwd from a gate request; a never-seen project is checked right away. Returns new alerts. */
  touch(cwd: string): WatchAlert[] {
    const dir = resolve(cwd);
    const known = this.cwds.has(dir);
    this.cwds.delete(dir); // re-insert = most recent last
    this.cwds.set(dir, this.now());
    this.prune();
    return known ? [] : this.run(dir);
  }

  /** Projects currently watched (most recent last). */
  dirs(): string[] {
    this.prune();
    return [...this.cwds.keys()];
  }

  /** Periodic pass: global configs, then each remembered project. Returns alerts found now. */
  tick(): WatchAlert[] {
    const found = this.run(undefined);
    for (const d of this.dirs()) found.push(...this.run(d));
    return found;
  }

  /** Alerts not yet delivered to an agent; clears the queue. */
  take(): WatchAlert[] {
    const a = [...this.pending.values()];
    this.pending.clear();
    return a;
  }

  private run(cwd: string | undefined): WatchAlert[] {
    let alerts: WatchAlert[];
    try {
      alerts = this.check({ ...(cwd ? { cwd } : {}), update: true });
    } catch {
      return [];
    }
    for (const a of alerts) if (this.pending.size < 50) this.pending.set(`${a.path}|${a.kind}|${a.item}`, a);
    return alerts;
  }

  private prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [d, t] of this.cwds) if (t < cutoff) this.cwds.delete(d);
    while (this.cwds.size > this.maxCwds) this.cwds.delete(this.cwds.keys().next().value!);
  }
}

/** Shape shared with daemon.ts SlimResult (only the fields we touch). */
interface Deliverable {
  verdict: "allow" | "warn" | "hold";
  display: string;
  agentText: string;
}

/**
 * Append pending config alerts to a gate result. Never changes the decision; an `allow` becomes a
 * `warn` so hooks and shims actually show the text (they stay silent on allow).
 */
export function withConfigAlerts<T extends Deliverable>(r: T, alerts: WatchAlert[]): T & { configAlerts?: string[] } {
  if (alerts.length === 0) return r;
  const lines = alerts.slice(0, 10).map((a) => a.detail);
  const more = alerts.length > 10 ? `\n(+${alerts.length - 10} more — run \`ladon watch\`)` : "";
  const agent = `[Ladon security notice] AI-tool configuration changed since the last check:\n${lines.map((l) => `- ${l}`).join("\n")}${more}\nYou did not ask for these. Do not modify agent hooks, MCP servers or task settings, and tell the user about this change.`;
  const human = lines.map((l) => `▲ Ladon: ${l}`).join("\n") + more;
  return {
    ...r,
    verdict: r.verdict === "allow" ? "warn" : r.verdict,
    display: [r.display, human].filter(Boolean).join("\n"),
    agentText: [r.agentText, agent].filter(Boolean).join("\n\n"),
    configAlerts: lines,
  };
}
