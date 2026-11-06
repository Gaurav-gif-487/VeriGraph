# ADDENDUM: polarsource/polar dogfood (real, 16,907-commit production monorepo)

Added while scoping C1/C2 real-data experiments (see
`c1_study/TEST_METHODOLOGY_C1_C2.md`). Not part of the original 5-repo
VALIDATION.md pass — a new, much larger real repo, tried because the
original 5 repos turned out too small to supply enough real data for
either C1 (breaking-change statistics) or C2 (a real non-deterministic
analysis).

## Bug #10 (fixed): `client.buildRequest(method, url, ...)` SDK pattern not detected

**Found:** running driftguard against `polar`'s real `sdk/typescript`
package. 369 of 370 real client call sites came back `unresolvedClient`
with zero path extraction attempted — not a matching failure, an
extraction failure. The one call that did produce a "match" was a false
positive (an external `api.mintlify.com` call fuzzy-matched to an
unrelated internal route at confidence 0.66 — `client-parser.ts` had no
external-URL exclusion at all; noted here, not yet fixed separately since
fixing extraction properly removes this specific bad match).

**Root cause:** `polar` has its own hand-rolled SDK generator (not
`openapi-typescript-codegen`, not `@hey-api/openapi-ts`). Generated service
functions call `client.buildRequest("GET", "/v1/organizations/", pathParams,
queryParams, body)` — `method` and `url` as **positional string-literal
arguments**, then separately call `client.sendRequest(request)` to actually
fire the network request. None of the three existing patterns
(`axios.<method>(url)`, `fetch(url)`, `__request(OpenAPI, {method,url})`)
matched this shape.

**Fix:** added a fourth branch to `tryExtractCallSite` in
`client-parser.ts` recognizing `<identifier>.buildRequest(methodLiteral,
urlArg, ...)` by property name, reading `method` from positional arg 0 and
`url` from positional arg 1. See the code comment at the fix site and the
new test `client-parser: client.buildRequest(method, url, ...) (custom
hand-rolled SDK generator) is detected`.

**Verified for real, not just unit-tested:** re-ran driftguard against
`polar`'s actual `sdk/typescript/src` after the fix — went from 0 attempted
extractions to correct `GET /v1/benefit-grants/`-style parsing on real
generated code. Full existing test suite re-run clean: 275/275 pass (274
prior + 1 new), no regressions.

## Gap #2 (found, NOT fixed): server-side `APIRouter(prefix=...)` composition

Even with client-side extraction fixed, matches still don't resolve,
because `server/polar`'s Python route registration uses
`APIRouter(prefix="/v1")` at the router level (confirmed:
`server/polar/api.py:70`), meaning individual handlers are very likely
declared without the `/v1` segment (e.g. `@router.get("/benefit-grants/")`)
and only carry it after router composition. If `python-parser.ts` reads
the handler's own decorator string without resolving the router's
`prefix=` argument (and any further nesting), every server-side route in
this codebase is missing its real effective path, and no client route will
ever match regardless of how good client extraction is.

**Not confirmed by reading `python-parser.ts` directly yet, and not fixed.**
This is the actual blocker for using `polar` as real C1/C2 data — stated
plainly as the next real step, not silently left out.
