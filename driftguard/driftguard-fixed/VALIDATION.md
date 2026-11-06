# Real-repo validation log

This documents a validation pass run against real, independently-built
repos (not the bundled `fixtures/`) to check DriftGuard's actual behavior
outside curated demo data. Nine real false-positive/false-negative bugs
were found and fixed; one related limitation is documented but
intentionally not fixed yet. All 257 existing tests pass after every
change below, and all five repos below now report a clean scan (modulo
the two genuinely-unresolvable dynamic-base-URL cases documented under
each repo).

Repos used:

- `tiangolo/full-stack-fastapi-template` — FastAPI + React, OpenAPI-generated client
- `bradtraversy/proshop-v2` — MERN, Redux Toolkit Query
- `s-soumyakanta/TodoXpress` — Express + React, axios, CommonJS
- `el10savio/TODO-Fullstack-App-Go-Gin-Postgres-React` — Gin + React, fetch
- `bojand/sample-react-fastify` — Fastify + React, `.route()` + `.register()`

---

## Fixed

### 1. Express/Fastify sub-router mount prefixes were never resolved

**Symptom:** `router.delete("/delete/:id", ...)` mounted via
`app.use("/api", router)` in another file was reported as
`unresolved-route` even though a client call to `/api/delete/:id` matches
it exactly.

**Root cause:** `src/server-parser.ts` parsed each file's route
registrations independently, with no concept of where that file's router
gets mounted.

**Fix:** New `src/mount-resolver.ts` — scans every file for
`<expr>.use(<string literal>, <identifier>)` calls, resolves the
identifier through that file's own import/require map (ESM default
imports and CommonJS `require()` both handled), and builds a map from
mounted-file absolute path → prefix. `parseTsServerHandlers` now applies
that prefix via a new `prependPrefix()` helper in `src/route-template.ts`
before matching. Single-hop by design (matches the existing one-hop
policy in `cross-file-resolver.ts`) — a mounted file that itself mounts a
further sub-router isn't chased transitively.

**Verified on:** TodoXpress — 3 of 4 false `unresolved-route` notes
resolved correctly after the fix; the remaining note is legitimately
unresolvable (a fully dynamic base URL).

---

### 2. Cross-file resolution only ever checked `.ts`/`.tsx`

**Symptom:** Any pure-JavaScript codebase got zero cross-file import
resolution — not just for the mount-prefix fix above, but for the
existing cross-file type/const resolution too.

**Root cause:** `resolveFileCandidates` in `src/cross-file-resolver.ts`
only probed `.ts`, `.tsx`, `.d.ts`, `/index.ts`, `/index.tsx` suffixes.

**Fix:** Added `.js`, `.jsx`, `/index.js`, `/index.jsx` to
`CANDIDATE_SUFFIXES`.

**Verified on:** TodoXpress (CommonJS, no TypeScript) — mount resolution
only started working end-to-end once this was fixed too; the mount fix
alone wasn't sufficient because the underlying file resolution was JS-blind.

---

### 3. Absolute URLs never matched relative server routes

**Symptom:** `fetch("http://localhost:8081/items")` was reported as
`unresolved-route` even though the server defines `router.GET("/items", ...)`
— an exact match once the origin is ignored.

**Root cause:** `parseRouteTemplate` in `src/route-template.ts` split the
raw string on `/` with no awareness that a leading `scheme://host[:port]`
isn't part of the path. `http://localhost:8081/items` and `/items`
produced different segment arrays and never matched, on any static or
dynamic route.

**Fix:** `parseRouteTemplate` now strips a leading `https?://<host>` before
splitting into segments. The original string is preserved in `.raw` for
display purposes; only segment matching is affected. Interpolated/dynamic
hosts (`` `${base}/items` ``) are untouched — those already surface as
`__DYN__` upstream.

**Verified on:** the Gin + React repo — all 4 real endpoints
(`/items`, `/item/create/:item`, `/item/update/:id/:done`,
`/item/delete/:id`) went from false `unresolved-route` to correct
matches.

---

### 4. Test files were parsed as if they were real client calls / server routes

**Symptom (server side):** `api_test.go` re-registers the same routes as
`main.go` for its own `httptest` setup. DriftGuard parsed both files,
producing two structurally-identical handlers per route and reporting
every real client call as `unresolved-route: ambiguous between 2
structurally identical server handlers`.

**Symptom (client side):** a `frontend/tests/utils/mailpit.ts` test
helper's `fetch()` call (to an endpoint that doesn't exist in the actual
app) was reported as a real unresolved client call, adding noise
unrelated to the actual app.

**Root cause:** `src/fs-walk.ts`'s `walkFiles` filtered only by build/vendor
directory name and extension — nothing excluded test directories or
test-named files.

