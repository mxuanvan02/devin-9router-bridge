# Phase 1 — Critical Security Fixes

**Date:** 2026-07-12
**Priority:** CRITICAL
**Status:** planning
**Issues:** 1-7 (command injection, SSL bypass, blocking I/O, hardcoded paths, placeholder secrets, unsafe shell)

## Context Links

- Master plan: [plan.md](./plan.md)
- Review source: code-reviewer subagent report (2026-07-12)
- Phase 2 (next): [phase-02-high-availability.md](./phase-02-high-availability.md)

## Overview

These are exploitable security vulnerabilities and correctness defects that
MUST be fixed before any further development. They include command injection
via shell interpolation, SSL certificate verification bypass, synchronous
blocking of the event loop, hardcoded absolute paths breaking portability,
placeholder API keys written to user config, and an unsafe shell script that
leaves partial state on failure.

## Key Insights

1. **Command injection (issue 1):** `windsurf-provider.js:235` builds a curl
   command via string interpolation: `execSync(\`curl -sL --max-time 30
   "${url.replace(/"/g, '\\"')}"\`)`. The quote-escaping is bypassable (e.g.
   backticks, `$()`, newlines). A malicious image URL from a client request
   can execute arbitrary shell commands. This is the most severe issue.
2. **SSL bypass (issue 2):** `windsurf-provider.js:500` sets
   `rejectUnauthorized:false`, disabling certificate validation for the
   upstream Devin API. Enables MITM attacks on the session token channel.
3. **Blocking I/O (issue 3):** `execSync` at line 234-235 blocks the entire
   Node.js event loop for up to 30s while fetching images. Combined with
   issue 1, the fix is to replace curl entirely with async `https.get`.
4. **Hardcoded paths (issue 4):** `test_promo.js:7` and
   `test_raw_fields.js:7` hardcode `/Users/van/Projects/devin-9router-bridge/...`.
   Tests fail for any other developer or CI. Fix: `path.join(__dirname, "..",
   "proto", "windsurf.proto")`.
5. **SSL bypass in tests (issue 5):** `test_promo.js:37` and
   `test_raw_fields.js:36` also set `rejectUnauthorized:false`. Remove.
6. **Placeholder API key (issue 6):** `setup.sh:206` writes
   `YOUR_9ROUTER_API_KEY` to `~/.claude/settings.json` when no key is found.
   This silently breaks Claude Code with a confusing auth error. Should fail
   with a clear message instead.
7. **Unsafe shell (issue 7):** `setup.sh:2` uses `set -e` without `pipefail`.
   Piped commands (e.g. `npm install ... | tail -3` at line 106) can hide
   failures. No cleanup trap means partial installs (copied files, started
   processes) remain on early exit. Fix: `set -euo pipefail` + a cleanup trap.

## Requirements

- R1: No shell command construction from user-controlled input (URLs).
- R2: TLS certificate validation enabled for all upstream HTTPS calls.
- R3: No synchronous blocking I/O on the request hot path.
- R4: Tests run successfully on any developer machine (no hardcoded paths).
- R5: setup.sh never writes a placeholder secret to user config files.
- R6: setup.sh fails cleanly on any error, leaving no partial state.
- R7: No new dependencies required (use built-in `https` module).

## Architecture

### Issue 1+3 fix — replace curl with async https.get

`parseOpenAIImage` (windsurf-provider.js:214-263) currently fetches remote
image URLs via `execSync(curl ...)`. Replace with an async helper using
`https.get` (already imported at line 18). Since `parseOpenAIImage` is called
synchronously inside `openAIToWindsurf` message loop, refactor to:
- Make `parseOpenAIImage` async (returns Promise).
- Collect image fetch promises in `openAIToWindsurf`, await with
  `Promise.all` after the loop.
