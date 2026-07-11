# Codebase Review Fixes — devin-9router-bridge

**Date:** 2026-07-12
**Status:** complete (Phase 1-3 done, Phase 4 skipped)
**Reviewer:** code-reviewer subagent
**Scope:** Security, availability, and quality fixes from full codebase review

## Overview

The devin-9router-bridge project connects Devin/Cognition models (GLM-5.2) to
Claude Code via 9router. A code review identified 50 issues across 4 severity
tiers. This plan organizes them into 4 phases executed sequentially, with
CRITICAL security fixes first.

## Phases

| # | Phase | Priority | Issues | Status | Progress | File |
|---|-------|----------|--------|--------|----------|------|
| 1 | Critical Security | CRITICAL | 1-7 | done | 100% | [phase-01-critical-security.md](./phase-01-critical-security.md) |
| 2 | High Availability | HIGH | 8-17 | done | 100% | [phase-02-high-availability.md](./phase-02-high-availability.md) |
| 3 | Medium Quality | MEDIUM | 18-31 | done | 100% | [phase-03-medium-quality.md](./phase-03-medium-quality.md) |
| 4 | Low Polish | LOW | 32-50 | skipped | 0% | [phase-04-low-polish.md](./phase-04-low-polish.md) |

## Execution Order

Phases MUST be executed in order. Each phase depends on the previous one
being merged. Within a phase, issues are independent and may be done in
parallel, except where noted.

1. **Phase 1 (CRITICAL)** — Block all merges until complete. These are
   exploitable security vulnerabilities (command injection, SSL bypass,
   placeholder secrets, unsafe shell).
2. **Phase 2 (HIGH)** — Availability and robustness. DoS protection,
   resource cleanup, timeouts, secret leakage prevention.
3. **Phase 3 (MEDIUM)** — Code quality. DRY/KISS refactors, validation,
   correctness bugs. No behavior change for happy path.
4. **Phase 4 (LOW)** — Optional polish. Naming, docs, debug perms.

## Key Files Affected

- `proxy/windsurf-provider.js` — issues 1,2,3,9,10,22,25
- `proxy/windsurf-server.js` — issues 8,11,21,24
- `proxy/glm-proxy.js` — issues 8,10,12,18,19,20,21,23,26
- `scripts/setup.sh` — issues 6,7,13,14,17,30,31
- `scripts/auto-start-windows.ps1` — issues 15,16
- `scripts/auto-start.sh`, `scripts/auto-start-linux.sh` — issues 13,16
- `test_promo.js`, `test_raw_fields.js` — issues 4,5,29,28
- `package.json` — issue 27

## Success Criteria

- All CRITICAL issues fixed and verified (Phase 1)
- All HIGH issues fixed and verified (Phase 2)
- MEDIUM issues fixed without regressions (Phase 3)
- No new lint/compile errors introduced
- Existing happy-path behavior preserved
- Tests pass (once test harness is hardened in Phase 1)

## Risk Notes

- Phase 3 refactors (sanitizeText extraction, rewriteSystemPrompt split)
  touch the content-filter logic which is fragile and binary-search-tuned.
  Must verify filter behavior unchanged via manual testing.
- Removing `rejectUnauthorized:false` (issues 2,5) requires the upstream
  server to have valid certs. Verify server.codeium.com cert is valid.
