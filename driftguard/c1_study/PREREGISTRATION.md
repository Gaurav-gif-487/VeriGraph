# C1 Retrospective Study — Pre-registered Labeling Rule

Written before any repo is cloned or any commit is inspected, per
TEST_METHODOLOGY_C1_C2.md §0.1 and §1.2. This file is not edited after data
collection starts. If the rule turns out to be unworkable, that is reported
as a finding, not silently patched.

## Repos (fixed list, chosen for structural diversity per §1.5)

1. `tiangolo/full-stack-fastapi-template` — FastAPI + React, OpenAPI client
2. `bradtraversy/proshop-v2` — MERN, Redux Toolkit Query
3. `s-soumyakanta/TodoXpress` — Express + React, axios, CommonJS
4. `el10savio/TODO-Fullstack-App-Go-Gin-Postgres-React` — Gin + React, fetch
5. `bojand/sample-react-fastify` — Fastify + React

(Same five as VALIDATION.md's original dogfood — reused deliberately so the
new statistical layer sits on the same real repos the qualitative bugs were
already found in, rather than introducing new unvalidated fixtures.)

## Alert generation (mechanical, no judgment calls)

For every commit `C` in each repo's default-branch history (oldest to
newest, excluding merge commits) that touches a server-side contract file
(as DriftGuard's own `server-parser.ts` / `go-parser.ts` / `python-parser.ts`
would parse):

1. Check out `C^` (the parent) as "before."
2. Run `driftguard check` comparing `C^` → `C` (`--base C^`) in this
   before-state.
3. Every alert `driftguard check` emits (`BREAKING` / `WARNING` /
   `UNKNOWN`) on that diff is one row. Record: repo, commit SHA, alert
   type, and DriftGuard's own coverage verdict for the affected consumer
   (`tested` / `untested` / `cannot_determine`, from `TestCoverageResolver`
   as already wired into `driftguard check`'s output — not re-derived).

## Ground-truth breakage label (fixed rule, N = 14 calendar days)

For each alert's flagged consumer file `F`, label `broke` if **any** of the
following is true within 14 calendar days after commit `C`'s timestamp,
else label `didnt_break`:

- (a) A later commit modifies `F` **and** that later commit's message or
  the commit itself is a revert of `C` (`git revert`-style message, or
  `git log --follow` shows `F` reverted to pre-`C` content).
- (b) A later commit modifies `F` and its message contains a fix-signal
  keyword (`fix`, `hotfix`, `bug`, `broke`, `regression` — case-insensitive,
  checked as whole words) referencing the same area `C` touched.
- (c) The repo has an issue tracker with an issue opened within the window
  that references `F` or the endpoint/contract `C` changed (checked only if
  the repo's issue history is inspectable at all — several of these forks
  may have few or no issues, in which case (c) is marked `not_available`
  for that repo, not silently treated as "didn't break").

This is a proxy, not ground truth in the strongest sense (no access to a
private incident tracker) — stated as a limitation, not hidden.

`cannot_determine` coverage verdicts are logged and reported as their own
row (§1.4), never folded into `tested` or `untested`.

## AMENDMENT 1 (dated, before any Polar data was collected)

The original 5-repo set proved data-starved (see FINDINGS_C1.md — 7 real
alerts from 83 commits, exhaustively scanned, ~2 orders of magnitude short
of the required n). Switching to `polarsource/polar` (17,068 commits real
production monorepo, FastAPI + Next.js, MIT-licensed on GitHub) as the C1
repo, for volume.

Full-history exhaustive scan is infeasible here: confirmed real per-commit
`driftguard check` runtime is ~13s on this repo (vs ~1s on the small repos,
because of its much larger real codebase), and 6,271 commits touch
`server/polar` → ~22+ hours, beyond this environment's reach.

**Sampling rule (fixed before seeing any Polar alert data):** scan the
most recent 300 non-merge commits touching `server/polar`, oldest of that
window first. This is a recency-biased convenience sample, not a random
sample — stated as a limitation up front. If it doesn't reach the n=35–45/
group floor, that will be reported as such, not extended after the fact to
manufacture a passing n.

## AMENDMENT 2 (dated, after 11/300 commits, before seeing commit 12+)

Real measured cost on this repo is ~25s/commit (checkout + check), not the
~1s seen on the small repo — checkout alone is expensive on a 478MB `.git`.
300 commits would cost ~30 more tool-call batches, an unreasonable spend.
Reducing the target sample from 300 to **100** most-recent commits touching
`server/polar`, same fixed ordering, same "report short if short" rule.
This lowers the ceiling on what n we could reach, disclosed now, before
commit 12 is scanned, not chosen after seeing whether early commits look
promising.

## What will NOT be done

- N will not be changed after seeing results.
- Alerts will not be selectively excluded because they look inconvenient.
- The keyword list in (b) will not be edited after data collection starts.
- If total n falls short of the ~35–45/group floor from §1.3, that will be
  reported explicitly as "insufficient for the pre-registered significance
  test" rather than run anyway and presented as if it cleared the bar.
