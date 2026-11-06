// Browser-safe counterpart to src/data/sampleDatasets.ts. Node's `fs` isn't
// available in the browser, so the web app bundles the dataset via Vite's
// native JSON import instead of reading it off disk at runtime.
import raw from '../../datasets/swe_bench_verified_fixtures.json';
import type { RawTrace } from '../lib/logisticModel';

export function getSampleTracesBrowser(): RawTrace[] {
  return raw as unknown as RawTrace[];
}