**Fix:** `IGNORED_DIRS` now also skips `test`, `tests`, `__tests__`,
`spec`, `__mocks__`, `mocks`, `cypress`, `e2e` (case-insensitive). A new
`isTestFile()` check also excludes test-named files that sit next to
their source (`api_test.go`, `userClient.test.ts`, `test_routes.py`) via
`TEST_FILE_PATTERN = /(^|[._-])(test|spec)s?([._-]|$)/i`.

**Verified on:**
- Gin + React repo — the "ambiguous duplicate route" notes disappeared.
- FastAPI + React template — went from 1 phantom `unresolved-route` note
  to a fully clean `No breaking API driftguard detected.`

---

### 5. Fastify's `.route({...})` object form wasn't parsed at all

**Symptom:** every route in a real Fastify app went unrecognized —
`no server handler exists for GET at all` — even though the server had
working, correctly-implemented routes.

**Root cause:** `parseExpressLikeSourceFile` in `src/server-parser.ts`
only recognized the Express-shorthand call form
`app.get("/path", handler)`. Fastify's other, equally idiomatic
registration style —
```js
app.route({ method: "GET", url: "/x", handler: fn })
```
— was never matched by the `HTTP_METHOD_NAMES` check at all, since the
called method name is `route`, not `get`/`post`/etc.

**Fix:** added a second branch to the same AST visitor that recognizes
`.route({...})`, reads `method`/`url`/`handler` off the object literal via
a new `findObjectLiteralProp` helper, and reuses the existing
`resolveHandlerFunction` / `schemaFromHandler` pipeline unchanged.

**Verified on:** the Fastify + React sample repo — went from finding
**zero** server handlers to finding all 4 real ones.

---

### 6. Fastify's `.register(plugin, { prefix })` mount pattern wasn't recognized

**Symptom:** even after fix #5, a plugin's routes weren't corrected to
their real, prefixed path — `.register()` mounts weren't recognized by
`mount-resolver.ts` at all, which only looked for the Express `.use(prefix, target)`
shape (prefix as the *first*, string, argument).

**Root cause:** Fastify's plugin-mount idiom is structurally different —
`app.register(plugin, { prefix: "/x" })` — prefix lives in an options
*object*, and is the *second* argument, not the first. It's not a naming
variant of `.use`, it needed its own recognition. A related, smaller gap
in the same code path: the mount target itself is very often an inline
`require("./x")` call (`app.register(require("./etag"), { prefix: "/etag" })`),
not a variable bound via a top-level `import`/`require` — the original
`.use` handling only ever looked up local identifiers.

**Fix:** `findMountsInFile` now also recognizes `.register(target, { prefix })`,
reading the prefix off the options object via `findObjectLiteralProp`. Both
mount forms now resolve their target through a shared `resolveMountTarget()`
that handles a local identifier *or* an inline `require(...)` call.

**Verified on:** the Fastify + React sample repo, combined with fix #5 —
went from 0 server handlers found to a fully clean, genuinely-verified
`No breaking API driftguard detected.` (confirmed by inspecting the parsed
handler list directly, not just trusting a clean report — see method below).

---

### 7. `URLSearchParams`/`Headers`/`Map` receivers aliased to short variable
    names slipped past the built-in denylist

**Symptom:** `const sp = new URLSearchParams(search); sp.get('redirect')`
was reported as a phantom `GET redirect` API call.

**Root cause:** `looksLikeNonHttpReceiver` in `src/client-parser.ts`
denylists receivers by *literal name* (`headers`, `searchParams`, `map`,
and suffix variants). That only catches a receiver that happens to be
named exactly that; a `URLSearchParams` instance assigned to any other
identifier (`sp`, `params`, `qs`, ...) was invisible to it — the check
looks at spelling, not type.

**Fix:** added `findNewExpressionConstructorName()`, which looks up
`<name>`'s own `const <name> = new <Ctor>(...)` declaration anywhere in
the file and returns the constructor name. `looksLikeNonHttpReceiver` now
also denies a receiver whose *declared constructor* is
`URLSearchParams`/`Headers`/`Map`/`WeakMap`/`Set`/`WeakSet`, regardless of
what the variable itself is named.

**Verified on:** `bradtraversy/proshop-v2` — `LoginScreen.jsx` and
`RegisterScreen.jsx` both do exactly this (`sp.get('redirect')` to read a
query-string param); both false `GET redirect` notes disappeared and the
repo now reports a fully clean `No breaking API driftguard detected.`

---

### 8. Redux Toolkit Query (`createApi`/`injectEndpoints`) was completely
    unrecognized — 0 client calls detected in a real, working app

