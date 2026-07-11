# Phase 3 — Medium Quality Fixes

**Date:** 2026-07-12
**Priority:** MEDIUM
**Status:** planning
**Issues:** 18-31 (DRY/KISS refactors, validation, correctness bugs, test robustness, shell injection in heredoc, CI-blocking read)

## Context Links

- Master plan: [plan.md](./plan.md)
- Previous: [phase-02-high-availability.md](./phase-02-high-availability.md)
- Next: [phase-04-low-polish.md](./phase-04-low-polish.md)

## Overview

These are code-quality and correctness issues that don't affect security or
availability but harm maintainability and correctness. Includes eliminating
duplicated sanitization logic (DRY), splitting a 170-line function (KISS),
tightening a fragile fallback tool-call parser, adding request validation,
fixing a hardcoded model in SSE, fixing an inverted stream default, fixing
a silent model fallback, resolving a comment mismatch, parameterizing
hardcoded ports, making tests robust, and fixing shell injection in a
Python heredoc plus a CI-blocking interactive read.

## Key Insights

1. **Duplicated sanitization (issue 18):** `glm-proxy.js:72-243`
   (`rewriteSystemPrompt`) and `glm-proxy.js:865-914` (inline in message
   map) contain near-identical security-phrase stripping regex sets. DRY:
   extract `sanitizeText(text)` shared function.
2. **rewriteSystemPrompt too long (issue 19):** 170+ lines doing billing
   header removal, identity rewrite, security stripping, imperative
   softening, code-intelligence dedup, and truncation. KISS: split into
   named sub-functions (`stripBillingHeaders`, `rewriteIdentity`,
   `stripSecurityPhrases`, `softenImperatives`, `dedupCodeIntel`,
   `truncateIfNeeded`).
3. **Fragile fallback tool parser (issue 20):** `glm-proxy.js:399-463`
   `findFallbackToolCalls` uses nested regex to detect function-call style
   `bash(command="...")`. This causes false positives on natural language.
   Fix: require a `<tool_use>` marker to be present before attempting
   fallback parsing; otherwise return empty.
4. **Missing request validation (issue 21):** `glm-proxy.js:795` and
   `windsurf-server.js:169` don't validate request field types. Fix:
   validate `messages` is array, `model` is string, `stream` is boolean.
5. **No image size/url validation (issue 22):** `windsurf-provider.js:
   214-263` fetches any URL with no size cap and allows http://. Fix: cap
   decoded size (10MB), https-only, reject overly large data URIs. (Partially
   addressed in Phase 1 async refactor; complete here.)
6. **Hardcoded model in SSE (issue 23):** `glm-proxy.js:1204` emits
   `model: "glm-5-2"` in the `message_start` event regardless of actual
   model. Fix: use `upstreamBody.model`.
7. **Inverted stream default (issue 24):** `windsurf-server.js:191` uses
   `body.stream !== false` which defaults to streaming when field is
   absent. OpenAI spec: stream defaults to false. Fix: `body.stream ===
   true`.
8. **Silent unknown model fallback (issue 25):** `windsurf-provider.js:449`
   maps unknown models to index 5 (GLM) silently. Fix: log a warning (or
   throw for strict mode).
9. **VISION_MODEL comment mismatch (issue 26):** `glm-proxy.js:550,798`
   comment says "kimi-k2-7 as eyes" but `VISION_MODEL` default is
   `swe-1-7`. Fix: update comment.
10. **Hardcoded ports in package.json (issue 27):** `package.json:11-12`
    hardcodes 8083/20130/20128. Fix: use env vars via cross-env or document
    env override (npm scripts don't expand env inline; use
    `node ... ${PORT:-8083}` won't work in npm; simplest: read env inside
    the JS files which already happens — just remove hardcoded args and
    rely on env defaults already in the scripts).
11. **Hardcoded test indices (issue 28):** `test_raw_fields.js:47` uses
    `[5,6,7,8]` to select models. Fix: filter by `modelUid` prefix like
    test_promo.js does.
12. **No null check on regex match (issue 29):** `test_promo.js:14` does
    `content.match(...)[1]` which throws if no match. Fix: check + exit
    with message.
13. **Python heredoc injection (issue 30):** `setup.sh:187-193,216-239`
    interpolates shell variables (`$SETTINGS_FILE`, `$API_KEY`) directly
    into a Python heredoc. A path with a single quote breaks the Python.
    Fix: pass via env (`API_KEY="$API_KEY" python3 -c '...'` reading
    `os.environ`).
