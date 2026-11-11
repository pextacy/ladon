/**
 * Minimal POSIX-ish shell tokenizer: enough to find package-manager invocations inside the
 * commands coding agents run ("cd web && npm i foo", "bash -c 'pip install x'", "FOO=1 npx bar",
 * "echo $(npm i x)"). It never executes or expands anything.
 *
 * Words that would be expanded by the shell (`$VAR`, `$(…)`, backticks, `{a,b}`) are kept verbatim
 * so callers can recognise them as dynamic; the *contents* of command substitutions are parsed as
 * commands of their own, because the shell runs them.
 */

export type Segment = string[];

export interface EffectiveCommand {
  words: string[];
  /** extra arguments are appended at run time from stdin (xargs) — they cannot be known statically */
  stdinArgs: boolean;
  /** environment assignments visible to the command (prefix assignments, `env X=1`, earlier `export`) */
  env: Record<string, string>;
}

interface Tokenized {
  segments: Segment[];
  /** scripts inside $(…), `…`, <(…), >(…) — run by the shell */
  subs: string[];
  /** here-document bodies (data — unless a shell reads them as its script: `bash <<EOF`) */
  heredocBodies: string[];
}

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];
const MAX_DEPTH = 10;

interface Heredoc {
  delim: string;
  /** `<<-`: leading tabs are stripped from body lines and the delimiter line */
  strip: boolean;
  /** any part of the delimiter was quoted: the body is literal (no `$(…)` / backticks run) */
  quoted: boolean;
}

/**
 * The delimiter word after `<<` / `<<-` (at `j`). Quotes/backslashes are removed and mark the body as
 * literal, like bash. Returns null when no word follows (a syntax error — treated as a plain redirection).
 */
function readHeredocDelim(input: string, j: number): { delim: string; quoted: boolean; end: number } | null {
  while (input[j] === " " || input[j] === "\t") j++;
  let delim = "";
  let quoted = false;
  while (j < input.length && !/[\s;&|<>()]/.test(input[j]!)) {
    const c = input[j]!;
    if (c === "'" || c === '"') {
      quoted = true;
      const e = input.indexOf(c, j + 1);
      const stop = e === -1 ? input.length : e;
      delim += input.slice(j + 1, stop);
      j = stop + 1;
      continue;
    }
    if (c === "\\" && j + 1 < input.length) {
      quoted = true;
      delim += input[j + 1];
      j += 2;
      continue;
    }
    delim += c;
    j++;
  }
  // `1<<2` inside `(( … ))` is a shift, not a here-document; nobody names a delimiter with digits only
  return delim === "" || (!quoted && /^\d+$/.test(delim)) ? null : { delim, quoted, end: j };
}

/**
 * Skip the bodies of pending here-documents, starting at `i` (just after the newline that ends the
 * command line). The body is data, not commands — but an unquoted body still runs its `$(…)` and
 * backticks, so those are collected into `subs`. Returns the index after the last terminator line.
 */
function skipHeredocs(input: string, i: number, pending: Heredoc[], subs?: string[], bodies?: string[]): number {
  for (const h of pending) {
    const bodyStart = i;
    let bodyEnd = input.length;
    while (i < input.length) {
      const nl = input.indexOf("\n", i);
      const lineEnd = nl === -1 ? input.length : nl;
      const line = input.slice(i, lineEnd);
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
        bodyEnd = i;
        i = nl === -1 ? input.length : nl + 1;
        break;
      }
      i = nl === -1 ? input.length : nl + 1;
    }
    const body = input.slice(bodyStart, bodyEnd);
    bodies?.push(body);
    if (!h.quoted && subs) collectSubs(body, subs, false);
  }
  return i;
}