**Symptom:** `parseTsClientCallSites` returned **0** call sites for
`bradtraversy/proshop-v2`'s frontend — a real, shipped MERN app whose
entire data layer (~23 endpoints across 4 slice files) is built on RTK
Query. The tool had no visibility into the client side of the app at all.

**Root cause:** RTK Query endpoints are declared as
`createApi({ endpoints: (builder) => ({ login: builder.mutation({ query:
(data) => ({ url, method, body }) }), getUsers: builder.query({ query: ()
=> USERS_URL }), ... }) })`. Nothing in `tryExtractCallSite` recognized
`builder.query(...)`/`builder.mutation(...)` — a completely different
call shape from axios/fetch/react-query, with the actual URL/method
buried inside a callback's return value (either an object literal or a
bare string/template), which itself may be a concise arrow body, a block
body with an explicit `return`, or wrapped in the disambiguating parens
TS adds for `() => ({...})`.

**Fix:** added a new branch matching `builder.query(...)`/
`builder.mutation(...)` calls, plus two small helpers:
`extractQueryFunctionReturnExpression()` (pulls the returned expression
out of any of the three function-body shapes above) and
`unwrapParenthesized()` (strips the `() => ({...})` wrapping parens).
Method defaults to `GET` for `.query()` and `POST` for `.mutation()` per
RTK Query convention, overridden by an explicit `method:` property when
present. Tagged with a new `"rtk-query"` framework label (extended
`ClientFramework` in `types.ts` — purely a display label, doesn't affect
matching logic).

**Verified on:** `bradtraversy/proshop-v2` — went from 0 to 23 correctly
method/path-extracted client calls across all four `*ApiSlice.js` files.

---

### 9. Express's chained route-builder form (`router.route(path).get(a).put(b)`)
    was completely invisible

**Symptom:** After fix #8 surfaced proshop-v2's 23 real client calls, 16
of them came back as false `unresolved-route` — including several where
the note literally said "no server handler exists for PUT at all",
despite the backend definitely having real PUT handlers.

**Root cause:** `userRoutes.js`, `orderRoutes.js`, and `productRoutes.js`
all group their methods with Express's officially-documented chained
form — `router.route('/:id').delete(admin, del).get(admin, getOne).put(admin,
update)` — rather than repeating the path on separate `router.put(path,
fn)` calls. The server-parser's handler branch required `node.arguments[0]`
to be a string literal; on `.put(admin, update)`, the "path" argument slot
is actually a middleware function, so the branch silently produced
nothing for the entire chain, and the `.route('/:id')` call itself
matched neither the direct-path form (no string as the *first and only*
meaningful arg pattern it expected) nor the Fastify object-literal
`.route({...})` form added in fix #5.

**Fix:** added `findRouteCallPath()`, which — when a `.method(...)` call's
first argument isn't a path string — walks back down through
`node.expression.expression` (peeling off `.get(...)`/`.put(...)`/etc.
links one at a time) until it either bottoms out at a `.route(<string
literal>)` call, in which case that string is the shared path, or hits
something else, in which case it's genuinely not this pattern and nothing
is emitted. Handles any number of chained methods, in any order, per the
existing one-file-scope-only precedent in the codebase.

**Verified on:** `bradtraversy/proshop-v2` — server handler count went
from 15 to the correct 26 (11 previously-invisible chained methods now
found, all with the right path), and the full client+server scan for the
whole repo dropped from 16 false notes to a clean `No breaking API
driftguard detected.`

---

## Known limitation (found, not fixed)

### Local `let`/`var` URL bindings aren't traced

**Symptom:** 
```js
var url = "http://localhost:5000/order/update/" + changeOrder.id
axios.put(url, newOrder)
```
resolves to a fully dynamic `__DYN__` path instead of
`/order/update/__DYN__`, even though the concatenation is immediately
visible and never reassigned before use.

**Root cause:** `resolveIdentifierBinding` (`src/client-parser.ts`) — via
`findLocalConstInitializer` — only traces `const` declarations. This is
intentional existing policy, not an oversight: a `let`/`var` binding isn't
provably still holding its initializer value at the call site without
control-flow analysis (has it been reassigned between declaration and
use?), and the project's stated bias throughout is "partial resolution
that fails safe into unverifiable is preferable to guessing."

**Why not fixed here:** extending this safely means proving
no-reassignment-before-use, which is real control-flow analysis — a much
larger, riskier change than the six fixes above. Flagging it rather than
rushing a shortcut that could produce wrong matches instead of missed ones.

**Seen on:** `nlatham1999/GoApp` (Go + React) — 5 client call sites built
their URL via `var url = "..." + id` and lost route matching entirely as
a result.

---

## Suggested next steps
