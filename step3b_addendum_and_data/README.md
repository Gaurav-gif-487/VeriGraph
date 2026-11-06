# Widened ky mutation run (partial)

Partial Stryker output for the widened 13-file, 195-mutant configuration of `../ky-mutation-testing-project`.

- `stryker.conf.widened-13file.json`: the widened configuration (adds `is.ts`, `types.ts`, `KyError.ts`, `HTTPError.ts`, `SchemaValidationError.ts`, and `test/http-error.ts` to the test command).
- `batch_reports/`: raw Stryker JSON for the batches that completed. Batch names encode the file and line range mutated.

Stryker's `command` runner starts a fresh `npx ava` process per mutant (15 to 27 seconds each), so the full set takes many hours on one core. Several batches were run and some of the remaining mutants (e.g. the last `normalize.ts` ones) were not. A native runner with in-process mutant switching (for example Vitest with Stryker's vitest runner) would remove that per-mutant cost.

Findings from the completed batches: `KyError.ts` and `TimeoutError.ts` both have a `name` field that mutates without any test failing.