14. **CI-blocking read (issue 31):** `setup.sh:159` `read -r` blocks
    forever in CI (no tty). Fix: detect `[ -t 0 ]` and skip or use timeout.

## Requirements

- R1: Single `sanitizeText` function; both call sites use it.
- R2: `rewriteSystemPrompt` split into ≤40-line sub-functions.
- R3: `findFallbackToolCalls` only runs when `<tool_use>` marker present.
- R4: Request validation rejects malformed bodies with 400.
- R5: Image fetch rejects http:// and >10MB; data URIs capped at 10MB.
- R6: SSE `message_start` uses actual model from upstream body.
- R7: Stream defaults to false per OpenAI spec.
- R8: Unknown model logs a warning.
- R9: VISION_MODEL comment matches default value.
- R10: package.json scripts don't hardcode ports (rely on env defaults).
- R11: test_raw_fields.js filters by modelUid, not hardcoded indices.
- R12: test_promo.js handles missing regex match gracefully.
- R13: setup.sh passes variables to Python via env, not interpolation.
- R14: setup.sh `read -r` skipped in non-interactive (CI) mode.
- R15: No behavior change on happy path for all refactors.

## Architecture

### Issue 18 — extract sanitizeText

Create `sanitizeText(text)` in glm-proxy.js containing the shared
security-phrase stripping regex set (currently duplicated at lines 865-899
and within rewriteSystemPrompt). Both `rewriteSystemPrompt` and the
message-map sanitization call it. `rewriteSystemPrompt` keeps
identity/billing/truncation logic that is system-prompt-specific.

### Issue 19 — split rewriteSystemPrompt

Break into:
- `stripBillingHeaders(text)`
- `rewriteIdentity(text)`
- `stripSecurityPhrases(text)` → calls `sanitizeText`
- `softenImperatives(text)`
- `dedupCodeIntel(text)`
- `truncateIfNeeded(text)`

`rewriteSystemPrompt` becomes a pipeline calling these in order.

### Issue 30 — env-based Python invocation

Replace:
```bash
python3 -c "
api_key = '$API_KEY'
...
"
```
with:
```bash
API_KEY="$API_KEY" SETTINGS_FILE="$SETTINGS_FILE" GLM_PROXY_PORT="$GLM_PROXY_PORT" python3 -c '
import os
api_key = os.environ["API_KEY"]
settings_file = os.environ["SETTINGS_FILE"]
...
'
```

## Related Code Files

- `proxy/glm-proxy.js` — lines 72-243 (rewriteSystemPrompt), 399-463
  (findFallbackToolCalls), 550,798 (VISION_MODEL comment), 795 (validation),
  865-914 (duplicated sanitization), 928-934 (upstreamBody), 1204 (hardcoded
  model)
- `proxy/windsurf-provider.js` — lines 214-263 (parseOpenAIImage), 449
  (modelNameToIndex fallback)
- `proxy/windsurf-server.js` — lines 169-173 (validation), 191 (stream
  default)
- `package.json` — lines 11-12 (scripts)
- `test_promo.js` — line 14 (null check)
- `test_raw_fields.js` — line 47 (hardcoded indices)
- `scripts/setup.sh` — lines 159 (read -r), 187-193, 216-239 (Python heredoc)

## Implementation Steps

1. **glm-proxy.js — extract sanitizeText (issue 18):** Create function with
   shared regex set; refactor both call sites.
2. **glm-proxy.js — split rewriteSystemPrompt (issue 19):** Break into
   sub-functions; compose in main function. Verify output identical via
   diff of before/after on a sample system prompt.
