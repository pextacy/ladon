#!/usr/bin/env node
import { LADON_VERSION } from "@ladon/core";

const HELP = `ladon ${LADON_VERSION} — firewall between AI coding agents and package registries

Usage:
  ladon init                 install Claude Code hook + shims (Phase 2)
  ladon check <pkg>[@v]      manual verdict (Phase 1)
  ladon scan                 scan instruction files in cwd (Phase 3)
  ladon daemon               local service on :7433 (Phase 2)
  ladon key pair|status      Ladon Key pairing (Phase 4)
  ladon --version
`;

const [cmd] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v") {
  console.log(LADON_VERSION);
} else if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(HELP);
} else {
  process.stderr.write(`ladon: '${cmd}' is not implemented yet\n\n${HELP}`);
  process.exit(2);
}
