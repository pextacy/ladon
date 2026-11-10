import { parse, type Node } from "acorn";

export interface JsAstFindings {
  parsed: boolean;
  dynamicExec: boolean;
  evalLike: boolean;
  requires: string[];
}

const EXEC_FNS = new Set(["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork"]);

type AnyNode = Node & Record<string, unknown>;

function isStatic(n: AnyNode | undefined): boolean {
  if (!n) return true;
  if (n.type === "Literal") return true;
  if (n.type === "TemplateLiteral") return Array.isArray(n.expressions) && n.expressions.length === 0;
  if (n.type === "ArrayExpression") return (n.elements as AnyNode[]).every((e) => e === null || isStatic(e));
  return false;
}

/** AST pass (acorn): child_process calls with non-literal commands, eval/Function, and local requires. */
export function analyzeJsAst(code: string): JsAstFindings {
  const out: JsAstFindings = { parsed: false, dynamicExec: false, evalLike: false, requires: [] };
  let ast: Node;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  } catch {
    try {
      ast = parse(code, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, allowReturnOutsideFunction: true });
    } catch {
      return out;
    }
  }
  out.parsed = true;
  let visited = 0;
  const walk = (n: unknown) => {
    if (visited++ > 200_000 || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const node = n as AnyNode;
    if (typeof node.type === "string") {
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const callee = node.callee as AnyNode;
        const args = node.arguments as AnyNode[];
        const fn =
          callee.type === "Identifier" ? (callee.name as string) : callee.type === "MemberExpression" && (callee.property as AnyNode).type === "Identifier" ? ((callee.property as AnyNode).name as string) : undefined;
        if (fn === "eval" || (fn === "Function" && callee.type === "Identifier")) out.evalLike = true;
        if (fn && EXEC_FNS.has(fn) && !isStatic(args[0])) out.dynamicExec = true;
        if (fn === "require" && callee.type === "Identifier" && args[0]?.type === "Literal" && typeof args[0].value === "string") out.requires.push(args[0].value);
      }
      if (node.type === "ImportDeclaration") {
        const src = node.source as AnyNode;
        if (typeof src.value === "string") out.requires.push(src.value);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = node[k];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(ast);
  return out;
}
