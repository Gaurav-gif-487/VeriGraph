// VeriGraph: loads the bundled SWE-bench-derived fixture traces from disk.
// This replaces a previously-missing module that the CLI imported but that
// never existed anywhere in the repo -- there was no way to get "sample
// traces" before this file was written.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { RawTrace } from '../lib/logisticModel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATASET_PATH = path.join(__dirname, '..', '..', 'datasets', 'swe_bench_verified_fixtures.json');

let cache: RawTrace[] | null = null;

/**
 * Loads the bundled dataset. The `full` flag exists for API-shape parity
 * with the earlier (nonfunctional) CLI; there is currently only one bundled
 * fixture set, so it does not change behavior -- kept as a documented no-op
 * rather than silently dropped.
 */
export function getSampleTraces(_full = true): RawTrace[] {
  if (cache) return cache;
  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(
      `Bundled dataset not found at ${DATASET_PATH}. Expected datasets/swe_bench_verified_fixtures.json ` +
        `relative to the project root.`
    );
  }
  const raw = fs.readFileSync(DATASET_PATH, 'utf-8');
  cache = JSON.parse(raw) as RawTrace[];
  return cache;
}
