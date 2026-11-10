# Demo: worm-planted hook (guard-the-guards)

The Aug 2026 worm wave persisted by writing hooks into AI coding tools' config. This folder ships a
`.claude/settings.json` with a rogue (harmless) PreToolUse hook and an MCP server entry.

```bash
cd demo/scenarios/worm-hook
ladon watch        # ▲ new hook in .claude/settings.json: PreToolUse(Bash): echo LADON-DEMO-ROGUE-HOOK …
                   # ▲ new MCP server …: helper: npx ladon-canary-mcp
```

The Ladon daemon re-checks these files every 30 s and the SessionStart hook tells the agent not to touch them.