3. **glm-proxy.js — findFallbackToolCalls guard (issue 20):** Early return
   `[]` if `!/<tool_use/.test(text) && !/```tool/.test(text)`.
4. **glm-proxy.js — request validation (issue 21a):** Validate
   `parsed.messages` is array, `parsed.model` is string before processing.
5. **windsurf-server.js — request validation (issue 21b):** Already
   validates messages (line 169); add model string check.
6. **windsurf-provider.js — image validation (issue 22):** Enforce
   https-only, 10MB cap on both data URIs and fetched URLs. (Build on
   Phase 1 async fetch.)
7. **glm-proxy.js — use upstreamBody.model in SSE (issue 23):** Replace
   hardcoded `"glm-5-2"` at line 1204 with `upstreamBody.model`.
8. **windsurf-server.js — fix stream default (issue 24):** Change
   `body.stream !== false` to `body.stream === true`.
9. **windsurf-provider.js — warn on unknown model (issue 25):** In
   `modelNameToIndex`, `console.warn` when falling back to default.
10. **glm-proxy.js — fix VISION_MODEL comment (issue 26):** Update comment
    at lines 550, 798 to say "swe-1-7".
11. **package.json — remove hardcoded ports (issue 27):** Change scripts to
    `node proxy/windsurf-server.js` and `node proxy/glm-proxy.js` (the JS
    files already read env vars / argv with defaults).
12. **test_raw_fields.js — filter by modelUid (issue 28):** Replace
    `[5,6,7,8].forEach` with filter on `modelUid` prefixes.
13. **test_promo.js — null check (issue 29):** Check match result before
    accessing `[1]`; exit with error message if no match.
14. **setup.sh — env-based Python (issue 30):** Rewrite both Python heredoc
    invocations to read from `os.environ`.
15. **setup.sh — non-interactive read (issue 31):** Guard `read -r` with
    `[ -t 0 ] || { warn "Non-interactive, skipping..."; exit 0; }` or
    auto-continue.
16. **Verify:** Run tests, run a streaming + non-streaming request, verify
    sanitization output unchanged on a real Claude Code system prompt.

## Todo

- [ ] 3.1 Extract sanitizeText() from duplicated regex sets
- [ ] 3.2 Refactor rewriteSystemPrompt into sub-functions
- [ ] 3.3 Guard findFallbackToolCalls with tool_use marker check
- [ ] 3.4 Add request type validation in glm-proxy.js
- [ ] 3.5 Add model string validation in windsurf-server.js
- [ ] 3.6 Enforce https-only + 10MB cap in parseOpenAIImage
- [ ] 3.7 Use upstreamBody.model in SSE message_start
- [ ] 3.8 Fix stream default to body.stream === true
- [ ] 3.9 Add warning for unknown model fallback
- [ ] 3.10 Fix VISION_MODEL comment mismatch
- [ ] 3.11 Remove hardcoded ports from package.json scripts
- [ ] 3.12 Filter test_raw_fields.js by modelUid
- [ ] 3.13 Add null check in test_promo.js regex match
- [ ] 3.14 Pass variables to Python via env in setup.sh (2 heredocs)
- [ ] 3.15 Guard read -r for non-interactive mode in setup.sh
- [ ] 3.16 Verify sanitization output unchanged + all tests pass

## Success Criteria

- `git diff` on sanitization output is empty for a sample system prompt
  (before/after refactor produces identical text).
- `rewriteSystemPrompt` and each sub-function are ≤40 lines.
- `findFallbackToolCalls` returns `[]` for text without `<tool_use` or
  ```` ```tool ```` markers.
- Malformed request (messages not array) returns 400.
- http:// image URL rejected; >10MB image rejected.
- SSE `message_start` model field matches requested model.
- Non-streaming request (no `stream` field) returns a single JSON response,
  not an SSE stream.
- Unknown model name produces a warning log.
- test_raw_fields.js runs without hardcoded indices.
- test_promo.js exits with message on missing token (no crash).
- setup.sh Python heredoc works with paths containing single quotes.
- setup.sh does not hang in CI (no tty).

## Risk Assessment

- **sanitizeText extraction (issue 18):** Highest risk in this phase. The
  sanitization logic was binary-search-tuned to pass the Cognition content
  filter. Any subtle regex change can re-trigger filtering. Mitigation:
  extract verbatim, no regex edits; verify with a real Claude Code system
  prompt that previously triggered the filter.
- **Stream default inversion (issue 24):** Changing default from streaming
  to non-streaming may break clients that omit `stream` and expect SSE.
  Claude Code always sends `stream: true` explicitly, so impact is limited,
  but verify no client relies on the old default.
- **findFallbackToolCalls guard (issue 20):** May reduce tool-call
  detection rate if GLM outputs function-call style without the marker.
  Review logs to confirm GLM always uses `<tool_use>` or ```` ```tool ````
  format before tightening.

## Security Considerations

- Issue 30 (Python heredoc injection) is a latent injection risk if
  `SETTINGS_FILE` or `API_KEY` contain quotes/special chars. Fixing it
  closes that vector.
- Issue 22 (image validation) closes an SSRF vector (http:// to internal
  services) and a memory exhaustion vector (large images).

## Next Steps

- Proceed to [Phase 4 — Low Polish](./phase-04-low-polish.md) (optional)
  after all Phase 3 todos are complete and verified.
- Phase 4 is optional and can be deferred indefinitely without affecting
  security or correctness.
