"use client";

import { useId, useRef, useState } from "react";
import { VerdictCard } from "@/app/components/VerdictCard";
import { VerdictMark } from "@/app/components/Verdict";
import type { CheckResult } from "@/lib/checker";
import { postJson } from "@/lib/client";
import { plural } from "@/lib/format";

type Verdict = "allow" | "warn" | "hold";
interface ManifestResponse {
  results: CheckResult[];
  overall: Verdict;
  kind: string;
  skipped: string[];
}

const MAX_BYTES = 200 * 1024;
const KINDS = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile"] as const;
const PLACEHOLDER: Record<(typeof KINDS)[number], string> = {
  "package.json": '{ "dependencies": { "express": "^4.19.0" } }',
  "requirements.txt": "requests==2.32.3\nflask>=3.0",
  "pyproject.toml": '[project]\ndependencies = ["requests>=2.32", "flask"]',
  Pipfile: '[packages]\nrequests = "*"\nflask = ">=3.0"',
};

/** Which manifest a picked file is, from its name; null when unsupported. */
function kindOf(name: string): (typeof KINDS)[number] | null {
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  if (base === "package.json") return "package.json";
  if (base.endsWith(".txt")) return "requirements.txt";
  if (base === "pyproject.toml") return "pyproject.toml";
  if (base === "pipfile") return "Pipfile";
  return null;
}

export function ManifestChecker() {
  const [filename, setFilename] = useState("package.json");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ManifestResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { kind: useId(), text: useId(), file: useId() };

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > MAX_BYTES) return setError("That file is larger than 200 KB.");
    const kind = kindOf(f.name);
    if (!kind) return setError("Pick a package.json, requirements.txt, pyproject.toml or Pipfile.");
    try {
      const text = await f.text();
      setFilename(kind);
      setContent(text);
      setRes(null);
    } catch {
      setError("That file could not be read. Paste its contents instead.");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (new Blob([content]).size > MAX_BYTES) {
      setRes(null);
      return setError("That manifest is larger than 200 KB.");
    }
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await postJson<ManifestResponse>("/api/check/manifest", { filename, content }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The check failed.");
    } finally {
      setBusy(false);
    }
  }

  const sorted = res ? [...res.results].sort((a, b) => b.score - a.score) : [];
  const counts = res ? { hold: res.results.filter((r) => r.verdict === "hold").length, warn: res.results.filter((r) => r.verdict === "warn").length } : null;

  return (
    <div className="mt-6">
      <form onSubmit={submit} className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor={ids.kind} className="text-sm font-medium">File type</label>
            <select id={ids.kind} value={filename} onChange={(e) => setFilename(e.target.value)} className="mt-1 block rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm">
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.file} className="text-sm font-medium">Upload</label>
            <input
              ref={fileRef}
              /* no accept filter: a Pipfile has no extension, so a filter would hide it — onFile checks the name */
              id={ids.file}
              type="file"
              onChange={(e) => onFile(e.target.files?.[0])}
              className="mt-1 block text-sm file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-bg file:px-3 file:py-1.5 file:text-fg"
            />
          </div>
        </div>
        <label htmlFor={ids.text} className="mt-4 block text-sm font-medium">Or paste it</label>
        <textarea
          id={ids.text}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={PLACEHOLDER[kindOf(filename) ?? "package.json"]}
          className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm"
        />
        <div className="mt-3 flex items-center gap-4">
          <button type="submit" disabled={busy || !content.trim()} className="rounded-md bg-fg px-6 py-2.5 font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? "Checking…" : "Check manifest"}
          </button>
          {content && (
            <button
              type="button"
              onClick={() => {
                setContent("");
                setRes(null);
                setError(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="text-sm underline"
            >
              Clear
            </button>
          )}
        </div>
      </form>

      <div aria-live="polite" className="mt-6 space-y-4">
        {busy && <p className="text-muted">Checking each dependency against the registry, OSV and the Atlas…</p>}
        {error && <p className="rounded-lg border border-warn bg-warn-bg px-5 py-4">{error}</p>}
        {res && counts && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-3">
              <VerdictMark verdict={res.overall} size="md" />
              <p>
                {plural(res.results.length, "dependency", "dependencies")} · {counts.hold} held · {counts.warn} warned
              </p>
            </div>
            {res.skipped.length > 0 && (
              <details className="text-sm text-muted">
                <summary>
                  <span className="chev mr-1" aria-hidden="true">›</span>
                  {res.skipped.length} not checked
                </summary>
                <ul className="mt-2 list-disc pl-5 font-mono [overflow-wrap:anywhere]">
                  {res.skipped.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
            {sorted.map((r) => (
              <VerdictCard key={`${r.target.ecosystem}:${r.target.name}`} r={r} compact headingLevel={3} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
