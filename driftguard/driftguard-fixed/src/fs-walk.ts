import fs, { type Dirent } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "test",
  "tests",
  "__tests__",
  "spec",
  "__mocks__",
  "mocks",
  "cypress",
  "e2e",
]);

/** Matches test-named files that sit next to their source rather than in a
 *  dedicated test directory, e.g. `api_test.go`, `userClient.test.ts`,
 *  `test_routes.py`. These re-declare or re-exercise real routes/calls for
 *  their own harness (httptest, jest, pytest fixtures, ...) and must not be
 *  parsed as if they were the application's real client calls or server
 *  routes — see VALIDATION.md #4 for concrete false-positive examples. */
const TEST_FILE_PATTERN = /(^|[._-])(test|spec)s?([._-]|$)/i;

function isTestFile(fileName: string): boolean {
  return TEST_FILE_PATTERN.test(fileName);
}

/** Recursively collects file paths under `rootDir` whose extension is in
 *  `extensions` (e.g. `[".ts", ".tsx"]`), skipping common vendor/build dirs. */
export function walkFiles(rootDir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          !IGNORED_DIRS.has(entry.name.toLowerCase()) &&
          !entry.name.startsWith(".")
        ) {
          stack.push(path.join(dir, entry.name));
        }
        continue;
      }
      const ext = path.extname(entry.name);
      if (extensions.includes(ext) && !isTestFile(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results.sort();
}
