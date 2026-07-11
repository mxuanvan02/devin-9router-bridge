# Phase 2 — High Availability Fixes

**Date:** 2026-07-12
**Priority:** HIGH
**Status:** planning
**Issues:** 8-17 (DoS, resource leaks, silent catches, CORS, timeouts, secret leakage, backup cleanup, restart limits, hardcoded ports, key validation)

## Context Links

- Master plan: [plan.md](./plan.md)
- Previous: [phase-01-critical-security.md](./phase-01-critical-security.md)
- Next: [phase-03-medium-quality.md](./phase-03-medium-quality.md)

## Overview

These issues affect availability, robustness, and operational safety. They
won't be exploited like the CRITICAL issues, but they cause resource
exhaustion (unbounded memory), leaked secrets in world-readable logs,
hung connections with no timeout, silent error swallowing, and overly
permissive CORS. Also includes auto-start restart-loop and hardcoded port
fixes.

## Key Insights

1. **Unbounded body accumulation (issue 8):** `windsurf-server.js:75` and
   `glm-proxy.js:791` accumulate request bodies in a string with no size
   limit. A malicious or buggy client can exhaust memory. Fix: cap at 10MB,
   respond 413 on overflow.
2. **File watcher leak (issue 9):** `windsurf-provider.js:150-174` creates
   an `fs.watch` on the credentials file at module load but never closes it.
   On SIGTERM the watcher leaks. On `rename` events (common during atomic
   writes), the watcher may stop firing on some platforms. Fix: close on
   SIGTERM, re-create on rename.
3. **Silent catches (issue 10):** Six `catch {}` blocks swallow errors with
   no logging: `windsurf-provider.js:646,659,716`; `glm-proxy.js:1371,1469,
   1612`. Makes debugging impossible. Fix: log `e.message` at debug level.
4. **CORS wildcard on auth endpoint (issue 11):** `windsurf-server.js:95-98`
   sets `Access-Control-Allow-Origin: *` on all responses including the
   chat completions endpoint which carries the Devin session token. Fix:
   restrict to localhost origins (127.0.0.1, localhost).
5. **No upstream timeout (issue 12):** `glm-proxy.js:938` and
   `windsurf-provider.js:504` make upstream requests with no timeout. A
   hung upstream hangs the client indefinitely. Fix: 120s timeout with
   abort + error response.
6. **Secret leakage in logs (issue 13):** `setup.sh:127,171` and auto-start
   scripts write logs to `/tmp` which is world-readable. Logs may contain
   tokens/errors with secrets. Fix: `~/.devin-9router-bridge/logs/` with
   `chmod 700`.
7. **No backup cleanup (issue 14):** `setup.sh:210-213` creates a timestamped
   backup of settings.json on every run with no rotation. Fix: keep 3 most
   recent, delete older.
8. **Restart loop (issue 15):** `auto-start-windows.ps1:35-36` sets
   `RestartCount 999` with 1-min interval. A crash-looping process hammers
   the system. Fix: RestartCount 3, 5-min interval.
9. **Hardcoded ports in auto-start (issue 16):** All auto-start scripts
   hardcode ports 20130/20128/8083. Fix: read from env vars with defaults.
10. **No API key validation (issue 17):** `setup.sh:78-80` only checks that
    `windsurf_api_key` appears in the file, not that it's non-empty. Fix:
    `grep -qE 'windsurf_api_key\s*=\s*"[^"]+"'`.

## Requirements

- R1: Request bodies capped at 10MB; 413 response on overflow.
- R2: File watcher closed on SIGTERM/SIGINT; re-created on rename events.
- R3: All catch blocks log error messages (no silent swallowing).
- R4: CORS restricted to localhost origins only.
- R5: All upstream HTTP requests have a 120s timeout.
- R6: Logs written to `~/.devin-9router-bridge/logs/` (mode 700), not /tmp.
- R7: settings.json backups rotated to 3 most recent.
- R8: Auto-start restart limit: 3 attempts, 5-min interval.
- R9: Auto-start scripts read ports from env vars with defaults.
- R10: setup.sh validates API key is non-empty (quoted value present).