- Cap response size (see Phase 2 issue 22, but add basic guard now).
- Reject non-https URLs (http:// blocked — see issue 22).

### Issue 2 fix — remove SSL bypass

Delete `rejectUnauthorized: false` at windsurf-provider.js:500. The
`https.request` default validates certs. Verify server.codeium.com presents
a valid cert (it does — this bypass was a debugging leftover).

### Issue 6 fix — fail instead of placeholder

In setup.sh:203-207, replace the `API_KEY="YOUR_9ROUTER_API_KEY"` fallback
with `fail "No 9router API key found. Get it from 9router UI and re-run."`.

### Issue 7 fix — safe shell

Change `set -e` to `set -euo pipefail`. Add a cleanup trap that kills
background processes (windsurf-server, glm-proxy PIDs) and removes partial
install dir if setup did not complete.

## Related Code Files

- `proxy/windsurf-provider.js` — lines 214-263 (parseOpenAIImage), 234-235
  (execSync curl), 500 (rejectUnauthorized), 479-519 (sendWindsurfRequest)
- `test_promo.js` — line 7 (PROTO_PATH), line 37 (rejectUnauthorized), line
  14 (null check — see issue 29, defer to Phase 3)
- `test_raw_fields.js` — line 7 (PROTO_PATH), line 36 (rejectUnauthorized)
- `scripts/setup.sh` — line 2 (set -e), 78-80 (key validation — issue 17,
  defer), 106 (piped npm), 127/171 (nohup), 203-207 (placeholder key), 206
  (write to settings.json), 210-213 (backup — issue 14, defer)

## Implementation Steps

1. **windsurf-provider.js — remove SSL bypass (issue 2):** Delete line 500
   `rejectUnauthorized: false,`. Run a test request to confirm cert validates.
2. **windsurf-provider.js — async image fetch (issues 1,3):**
   - Add `fetchImageBuffer(url)` helper using `https.get` with 30s timeout,
     10MB cap, https-only enforcement.
   - Make `parseOpenAIImage` async. For data URIs, resolve synchronously
     (no fetch). For https URLs, await `fetchImageBuffer`.
   - Update `openAIToWindsurf` to collect image promises and `await
     Promise.all` before building the protobuf request.
   - Remove `execSync` require at line 234 (keep line 23 import for
     `tryRefreshDevinToken` — that's a separate concern, Phase 2 issue 3
     scope is only the image fetch).
3. **test_promo.js — fix path + SSL (issues 4,5):**
   - Line 7: `path.join(__dirname, "proto", "windsurf.proto")`.
   - Line 37: remove `rejectUnauthorized: false`.
4. **test_raw_fields.js — fix path + SSL (issues 4,5):**
   - Line 7: `path.join(__dirname, "proto", "windsurf.proto")`.
   - Line 36: remove `rejectUnauthorized: false`.
5. **setup.sh — fail on missing key (issue 6):**
   - Replace lines 203-207 fallback with `fail` call.
6. **setup.sh — safe shell (issue 7):**
   - Line 2: `set -euo pipefail`.
   - Add `trap cleanup EXIT` with cleanup function that kills tracked
     background PIDs and removes partial install if `SETUP_COMPLETE` flag
     is not set.
   - Track PIDs from nohup launches (lines 127, 171).
7. **Verify:** Run `node proxy/windsurf-server.js` + a test request with an
   image URL. Run both test files. Run setup.sh to completion and simulate
   a mid-script failure to verify cleanup.

## Todo

- [ ] 1.1 Remove `rejectUnauthorized:false` from windsurf-provider.js:500
- [ ] 1.2 Replace execSync curl with async https.get in parseOpenAIImage
- [ ] 1.3 Make parseOpenAIImage + openAIToWindsurf async image handling
- [ ] 1.4 Fix PROTO_PATH in test_promo.js (use __dirname)
- [ ] 1.5 Remove rejectUnauthorized in test_promo.js
- [ ] 1.6 Fix PROTO_PATH in test_raw_fields.js (use __dirname)
- [ ] 1.7 Remove rejectUnauthorized in test_raw_fields.js
- [ ] 1.8 Replace placeholder API key fallback with fail() in setup.sh
- [ ] 1.9 Add `set -euo pipefail` to setup.sh
- [ ] 1.10 Add cleanup trap + PID tracking to setup.sh
- [ ] 1.11 Verify all changes with manual test run

## Success Criteria

- `grep -r "execSync.*curl" proxy/` returns no matches.
- `grep -r "rejectUnauthorized.*false" proxy/ test_*.js` returns no matches.
- `grep -r "/Users/van" test_*.js` returns no matches.
- `grep "YOUR_9ROUTER_API_KEY" scripts/setup.sh` returns no matches.
- setup.sh exits non-zero on missing API key (no settings.json write).
- setup.sh cleans up background processes on SIGINT/mid-failure.
- A chat request with an https image URL completes successfully.
- A chat request with an http:// image URL is rejected (deferred to issue 22
  but basic guard added).

## Risk Assessment

- **Removing SSL bypass:** If server.codeium.com cert is expired/invalid,
  all requests fail. Mitigation: verified cert is valid as of 2026-07-11.
  If issues arise, the correct fix is a CA bundle, not disabling validation.
- **Async image refactor:** Changes the signature of `parseOpenAIImage` and
  the control flow of `openAIToWindsurf`. Must ensure data URIs (no fetch)
  still work and that image ordering is preserved in the protobuf. Test with
  both data URI and remote URL inputs.
- **setup.sh pipefail:** `npm install | tail -3` will now exit non-zero if
  npm fails (desired). Verify no legitimate commands rely on pipe swallowing.

## Security Considerations

This phase IS the security fix. Post-fix:
- No arbitrary command execution from client-supplied URLs.
- TLS MITM protection restored on the session-token channel.
- No plaintext placeholder secrets in user config.
- No partial-state installs that could leave stale/insecure config.

## Next Steps

- Proceed to [Phase 2 — High Availability](./phase-02-high-availability.md)
  after all Phase 1 todos are complete and verified.
- Phase 2 will address the 10MB body cap (issue 8) which complements the
  image size cap added here, and the upstream timeout (issue 12) which
  complements the image fetch timeout added here.
