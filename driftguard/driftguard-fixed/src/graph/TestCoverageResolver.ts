import fs from 'node:fs';
import path from 'node:path';

/**
 * Structural coverage signal: does at least one test file statically reach
 * a given consumer source file, directly or through a barrel re-export or a
 * shared hook/utility?
 *
 * Extends the two gaps VALIDATION.md's dogfood run named explicitly:
 *   - re-exports and barrel files (e.g. `export * from './userClient'`)
 *   - indirect coverage via a shared hook/utility (Component -> useHook ->
 *     consumer, not just Component -> consumer directly)
 *
 * Deliberately dependency-free: no `typescript` package, no tree-sitter.
 * Import/export statements are found with regex, the same tradeoff the
 * original had_test_coverage() check made — noted here, not hidden. A real
 * TS parser would resolve more precisely; that's out of scope for this
 * minimal build (see minimal-evidence-gated-system-design-v2.md §2).
 */

const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const SOURCE_SUFFIXES = ['.ts', '.tsx'];

const IMPORT_RE = /import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const REEXPORT_RE = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const UNRESOLVABLE_DYNAMIC_RE = /require\(\s*(?!['"])[^)]*\)|import\(\s*(?!['"])[^)]*\)/;
const UNRESOLVABLE_DYNAMIC_PREFIX_RE = /(?:require|import)\(\s*`([^`$]*)\$\{/g;

export type CoverageVerdict = 'tested' | 'untested' | 'cannot_determine';
export interface CoverageResult { verdict: CoverageVerdict; evidence: string[] | null; }

interface ModuleNode {
  path: string;
  imports: Set<string>;
  reexports: Set<string>;
  unresolvedDynamic: boolean;
  dynamicPrefixDirs: Set<string>;
}

export class ModuleGraph {
  readonly root: string;
  readonly nodes = new Map<string, ModuleNode>();
  readonly testFiles = new Set<string>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.build();
  }

  private build() {
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (SOURCE_SUFFIXES.some(s => entry.name.endsWith(s))) {
          const abspath = path.normalize(full);
          if (TEST_SUFFIXES.some(s => entry.name.endsWith(s))) this.testFiles.add(abspath);
          this.nodes.set(abspath, this.parse(abspath));
        }
      }
    };
    walk(this.root);
  }

  private parse(abspath: string): ModuleNode {
    const content = fs.readFileSync(abspath, 'utf8');
    const baseDir = path.dirname(abspath);
    const node: ModuleNode = {
      path: abspath, imports: new Set(), reexports: new Set(),
      unresolvedDynamic: false, dynamicPrefixDirs: new Set(),
    };

    for (const m of content.matchAll(IMPORT_RE)) {
      if (!m[1]) continue;
      const resolved = this.resolveSpecifier(baseDir, m[1]);
      if (resolved) node.imports.add(resolved);
    }
    for (const m of content.matchAll(REEXPORT_RE)) {
      if (!m[1]) continue;
      const resolved = this.resolveSpecifier(baseDir, m[1]);
      if (resolved) { node.reexports.add(resolved); node.imports.add(resolved); }
    }
    for (const m of content.matchAll(REQUIRE_RE)) {
      if (!m[1]) continue;
      const resolved = this.resolveSpecifier(baseDir, m[1]);
      if (resolved) node.imports.add(resolved);
    }
    for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
      if (!m[1]) continue;
      const resolved = this.resolveSpecifier(baseDir, m[1]);
      if (resolved) node.imports.add(resolved);
    }
    if (UNRESOLVABLE_DYNAMIC_RE.test(content)) {
      node.unresolvedDynamic = true;
      for (const m of content.matchAll(UNRESOLVABLE_DYNAMIC_PREFIX_RE)) {
        const prefix = m[1];
        if (prefix) {
          const prefixDir = path.normalize(path.join(baseDir, path.dirname(prefix) || '.'));
          node.dynamicPrefixDirs.add(prefixDir);
        }
      }
    }
    return node;
  }

  private resolveSpecifier(baseDir: string, specifier: string): string | null {
    if (!(specifier.startsWith('.') || specifier.startsWith('/'))) return null; // package import, not workspace
    const candidate = path.normalize(path.join(baseDir, specifier));
    if (this.isFile(candidate)) return candidate;
    for (const suffix of SOURCE_SUFFIXES) {
      const p = candidate + suffix;
      if (this.isFile(p)) return p;
    }
    for (const suffix of SOURCE_SUFFIXES) {
      const p = path.join(candidate, 'index' + suffix);
      if (this.isFile(p)) return p;
    }
    return null;
  }

  private isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }

  /** A barrel (file that's just re-exports) is transparent: importing it is
   * equivalent to importing what it re-exports, recursively. */
  private expandBarrel(f: string, seen: Set<string> = new Set()): Set<string> {
    if (seen.has(f)) return new Set();
    seen.add(f);
    const node = this.nodes.get(f);
    if (!node || node.reexports.size === 0) return new Set([f]);
    const result = new Set<string>();
    for (const r of node.reexports) for (const x of this.expandBarrel(r, seen)) result.add(x);
    return result;
  }

  has_coverage(consumerFile: string, maxIndirectHops = 2): CoverageResult {
    const normalized = path.normalize(path.resolve(consumerFile));
    if (!this.nodes.has(normalized)) return { verdict: 'cannot_determine', evidence: null };
    const consumerDir = path.dirname(normalized);

    let dynamicSeen = false;

    for (const testFile of [...this.testFiles].sort()) {
      const testNode = this.nodes.get(testFile);
      if (!testNode) continue;

      const roots = new Set<string>();
      for (const imp of testNode.imports) for (const x of this.expandBarrel(imp)) roots.add(x);

      if (roots.has(normalized)) return { verdict: 'tested', evidence: [testFile, normalized] };

      for (const r of roots) {
        const n = this.nodes.get(r);
        if (n && n.dynamicPrefixDirs.has(consumerDir)) dynamicSeen = true;
      }

      const { path: bfsPath, hitDynamic } = this.bfsIndirect(roots, normalized, maxIndirectHops, consumerDir);
      dynamicSeen = dynamicSeen || hitDynamic;
      if (bfsPath) return { verdict: 'tested', evidence: [testFile, ...bfsPath] };
    }

    return { verdict: dynamicSeen ? 'cannot_determine' : 'untested', evidence: null };
  }

  private bfsIndirect(roots: Set<string>, target: string, maxHops: number, targetDir: string) {
    const visited = new Set(roots);
    let frontier: [string, string[]][] = [...roots].map(r => [r, [r]]);
    let depth = 0;
    let hitDynamic = false;
    while (frontier.length && depth < maxHops) {
      const next: [string, string[]][] = [];
      for (const [f, p] of frontier) {
        const node = this.nodes.get(f);
        if (!node) continue;
        if (node.dynamicPrefixDirs.has(targetDir)) hitDynamic = true;
        for (const imp of node.imports) {
          for (const e of this.expandBarrel(imp)) {
            if (e === target) return { path: [...p, e], hitDynamic };
            if (!visited.has(e)) { visited.add(e); next.push([e, [...p, e]]); }
          }
        }
      }
      frontier = next;
      depth += 1;
    }
    return { path: null as string[] | null, hitDynamic };
  }
}
