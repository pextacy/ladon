/**
 * Static patterns for install-time code (DOCS.md §4). Regex-based; JS additionally gets an AST pass
 * (see js.ts) so we catch `child_process` calls with dynamic arguments. Nothing is ever executed.
 */

export interface Pattern {
  re: RegExp;
  label: string;
}

export const NETWORK: Pattern[] = [
  { re: /require\(\s*['"](?:node:)?(https?|net|dgram|dns|tls|http2)['"]\s*\)/, label: "loads a network module" },
  { re: /from\s+['"](?:node:)?(https?|net|dgram|dns|tls|http2)['"]/, label: "imports a network module" },
  { re: /\bfetch\s*\(/, label: "calls fetch()" },
  { re: /\bXMLHttpRequest\b|\bWebSocket\s*\(/, label: "opens a web connection" },
  { re: /require\(\s*['"](axios|node-fetch|got|request|undici|superagent)['"]\s*\)/, label: "loads an HTTP client" },
  { re: /\b(curl|wget)\s+[-\w'"$]/, label: "runs curl/wget" },
  { re: /Invoke-WebRequest|\biwr\s|DownloadString|Net\.WebClient/i, label: "downloads via PowerShell" },
  { re: /\/dev\/(tcp|udp)\//, label: "opens a raw socket via /dev/tcp" },
  { re: /\b(nslookup|dig)\s+\S/, label: "performs DNS lookups" },
  { re: /https?:\/\/(?!(?:www\.)?(?:npmjs\.(?:com|org)|github\.com\/[\w-]+\/[\w-]+(?:\/issues|#|\s|['"])|nodejs\.org|opencollective\.com))[^\s'"`)]{4,}/, label: "contains a remote URL" },
];

export const ENV: Pattern[] = [
  { re: /process\.env(?!\.(NODE_ENV|npm_config_|npm_lifecycle_|npm_package_|CI\b|INIT_CWD|PWD|HOME\b|PATH\b|OS\b|TERM\b|SHELL\b))/, label: "reads environment variables" },
  { re: /Object\.(keys|entries|assign)\(\s*process\.env\s*\)|JSON\.stringify\(\s*process\.env/, label: "dumps the whole environment" },
  { re: /\.npmrc\b/, label: "touches .npmrc (npm tokens)" },
  { re: /\.ssh\b|id_rsa|id_ed25519/, label: "touches SSH keys" },
  { re: /\.aws\/credentials|\.config\/gcloud|\.azure\b|\.kube\/config/, label: "touches cloud credentials" },
  { re: /\.git-credentials|\.docker\/config\.json|\.netrc\b|\.pypirc\b/, label: "touches stored credentials" },
  { re: /\b(GITHUB_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GH_TOKEN)\b/, label: "references secret tokens" },
  { re: /\bos\.environ\b|\bgetenv\s*\(/, label: "reads environment variables" },
  { re: /Login Data|Local State|Keychain|\.mozilla\/firefox|wallet\.dat|\.solana|\.ethereum/i, label: "touches browser or wallet secrets" },
];

export const OBFUSCATION: Pattern[] = [
  { re: /\beval\s*\(/, label: "uses eval()" },
  { re: /\bnew\s+Function\s*\(|(?<![\w.])Function\s*\(\s*['"`]/, label: "builds code with Function()" },
  { re: /[A-Za-z0-9+/]{200,}={0,2}/, label: "contains a long base64 blob" },
  { re: /(?:\\x[0-9a-fA-F]{2}){40,}|['"][0-9a-fA-F]{200,}['"]/, label: "contains a long hex blob" },
  { re: /String\.fromCharCode\((?:\s*\d+\s*,){20,}/, label: "decodes char codes" },
  { re: /Buffer\.from\([^)]*['"]base64['"]\)|atob\(|base64\.b64decode|codecs\.decode/, label: "decodes base64 at runtime" },
  { re: /\bexec\s*\(\s*(?:compile|base64|zlib|marshal)/, label: "executes decoded Python" },
  { re: /_0x[0-9a-f]{4,}/, label: "has obfuscator-style identifiers" },
];

/** References to AI-agent and editor configuration (Aug 2026 worm persistence trick → R15). */
export const AGENT_CONFIG: Pattern[] = [
  { re: /\.claude[\\/]|claude_desktop_config|CLAUDE\.md|\.claude\.json/, label: "references Claude Code config" },
  { re: /\.cursor[\\/]|\.cursorrules|cursor[\\/]mcp\.json/, label: "references Cursor config" },
  { re: /\.vscode[\\/](tasks|settings|mcp)\.json/, label: "references VS Code tasks/settings" },
  { re: /\bmcp\.json\b|mcpServers/, label: "references MCP server config" },
  { re: /\.codex[\\/]|\.gemini[\\/]|\.windsurf|\.clinerules|\.continue[\\/]|AGENTS\.md|copilot-instructions\.md/, label: "references AI agent instructions/config" },
];

export const PY_NETWORK: Pattern[] = [
  { re: /\bimport\s+(urllib|requests|socket|http\.client|httpx|aiohttp)|from\s+(urllib|requests|socket|http|httpx)\b/, label: "imports a network module" },
  { re: /urlopen\(|requests\.(get|post)\(|socket\.socket\(/, label: "makes network calls" },
  { re: /https?:\/\/(?!(?:www\.)?(?:pypi\.org|python\.org|github\.com\/[\w-]+\/[\w-]+\s))[^\s'")]{4,}/, label: "contains a remote URL" },
];

export const PY_EXEC: Pattern[] = [
  { re: /\bsubprocess\.|os\.system\(|os\.popen\(/, label: "runs shell commands" },
  { re: /\bexec\s*\(|\beval\s*\(/, label: "executes dynamic code" },
  { re: /cmdclass\s*=/, label: "overrides setup commands (cmdclass)" },
];

export function matchAll(text: string, patterns: Pattern[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) if (p.re.test(text)) out.add(p.label);
  return [...out];
}
