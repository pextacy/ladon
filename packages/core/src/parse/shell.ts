/**
 * Minimal POSIX-ish shell tokenizer: enough to find package-manager invocations inside the
 * commands coding agents run ("cd web && npm i foo", "bash -c 'pip install x'", "FOO=1 npx bar").
 * It never executes or expands anything.
 */

export type Segment = string[];

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];

/** Split a command line into simple-command segments of words. */
export function splitCommand(input: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  while (i < input.length) {
    const c = input[i]!;

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
        } else {
          word += input[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      if (input[i + 1] !== "\n") {
        word += input[i + 1];
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
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      endSegment();
      i += op.length;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // subshell / group delimiters: treat as segment boundaries when standalone
      if (!inWord) {
        endSegment();
        i++;
        continue;
      }
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
  return segments;
}

const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "command", "exec", "nice", "xargs", "then", "do", "else"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Strip leading env assignments and wrapper commands; expand `bash -c "..."` recursively.
 * Returns the effective simple commands.
 */
export function effectiveCommands(input: string, depth = 0): Segment[] {
  const out: Segment[] = [];
  for (const seg of splitCommand(input)) {
    let words = [...seg];
    for (;;) {
      const first = words[0];
      if (first === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
        words = words.slice(1);
        continue;
      }
      if (first === "env") {
        words = words.slice(1);
        while (words[0] !== undefined && (words[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
          words = words.slice(1);
        }
        continue;
      }
      if (WRAPPERS.has(basename(first))) {
        words = words.slice(1);
        while (words[0] !== undefined && words[0].startsWith("-")) words = words.slice(1);
        continue;
      }
      break;
    }
    const head = words[0];
    if (head !== undefined && SHELLS.has(basename(head)) && depth < 3) {
      const cIdx = words.findIndex((w) => w === "-c" || (/^-[a-z]*c$/.test(w) && w.length <= 4));
      const script = cIdx >= 0 ? words[cIdx + 1] : undefined;
      if (script !== undefined) {
        out.push(...effectiveCommands(script, depth + 1));
        continue;
      }
    }
    if (words.length > 0) out.push(words);
  }
  return out;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
