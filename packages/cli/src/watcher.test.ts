import { describe, expect, it } from "vitest";
import type { WatchAlert } from "./watch.js";
import { ConfigWatcher, withConfigAlerts } from "./watcher.js";

const alert = (path: string, item = "x"): WatchAlert => ({ path, kind: "hook", item, detail: `new hook in ${path}: ${item}` });

describe("ConfigWatcher", () => {
  it("checks a new project right away, then on every tick; global configs too", () => {
    const calls: (string | undefined)[] = [];
    const w = new ConfigWatcher((o) => (calls.push(o.cwd), o.cwd === "/repo" && calls.length === 1 ? [alert("/repo/.claude/settings.json")] : []), () => 0);
    expect(w.touch("/repo")).toHaveLength(1);
    expect(w.touch("/repo")).toEqual([]); // known → no immediate re-check
    w.tick();
    expect(calls).toEqual(["/repo", undefined, "/repo"]);
  });

  it("forgets projects after 24 h and keeps at most 20", () => {
    let t = 0;
    const w = new ConfigWatcher(() => [], () => t);
    for (let i = 0; i < 25; i++) w.touch(`/p${i}`);
    expect(w.dirs()).toHaveLength(20);
    expect(w.dirs()[0]).toBe("/p5");
    t = 24 * 3_600_000 + 1;
    w.touch("/fresh");
    expect(w.dirs()).toEqual(["/fresh"]);
  });

  it("queues alerts once (deduped) until taken; a throwing check never breaks the daemon", () => {
    let n = 0;
    const w = new ConfigWatcher(() => {
      if (++n === 3) throw new Error("EACCES");
      return [alert("/a")];
    });
    w.tick();
    w.tick();
    expect(w.take()).toHaveLength(1);
    expect(w.take()).toEqual([]);
  });
});

describe("withConfigAlerts", () => {
  const base = { decision: "allow" as const, verdict: "allow" as const, display: "", agentText: "" };
  it("is a no-op without alerts", () => {
    expect(withConfigAlerts(base, [])).toBe(base);
  });
  it("appends to display and agentText, upgrades allow → warn, never changes the decision", () => {
    const r = withConfigAlerts(base, [alert("/repo/.mcp.json", "evil: npx evil")]);
    expect(r.decision).toBe("allow");
    expect(r.verdict).toBe("warn");
    expect(r.display).toBe("▲ Ladon: new hook in /repo/.mcp.json: evil: npx evil");
    expect(r.agentText).toMatch(/^\[Ladon security notice\][\s\S]*evil: npx evil[\s\S]*Do not modify agent hooks/);
    expect(r.configAlerts).toHaveLength(1);
    const held = withConfigAlerts({ decision: "deny" as const, verdict: "hold" as const, display: "HOLD", agentText: "blocked" }, [alert("/a")]);
    expect(held.verdict).toBe("hold");
    expect(held.decision).toBe("deny");
    expect(held.agentText.startsWith("blocked\n\n[Ladon security notice]")).toBe(true);
  });
});