## Architecture

### Issue 8 — body cap

Add `MAX_BODY_BYTES = 10 * 1024 * 1024` constant. In `parseBody`
(windsurf-server.js:72) and the glm-proxy.js:791 body handler, track
accumulated size; on overflow, destroy the request and respond 413.

### Issue 9 — watcher cleanup

In windsurf-provider.js, wrap watcher setup in a function. Register
`process.on("SIGTERM"/"SIGINT", () => _fileWatcher?.close())`. On `rename`
event, close and re-create the watcher (some platforms invalidate the
watcher handle on rename).

### Issue 10 — log silent catches

Replace `catch {}` with `catch (e) { console.error("[module] ...: " +
e.message); }` at the 6 identified sites. Keep behavior identical, just
add logging.

### Issue 11 — CORS restriction

In windsurf-server.js `sendJSON` and `sendSSEStream`, replace
`Access-Control-Allow-Origin: *` with origin check: only emit the header
if `req.headers.origin` is `http://127.0.0.1:*` or `http://localhost:*`.

### Issue 12 — upstream timeout

For `https.request` in windsurf-provider.js:504 and `http.request` in
glm-proxy.js:938, add `req.setTimeout(120000, () => req.destroy(new
Error("upstream timeout")))`. On timeout, respond 504 to client.

### Issue 13 — secure logs

All auto-start scripts and setup.sh: replace `/tmp/*.log` with
`$HOME/.devin-9router-bridge/logs/*.log`. Add `mkdir -p ... && chmod 700`
in setup.sh install step.

### Issue 14 — backup rotation

After creating a new settings.json backup, list existing `.bak.*` files,
sort by timestamp descending, delete all but the 3 newest.

### Issue 15 — restart limits

auto-start-windows.ps1: `RestartCount 3`, `RestartInterval (New-TimeSpan
-Minutes 5)`.

### Issue 16 — env ports

auto-start scripts: read `${GLM_PROXY_PORT:-20130}`, `${ROUTER_PORT:-20128}`,
`${WINDSURF_PORT:-8083}` (bash) / `$env:GLM_PROXY_PORT` (PowerShell).

### Issue 17 — key validation

setup.sh:78: `grep -qE 'windsurf_api_key\s*=\s*"[^"]+"' "$CRED_FILE"`.

## Related Code Files

- `proxy/windsurf-server.js` — lines 72-86 (parseBody), 91-100 (sendJSON
  CORS), 105-122 (sendSSEStream CORS), 127-134 (OPTIONS CORS), 169
  (validation — issue 21, defer)
- `proxy/glm-proxy.js` — lines 791-793 (body accumulation), 938-958
  (upstream request), 1371,1469,1612 (silent catches)
- `proxy/windsurf-provider.js` — lines 150-174 (file watcher), 504
  (upstream request), 646,659,716 (silent catches)
- `scripts/setup.sh` — lines 78-80 (key check), 127,171 (nohup logs), 210-213
  (backups)
- `scripts/auto-start-windows.ps1` — lines 27,35-36 (ports, restart)
- `scripts/auto-start.sh` — lines 23-24,31-33 (ports, logs)
- `scripts/auto-start-linux.sh` — lines 22,25-26 (ports, logs)

## Implementation Steps

1. **windsurf-server.js — body cap (issue 8a):** Add size tracking in
   `parseBody`, respond 413 on overflow.
2. **glm-proxy.js — body cap (issue 8b):** Add size tracking in the
   `/v1/messages` body handler (line 791).
3. **windsurf-provider.js — watcher cleanup (issue 9):** Refactor
   `startCredentialWatcher` to be re-callable; add SIGTERM/SIGINT handlers;
   re-create on rename.
4. **Log silent catches (issue 10):** Add `console.error` in all 6 catch
   blocks across windsurf-provider.js and glm-proxy.js.
5. **windsurf-server.js — CORS restriction (issue 11):** Add localhost
   origin check helper; use in sendJSON, sendSSEStream, OPTIONS handler.
6. **Upstream timeouts (issue 12):** Add 120s `setTimeout` + abort in
   windsurf-provider.js:504 and glm-proxy.js:938.
