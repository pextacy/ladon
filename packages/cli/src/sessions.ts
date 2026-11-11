import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PATHS } from "./config.js";

/**
 * Local memory of what the human asked an agent that has no readable transcript (Cursor), so the intent
 * judge can compare it with an install. Stored only in ~/.ladon/sessions (0600), pruned after 24 h, never
 * sent anywhere except — like the Claude Code transcript — as `userRequest` to the configured intent judge.
 */

const MAX_PROMPTS = 5;
const MAX_STEPS = 12;
const TTL_MS = 24 * 3_600_000;

const Session = z.object({
  updatedAt: z.number(),
  prompts: z.array(z.object({ ts: z.number(), text: z.string() })).default([]),
  steps: z.array(z.string()).default([]),
});
type Session = z.infer<typeof Session>;

export const sessionsDir = () => join(PATHS.home, "sessions");

/** Conversation ids come from the agent: never let one pick the file path. */
export function sessionFile(conversationId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,100}$/.test(conversationId) ? conversationId : createHash("sha256").update(conversationId).digest("hex").slice(0, 40);
  return join(sessionsDir(), `${safe}.json`);
}

function read(conversationId: string, now: number): Session | null {
  try {
    const s = Session.parse(JSON.parse(readFileSync(sessionFile(conversationId), "utf8")));
    return now - s.updatedAt > TTL_MS ? null : s;
  } catch {
    return null;
  }
}

function write(conversationId: string, s: Session) {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const f = sessionFile(conversationId);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}

/** Delete session files not touched for 24 h. */
export function pruneSessions(now = Date.now()) {
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(sessionsDir(), n);
    try {
      if (now - statSync(p).mtimeMs > TTL_MS) rmSync(p, { force: true });
    } catch {
      /* raced */
    }
  }
}

/** A new human prompt: keep the last few, and start a fresh list of agent steps. */
export function recordPrompt(conversationId: string, prompt: string, now = Date.now()) {
  const text = prompt.trim().slice(0, 4000);
  if (!text) return;
  const s = read(conversationId, now) ?? { updatedAt: now, prompts: [], steps: [] };
  s.prompts = [...s.prompts, { ts: now, text }].slice(-MAX_PROMPTS);
  s.steps = [];
  s.updatedAt = now;
  write(conversationId, s);
  pruneSessions(now);
}

/** An agent step (e.g. a shell command) since the last prompt. */
export function recordStep(conversationId: string, step: string, now = Date.now()) {
  const s = read(conversationId, now);
  if (!s) return;
  s.steps = [...s.steps, step.slice(0, 200)].slice(-MAX_STEPS);
  s.updatedAt = now;
  write(conversationId, s);
}

export function sessionContext(conversationId: string, now = Date.now()): { userRequest: string; recentAgentSteps: string[] } | null {
  const s = read(conversationId, now);
  const last = s?.prompts.at(-1);
  if (!s || !last) return null;
  return { userRequest: last.text.slice(0, 2000), recentAgentSteps: s.steps.slice(-8) };
}
