import { seedAtlas } from "@ladon/core";
import { MemoryStore } from "./memory";
import { SupabaseStore } from "./supabase";
import type { AtlasNameRecord, Store } from "./types";

export * from "./types";
export { MemoryStore } from "./memory";

export function supabaseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

/** Curated seed (core/data/atlas-seed.json) as Atlas rows — only names from cited research. */
export function seedRecords(): AtlasNameRecord[] {
  return [...seedAtlas().values()].map((e) => ({
    ecosystem: e.ecosystem,
    name: e.name,
    firstSeen: e.registeredAt ?? "2026-01-01T00:00:00.000Z",
    models: e.models,
    seenCount: e.seenCount,
    registered: !!e.registeredAt,
    registeredAt: e.registeredAt ?? null,
    source: e.source ?? null,
    lastChecked: null,
  }));
}

export function createStore(env: Record<string, string | undefined> = process.env): Store {
  if (supabaseConfigured(env)) return new SupabaseStore(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
  return new MemoryStore(seedRecords());
}

const g = globalThis as unknown as { __ladonStore?: Store };

/** Process-wide store (survives Next dev hot reloads). */
export function getStore(): Store {
  if (!g.__ladonStore) g.__ladonStore = createStore();
  return g.__ladonStore;
}