/** `$(…)` / backtick bodies inside literal-ish text (here-doc body, array literal) — the shell runs them. */
function collectSubs(text: string, subs: string[], singleQuotes: boolean) {
  let k = 0;
  while (k < text.length) {
    const c = text[k]!;
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (singleQuotes && c === "'") {
      const e = text.indexOf("'", k + 1);
      k = e === -1 ? text.length : e + 1;
      continue;
    }
    if (c === "$" && text[k + 1] === "(") {
      const end = closeParen(text, k + 2);
      subs.push(text.slice(k + 2, end));
      k = end + 1;
      continue;
    }
    if (c === "`") {
      const end = closeBacktick(text, k + 1);
      subs.push(text.slice(k + 1, end).replace(/\\([`$\\])/g, "$1"));
      k = end + 1;
      continue;
    }
    k++;
  }
}

/** Index of the `)` closing a `$(` / `<(` whose body starts at `start`; input.length if unterminated. */
function closeParen(input: string, start: number): number {
  let depth = 1;
  let i = start;
  let pending: Heredoc[] = [];
  while (i < input.length) {
    const c = input[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "#" && (i === start || /[\s;&|()]/.test(input[i - 1]!))) {
      // comment: an apostrophe in it must not open a quote
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      // here-document: its body may contain `)` or quotes that mean nothing to the shell
      const strip = input[i + 2] === "-";
      const d = readHeredocDelim(input, i + (strip ? 3 : 2));
      if (d) {
        pending.push({ delim: d.delim, strip, quoted: d.quoted });
        i = d.end;
        continue;
      }
    }
    if (c === "\n" && pending.length > 0) {
      i = skipHeredocs(input, i + 1, pending);
      pending = [];
      continue;
    }
    if (c === "'") {
      const e = input.indexOf("'", i + 1);
      i = e === -1 ? input.length : e + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') i += input[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "`") {
      i = closeBacktick(input, i + 1) + 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
    i++;
  }
  return input.length;
}

/** Index of the backtick closing one opened just before `start`; input.length if unterminated. */
function closeBacktick(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === "`") return i;
    i++;
  }
  return input.length;
}

function tokenize(input: string): Tokenized {
  const segments: Segment[] = [];
  const subs: string[] = [];
  const heredocBodies: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  /** the next word is a redirection target (file name), not an argument */
  let skipNext = false;
  /** here-documents whose bodies start after the next newline */
  let heredocs: Heredoc[] = [];
  let i = 0;

  const endWord = () => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    skipNext = false;
    if (words.length > 0) segments.push(words);
    words = [];
  };
  /** `$(`, `<(`, `>(` at i (2 chars) — record the body as a sub-script, keep the raw text in the word */
  const takeParenSub = () => {
    const end = closeParen(input, i + 2);
    subs.push(input.slice(i + 2, end));
    word += input.slice(i, Math.min(end + 1, input.length));
    inWord = true;
    i = end + 1;
  };
  const takeBacktickSub = () => {
    const end = closeBacktick(input, i + 1);
    subs.push(input.slice(i + 1, end).replace(/\\([`$\\])/g, "$1"));
    word += input.slice(i, Math.min(end + 1, input.length));
    inWord = true;
    i = end + 1;
  };

  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];

    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      word += input.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          word += input[i + 1];
          i += 2;
        } else if (input[i] === "$" && input[i + 1] === "(") {
          takeParenSub();
        } else if (input[i] === "`") {
          takeBacktickSub();
        } else {
          word += input[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "#" && !inWord) {
      // comment to end of line
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "$" && next === "(") {
      takeParenSub();
      continue;
    }
    if (c === "`") {
      takeBacktickSub();
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      // process substitution: the shell runs the body
      takeParenSub();
      continue;
    }
    if (c === "&" && next === ">") {
      // &> file, &>> file
      endWord();
      i += input[i + 2] === ">" ? 3 : 2;
      skipNext = true;
      continue;
    }
    if (c === "<" || c === ">") {
      // redirection: a leading all-digit word is the fd ("2>"), the following word is the target
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let j = i + 1;
      if (c === "<" && input[j] === "<" && input[j + 1] !== "<") {
        // here-document `<<WORD` / `<<-WORD`: the body (following lines) is data, not commands
        const strip = input[j + 1] === "-";
        const d = readHeredocDelim(input, j + (strip ? 2 : 1));
        if (d) {
          heredocs.push({ delim: d.delim, strip, quoted: d.quoted });
          i = d.end;
          continue;
        }
      }
      if (c === "<" && input[j] === "<") {
        j++;
        if (input[j] === "<" || input[j] === "-") j++;
      } else if (input[j] === ">" || input[j] === "|" || (c === "<" && input[j] === ">")) j++;
      if (input[j] === "&") {
        // fd duplication: 2>&1, >&-, <&0
        j++;
        const m = /^(\d+|-)/.exec(input.slice(j));
        if (m) {
          i = j + m[0].length;
          continue;
        }
      }
      i = j;
      skipNext = true;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      endSegment();
      i += op.length;
      if (op === "\n" && heredocs.length > 0) {
        i = skipHeredocs(input, i, heredocs, subs, heredocBodies);
        heredocs = [];
      }
      continue;
    }
    if (c === "(" && inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word)) {
      // array assignment `arr=(a b c)`: words, not a subshell — but `$(…)` inside still runs
      const end = closeParen(input, i + 1);
      collectSubs(input.slice(i + 1, end), subs, true);
      word += input.slice(i, Math.min(end + 1, input.length));
      i = end + 1;
      continue;
    }
    if (c === "(" || c === ")") {
      // subshell delimiters always separate commands
      endSegment();
      i++;
      continue;
    }
    if (!inWord && ((c === "{" && (next === undefined || /\s/.test(next))) || (c === "}" && (next === undefined || /[\s;&|)]/.test(next))))) {
      // group delimiters `{ …; }` — reserved words only when they stand alone
      endSegment();
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSegment();
  return { segments, subs, heredocBodies };
}

/** Split a command line into simple-command segments of words. */
export function splitCommand(input: string): Segment[] {
  return tokenize(input).segments;
}

interface WrapperSpec {
  /** options that take a separate value */
  value?: string[];
  /** leading positional arguments to skip after the options (timeout DURATION) */
  positionals?: number;
  /** remaining words are joined and run by a shell (eval, watch) */
  joinAndRun?: boolean;
  stdinArgs?: boolean;
}

const WRAPPERS = new Map<string, WrapperSpec>(Object.entries({
  sudo: { value: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--command-timeout", "--close-from", "--chroot"] },
  doas: { value: ["-u", "-C"] },
  nohup: {},
  time: { value: ["-f", "-o", "--format", "--output"] },
  command: {},
  builtin: {},
  exec: { value: ["-a"] },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "-n", "-p", "--class", "--classdata"] },
  chrt: { positionals: 1 },
  taskset: { positionals: 1 },
  timeout: { value: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  gtimeout: { value: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  stdbuf: { value: ["-i", "-o", "-e"] },
  unbuffer: {},
  chronic: {},
  caffeinate: { value: ["-t", "-w"] },
  corepack: {},
  busybox: {},
  xargs: {
    value: ["-n", "-I", "-P", "-d", "-a", "-E", "-L", "-s", "-R", "-S", "--max-args", "--replace", "--max-procs", "--delimiter", "--arg-file", "--eof", "--max-lines", "--max-chars"],
    stdinArgs: true,
  },
  parallel: { stdinArgs: true },
  eval: { joinAndRun: true },
  watch: { value: ["-n", "--interval", "-d", "--differences"], joinAndRun: true },
  // shell keywords that may precede a command
  then: {},
  do: {},
  else: {},
  elif: {},
  if: {},
  while: {},
  until: {},
  "!": {},
} satisfies Record<string, WrapperSpec>));
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function assign(env: Record<string, string>, w: string) {
  const eq = w.indexOf("=");
  env[w.slice(0, eq)] = w.slice(eq + 1);
}

/** The script a `sh -c …` / `bash -lc …` invocation runs, if any. */
function shellScript(words: string[]): string | undefined {
  const cIdx = words.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
  if (cIdx < 0) return undefined;
  for (let k = cIdx + 1; k < words.length; k++) {
    const w = words[k]!;
    if (w === "--") continue;
    if (w === "-o" || w === "+o") {
      k++;
      continue;
    }
    if (/^[-+]/.test(w)) continue;
    return w;
  }
  return undefined;
}

/** `bash`, `sh -s`, `bash -x -s -- args`: no script file operand, so commands come from stdin. */
function readsStdin(words: string[]): boolean {
  for (let k = 1; k < words.length; k++) {
    const w = words[k]!;
    if (w === "-s" || /^-[A-Za-z]*s[A-Za-z]*$/.test(w)) return true;
    if (w === "--") return k + 1 >= words.length;
    if (w === "-o" || w === "+o" || w === "-O" || w === "+O" || w === "--rcfile" || w === "--init-file") {
      k++;
      continue;
    }
    if (/^[-+]/.test(w)) continue;
    return false; // a script file
  }
  return true;
}

/**
 * Strip leading env assignments and wrapper commands; expand `bash -c "..."`, `eval`, command
 * substitutions recursively. Returns the effective simple commands with their context.
 */
export function effectiveCommandsDetailed(input: string, depth = 0, inherited: Record<string, string> = {}): EffectiveCommand[] {
  const out: EffectiveCommand[] = [];
  const { segments, subs, heredocBodies } = tokenize(input);
  /** a shell with no script argument reads its commands from stdin — e.g. a here-document */
  let shellReadsStdin = false;
  const exported: Record<string, string> = { ...inherited };
  for (const seg of segments) {
    let words = [...seg];
    let stdinArgs = false;
    const env: Record<string, string> = { ...exported };
    let handled = false;
    for (;;) {
      const first = words[0];
      if (first === undefined) break;
      if (ASSIGN.test(first)) {
        assign(env, first);
        words = words.slice(1);
        continue;
      }
      const base = basename(first).toLowerCase();
      if (base === "export" || base === "declare" || base === "typeset") {
        for (const w of words.slice(1)) if (ASSIGN.test(w)) assign(exported, w);
        words = [];
        break;
      }
      if (base === "env") {
        words = words.slice(1);
        while (words[0] !== undefined) {
          const w = words[0];
          if (w === "--") {
            words = words.slice(1);
            break;
          }
          if (w === "-S" || w === "--split-string" || w.startsWith("--split-string=") || (w.startsWith("-S") && w.length > 2)) {
            const str = w === "-S" || w === "--split-string" ? (words[1] ?? "") : w.startsWith("-S") ? w.slice(2) : w.slice(w.indexOf("=") + 1);
            const rest = words.slice(w === "-S" || w === "--split-string" ? 2 : 1);
            if (depth < MAX_DEPTH) out.push(...effectiveCommandsDetailed([str, ...rest].join(" "), depth + 1, env));
            handled = true;
            break;
          }
          if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir" || w === "-P") {
            words = words.slice(2);
            continue;
          }
          if (w.startsWith("-")) {
            words = words.slice(1);
            continue;
          }
          if (ASSIGN.test(w)) {
            assign(env, w);
            words = words.slice(1);
            continue;
          }
          break;
        }
        if (handled) break;
        continue;
      }
      const spec = WRAPPERS.get(base);
      if (spec) {
        words = words.slice(1);
        const value = new Set(spec.value ?? []);
        while (words[0] !== undefined && words[0].startsWith("-") && words[0] !== "-") {
          const w = words[0];
          words = words.slice(w !== "--" && value.has(w) ? 2 : 1);
          if (w === "--") break;
        }
        words = words.slice(spec.positionals ?? 0);
        if (spec.stdinArgs) stdinArgs = true;
        if (spec.joinAndRun) {
          if (depth < MAX_DEPTH && words.length > 0) out.push(...effectiveCommandsDetailed(words.join(" "), depth + 1, env));
          handled = true;
          break;
        }
        continue;
      }
      break;
    }
    if (handled) continue;
    const head = words[0];
    if (head !== undefined && SHELLS.has(basename(head).toLowerCase())) {
      const script = shellScript(words);
      if (script !== undefined) {
        if (depth < MAX_DEPTH) out.push(...effectiveCommandsDetailed(script, depth + 1, env));
        continue;
      }
      if (readsStdin(words)) shellReadsStdin = true;
    }
    if (head !== undefined && /^(pwsh|powershell|cmd)(\.exe)?$/i.test(basename(head))) {
      const cIdx = words.findIndex((w, k) => k > 0 && /^([-/](c|command)|\/k)$/i.test(w));
      if (cIdx >= 0) {
        if (depth < MAX_DEPTH) out.push(...effectiveCommandsDetailed(words.slice(cIdx + 1).join(" "), depth + 1, env));
        continue;
      }
    }
    if (words.length > 0) out.push({ words, stdinArgs, env });
  }
  if (depth < MAX_DEPTH) for (const s of subs) out.push(...effectiveCommandsDetailed(s, depth + 1, exported));
  // `bash <<EOF … EOF`, `cat <<EOF | sh`: the body is the script
  if (shellReadsStdin && depth < MAX_DEPTH) for (const b of heredocBodies) out.push(...effectiveCommandsDetailed(b, depth + 1, exported));
  return out;
}

/** Effective simple commands (words only). */
export function effectiveCommands(input: string, depth = 0): Segment[] {
  return effectiveCommandsDetailed(input, depth).map((c) => c.words);
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** A word the shell would expand at run time ($VAR, $(…), `…`, {a,b}, {1..3}) — its value is unknowable. */
export function isDynamicWord(w: string): boolean {
  return /[$`]/.test(w) || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w);
}

/**
 * Bash brace expansion for one word (`x{a,b}` → `xa xb`, `{1..3}`), so every package the shell would
 * actually pass is checked by name. Words with `$`/backticks are left alone (dynamic). Returns the word
 * unchanged if it has no expandable brace or would expand to more than `limit` words.
 */
export function expandBraces(word: string, limit = 64): string[] {
  if (/[$`]/.test(word)) return [word];
  const out = expand(word, limit);
  return out && out.length <= limit ? out : [word];
}

function expand(w: string, limit: number): string[] | null {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    let end = -1;
    for (let j = i; j < w.length; j++) {
      if (w[j] === "{") depth++;
      else if (w[j] === "}" && --depth === 0) {
        end = j;
        break;
      } else if (w[j] === "," && depth === 1) commas.push(j);
    }
    if (end < 0) return [w];
    const pre = w.slice(0, i);
    const body = w.slice(i + 1, end);
    const post = w.slice(end + 1);
    let parts: string[] | null = null;
    if (commas.length > 0) {
      parts = [];
      let start = i + 1;
      for (const c of [...commas, end]) {
        parts.push(w.slice(start, c));
        start = c + 1;
      }
    } else {
      const r = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
      if (r) {
        const num = /\d/.test(r[1]!);
        const a = num ? Number(r[1]) : r[1]!.charCodeAt(0);
        const b = num ? Number(r[2]) : r[2]!.charCodeAt(0);
        if (Math.abs(b - a) >= limit) return null;
        parts = [];
        for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? 1 : -1) parts.push(num ? String(k) : String.fromCharCode(k));
      }
    }
    if (!parts) continue; // `{x}` is literal; look for a later brace
    const res: string[] = [];
    for (const p of parts) {
      const sub = expand(pre + p + post, limit);
      if (!sub) return null;
      res.push(...sub);
      if (res.length > limit) return null;
    }
    return res;
  }
  return [w];
}
