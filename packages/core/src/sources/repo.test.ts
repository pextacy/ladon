import { describe, expect, it } from "vitest";
import { parseGithubRepo, parseRepoUrl, rawFileUrl, repoSource } from "./repo.js";

describe("parseRepoUrl", () => {
  it("GitHub shapes (unchanged)", () => {
    expect(parseRepoUrl("git+https://github.com/expressjs/express.git")).toEqual({ host: "github", owner: "expressjs", repo: "express" });
    expect(parseRepoUrl("github:a/b")).toEqual({ host: "github", owner: "a", repo: "b" });
    expect(parseRepoUrl("a/b")).toEqual({ host: "github", owner: "a", repo: "b" });
    expect(parseGithubRepo("git@github.com:a/b.git")).toEqual({ owner: "a", repo: "b" });
  });
  it("GitLab incl. nested groups and /-/ paths", () => {
    expect(parseRepoUrl("git+https://gitlab.com/group/sub/proj.git")).toEqual({ host: "gitlab", owner: "group/sub", repo: "proj" });
    expect(parseRepoUrl("https://gitlab.com/a/b/-/tree/main")).toEqual({ host: "gitlab", owner: "a", repo: "b" });
    expect(parseRepoUrl("git@gitlab.com:a/b.git")).toEqual({ host: "gitlab", owner: "a", repo: "b" });
    expect(parseRepoUrl("gitlab:a/b")).toEqual({ host: "gitlab", owner: "a", repo: "b" });
    expect(parseGithubRepo("https://gitlab.com/a/b")).toBeNull();
  });
  it("Codeberg and Bitbucket", () => {
    expect(parseRepoUrl("https://codeberg.org/forgejo/forgejo")).toEqual({ host: "codeberg", owner: "forgejo", repo: "forgejo" });
    expect(parseRepoUrl("git+ssh://git@bitbucket.org/ws/repo.git")).toEqual({ host: "bitbucket", owner: "ws", repo: "repo" });
    expect(parseRepoUrl("bitbucket:ws/repo")).toEqual({ host: "bitbucket", owner: "ws", repo: "repo" });
    expect(parseRepoUrl("https://example.com/x/y")).toBeNull();
  });
  it("raw URLs", () => {
    expect(rawFileUrl({ host: "gitlab", owner: "g/s", repo: "p" }, "packages/x/package.json")).toBe("https://gitlab.com/g/s/p/-/raw/HEAD/packages/x/package.json");
    expect(rawFileUrl({ host: "codeberg", owner: "o", repo: "r" }, "pyproject.toml")).toBe("https://codeberg.org/api/v1/repos/o/r/raw/pyproject.toml");
    expect(rawFileUrl({ host: "bitbucket", owner: "w", repo: "r" }, "package.json")).toBe("https://bitbucket.org/w/r/raw/HEAD/package.json");
  });
});

function recorded(routes: Record<string, { body: string; type?: string } | number>) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return new Response("Not Found", { status: 404 });
    if (typeof r === "number") return new Response("", { status: r });
    return new Response(r.body, { status: 200, headers: { "content-type": r.type ?? "text/plain; charset=utf-8" } });
  };
  return { f, calls };
}

describe("repoSource (recorded fetch)", () => {
  it("GitLab npm package.json name check, same semantics as GitHub", async () => {
    const { f } = recorded({
      "https://gitlab.com/gitlab-org/frontend/ui/-/raw/HEAD/package.json": { body: JSON.stringify({ name: "@gitlab/ui" }) },
      "https://gitlab.com/evil/clone/-/raw/HEAD/package.json": { body: JSON.stringify({ name: "something-else" }) },
    });
    const src = repoSource({ fetch: f });
    expect(await src.referencesPackage("git+https://gitlab.com/gitlab-org/frontend/ui.git", undefined, "@gitlab/ui", "npm")).toEqual({ referencesPackage: true });
    expect(await src.referencesPackage("https://gitlab.com/evil/clone", undefined, "@gitlab/ui", "npm")).toEqual({ referencesPackage: false, note: 'evil/clone declares "something-else", not "@gitlab/ui"' });
    expect(await src.referencesPackage("https://gitlab.com/x/y", undefined, "z", "npm")).toEqual({ referencesPackage: null, note: "no package.json at repository root" });
    expect(await src.referencesPackage("https://gitlab.com/x/y", "packages/z", "z", "npm")).toMatchObject({ referencesPackage: false });
  });
  it("private GitLab repo (sign-in HTML) is 'could not read', not a mismatch", async () => {
    const { f } = recorded({ "https://gitlab.com/priv/repo/-/raw/HEAD/pyproject.toml": { body: "<!DOCTYPE html><title>Sign in</title>", type: "text/html; charset=utf-8" } });
    expect(await repoSource({ fetch: f }).referencesPackage("https://gitlab.com/priv/repo", undefined, "x", "pypi")).toEqual({ referencesPackage: null, note: "could not read repository" });
  });
  it("Codeberg / Bitbucket PyPI manifests", async () => {
    const { f, calls } = recorded({
      "https://codeberg.org/api/v1/repos/o/tool/raw/setup.cfg": { body: "[metadata]\nname = my_tool\n" },
      "https://bitbucket.org/ws/lib/raw/HEAD/pyproject.toml": { body: '[project]\nname = "other-lib"\n' },
    });
    const src = repoSource({ fetch: f });
    expect(await src.referencesPackage("https://codeberg.org/o/tool", undefined, "my-tool", "pypi")).toEqual({ referencesPackage: true });
    expect(calls).toContain("https://codeberg.org/api/v1/repos/o/tool/raw/pyproject.toml");
    expect(await src.referencesPackage("https://bitbucket.org/ws/lib", undefined, "my-lib", "pypi")).toEqual({ referencesPackage: false, note: 'ws/lib pyproject.toml does not name "my-lib"' });
  });
  it("GitHub still works through raw.githubusercontent.com; unknown hosts are not verified", async () => {
    const { f } = recorded({ "https://raw.githubusercontent.com/expressjs/express/HEAD/package.json": { body: '{"name":"express"}' } });
    const src = repoSource({ fetch: f });
    expect(await src.referencesPackage("git+https://github.com/expressjs/express.git", undefined, "express", "npm")).toEqual({ referencesPackage: true });
    expect((await src.referencesPackage("https://sr.ht/~x/y", undefined, "y", "npm")).referencesPackage).toBeNull();
  });
});
