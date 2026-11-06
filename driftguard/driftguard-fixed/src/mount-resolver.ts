import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { walkFiles } from "./fs-walk.js";
import { resolveFileCandidates } from "./cross-file-resolver.js";
import { findObjectLiteralProp } from "./server-parser.js";

const MOUNT_SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Maps a locally-bound identifier (imported/required at the top of a
 *  file) to the absolute path of the file it came from. One hop only —
 *  mirrors the existing policy in cross-file-resolver.ts. */
function buildLocalModuleMap(sourceFile: ts.SourceFile, fromFile: string): Map<string, string> {
  const map = new Map<string, string>();
  const dir = path.dirname(fromFile);

  function resolveSpecifier(specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    return resolveFileCandidates(path.resolve(dir, specifier));
  }

  for (const stmt of sourceFile.statements) {
    // ESM default import: `import router from "./routes/foo";`
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const resolved = resolveSpecifier(stmt.moduleSpecifier.text);
      if (resolved && stmt.importClause?.name) {
        map.set(stmt.importClause.name.text, resolved);
      }
    }
    // CommonJS: `const router = require("./routes/foo");`
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "require" &&
          decl.initializer.arguments[0] &&
          ts.isStringLiteral(decl.initializer.arguments[0])
        ) {
          const resolved = resolveSpecifier(decl.initializer.arguments[0].text);
          if (resolved) map.set(decl.name.text, resolved);
        }
      }
    }
  }
  return map;
}

/** Resolves the target of a mount call to an absolute file path. The
 *  target is either a local identifier bound via import/require at the top
 *  of the file (the common case), or — very common in real Fastify code —
 *  an inline `require("./x")` call passed directly as the argument
 *  (`app.register(require("./etag"), { prefix: "/etag" })`), which never
 *  goes through a top-level binding at all. */
function resolveMountTarget(
  targetArg: ts.Expression,
  localModules: Map<string, string>,
  fromFile: string,
): string | null {
  if (ts.isIdentifier(targetArg)) {
    return localModules.get(targetArg.text) ?? null;
  }
  if (
    ts.isCallExpression(targetArg) &&
    ts.isIdentifier(targetArg.expression) &&
    targetArg.expression.text === "require" &&
    targetArg.arguments[0] &&
    ts.isStringLiteral(targetArg.arguments[0])
  ) {
    const specifier = targetArg.arguments[0].text;
    if (!specifier.startsWith(".")) return null;
    return resolveFileCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

/** Scans a single file for router-mount calls and records prefix ->
 *  mounted-file entries into `out`. Recognizes two shapes:
 *
 *   Express:  `<expr>.use(<string literal prefix>, <target>)`
 *   Fastify:  `<expr>.register(<target>, { prefix: <string literal> })`
 *
 *  In both cases `<target>` is resolved via `resolveMountTarget` (a local
 *  identifier or an inline `require(...)` call). Single-hop by design —
 *  matches the existing one-hop policy used elsewhere in the codebase; a
 *  mounted file that itself mounts a further sub-router isn't chased
 *  transitively. */
function scanFileForMounts(filePath: string, text: string, out: Map<string, string>): void {
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : filePath.endsWith(".js")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const localModules = buildLocalModuleMap(sourceFile, filePath);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;

      // Express: app.use("/prefix", router)
      if (methodName === "use") {
        const prefixArg = node.arguments[0];
        const targetArg = node.arguments[1];
        if (
          prefixArg &&
          targetArg &&
          (ts.isStringLiteral(prefixArg) || ts.isNoSubstitutionTemplateLiteral(prefixArg))
        ) {
          const resolved = resolveMountTarget(targetArg, localModules, filePath);
          if (resolved) out.set(resolved, prefixArg.text);
        }
      }

      // Fastify: app.register(plugin, { prefix: "/prefix" })
      if (methodName === "register") {
        const targetArg = node.arguments[0];
        const optionsArg = node.arguments[1];
        if (targetArg && optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          const prefixProp = findObjectLiteralProp(optionsArg, "prefix");
          if (
            prefixProp &&
            (ts.isStringLiteral(prefixProp) || ts.isNoSubstitutionTemplateLiteral(prefixProp))
          ) {
            const resolved = resolveMountTarget(targetArg, localModules, filePath);
            if (resolved) out.set(resolved, prefixProp.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/** Builds a map from mounted-file absolute path -> the prefix it's mounted
 *  under, by scanning every TS/JS file under `rootDir` for `.use(prefix,
 *  target)` and `.register(target, { prefix })` mount calls. Consumed by
 *  `parseTsServerHandlers` to correct route paths that were parsed
 *  correctly in isolation but never had their real, mounted prefix
 *  applied — see VALIDATION.md #1 and #6 for the concrete false-positive
 *  cases this fixes. */
export function buildMountPrefixMap(rootDir: string): Map<string, string> {
  const files = walkFiles(rootDir, MOUNT_SCAN_EXTENSIONS);
  const out = new Map<string, string>();
  for (const file of files) {
    try {
      scanFileForMounts(file, fs.readFileSync(file, "utf8"), out);
    } catch {
      // Best-effort: a single unparseable file just contributes no mount
      // data rather than aborting the whole scan (parseTsServerHandlers
      // has its own try/catch for actual handler parsing failures).
    }
  }
  return out;
}
