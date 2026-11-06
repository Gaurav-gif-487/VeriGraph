# Mutation testing on ky

A trimmed fork of [sindresorhus/ky](https://github.com/sindresorhus/ky) (MIT, see `LICENSE`) used for a Stryker Mutator 10 run against ky's small utility and error modules. The question: does a file's centrality in the call graph predict how often mutants in it survive the test suite?

Reproduce: `npm install --no-audit --no-fund && npm run mutation` (about 30 to 40 minutes on one core). A quick check of the test setup: `npx ava test/http-error.ts`.

## Result (8 files, 169 mutants)

149 killed, 20 survived, 0 timeouts. Tests run: `main.ts`, `retry.ts`, `hooks.ts`. Centrality is file-level fan-in/fan-out from the SIE engine.

| file | fanIn | fanOut | mutants | killed | survived |
|---|---|---|---|---|---|
| is-network-error.ts | 1 | 0 | 72 | 72 | 0 |
| delay.ts | 1 | 1 | 16 | 16 | 0 |
| timeout.ts | 1 | 1 | 10 | 10 | 0 |
| normalize.ts | 1 | 3 | 38 | 38 | 0 |
| ForceRetryError.ts | 2 | 3 | 8 | 7 | 1 |
| NetworkError.ts | 2 | 2 | 1 | 1 | 0 |
| NonError.ts | 2 | 0 | 23 | 4 | 19 |
| TimeoutError.ts | 3 | 2 | 1 | 1 | 0 |

19 of the 20 survivors are in `NonError.ts`, which the chosen test subset barely exercises, so any median split on centrality is driven by that one file. This sample does not show a centrality effect in either direction.

The raw Stryker report for this run was not saved; `stryker.conf.json` reproduces it.

## Widened run (partial)

A second run widened the scope to 13 files (195 mutants) and added `test/http-error.ts`. It was not completed; the partial raw reports are in `../step3b_addendum_and_data/`. One concrete gap it found: no test asserts the `.name` property of `KyError` or `TimeoutError`, so mutating it survives.