7. **Secure logs (issue 13):** Update setup.sh and all 3 auto-start scripts
   to use `~/.devin-9router-bridge/logs/` with chmod 700.
8. **Backup rotation (issue 14):** Add cleanup logic after backup creation
   in setup.sh.
9. **Windows restart limits (issue 15):** Update
   auto-start-windows.ps1 RestartCount/Interval.
10. **Env ports in auto-start (issue 16):** Parameterize all auto-start
    scripts with env var defaults.
11. **Key validation (issue 17):** Strengthen grep in setup.sh:78.
12. **Verify:** Test large body rejection, watcher cleanup on SIGTERM,
    timeout behavior with a slow upstream, log directory permissions.

## Todo

- [ ] 2.1 Add 10MB body cap + 413 in windsurf-server.js parseBody
- [ ] 2.2 Add 10MB body cap + 413 in glm-proxy.js body handler
- [ ] 2.3 Refactor file watcher for cleanup + rename re-create
- [ ] 2.4 Add SIGTERM/SIGINT handler to close watcher
- [ ] 2.5 Log errors in 6 silent catch blocks (windsurf-provider.js)
- [ ] 2.6 Log errors in 3 silent catch blocks (glm-proxy.js)
- [ ] 2.7 Restrict CORS to localhost origins in windsurf-server.js
- [ ] 2.8 Add 120s upstream timeout in windsurf-provider.js
- [ ] 2.9 Add 120s upstream timeout in glm-proxy.js
- [ ] 2.10 Move logs to ~/.devin-9router-bridge/logs/ (chmod 700) in setup.sh
- [ ] 2.11 Move logs in auto-start.sh (macOS)
- [ ] 2.12 Move logs in auto-start-linux.sh
- [ ] 2.13 Move logs in auto-start-windows.ps1
- [ ] 2.14 Add backup rotation (keep 3) in setup.sh
- [ ] 2.15 Fix RestartCount 3 + 5min interval in auto-start-windows.ps1
- [ ] 2.16 Parameterize ports via env in all auto-start scripts
- [ ] 2.17 Strengthen API key validation grep in setup.sh
- [ ] 2.18 Verify all changes

## Success Criteria

- Sending a >10MB body to either proxy returns 413, no crash.
- `kill -TERM` on windsurf-server closes the file watcher (verify via
  `lsof` showing no remaining watch handles).
- All catch blocks produce log output on error.
- CORS header absent for non-localhost origins.
- Upstream request that hangs >120s returns 504 to client.
- `ls -la ~/.devin-9router-bridge/logs/` shows mode 700.
- No more than 3 `.bak.*` files exist after multiple setup.sh runs.
- Windows scheduled task shows RestartCount=3, Interval=5min.
- Auto-start scripts honor `GLM_PROXY_PORT` env var override.
- setup.sh rejects an empty `windsurf_api_key = ""` in credentials.toml.

## Risk Assessment

- **Body cap:** 10MB may reject legitimate large requests (e.g. big code
  context). 10MB is generous for chat; monitor and adjust if needed.
- **CORS restriction:** If 9router runs on a non-localhost interface, it
  will be blocked. The architecture assumes localhost-only; verify.
- **Upstream timeout:** 120s may be too short for very long GLM-5.2
  generations with no streaming. Streaming responses send data incrementally
  so the timeout should reset on each chunk — implement as idle timeout, not
  absolute.
- **Watcher re-create on rename:** Some platforms fire rename repeatedly.
  Add debounce to avoid watcher churn.

## Security Considerations

- Secure log directory prevents token leakage to other local users.
- CORS restriction prevents cross-origin abuse of the authenticated
  endpoint by malicious web pages.
- Body cap prevents memory-exhaustion DoS.
- Timeout prevents resource exhaustion from hung upstreams.

## Next Steps

- Proceed to [Phase 3 — Medium Quality](./phase-03-medium-quality.md)
  after all Phase 2 todos are complete and verified.
- Phase 3 includes DRY refactors that will touch some of the same catch
  blocks and body handlers modified here — coordinate to avoid conflicts.
