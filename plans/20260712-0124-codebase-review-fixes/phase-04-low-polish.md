# Phase 4 — Low Polish (Optional)

**Date:** 2026-07-12
**Priority:** LOW
**Status:** planning (optional / defer)
**Issues:** 32-50 (naming, YAGNI stubs, debug file perms, error context, docs)

## Context Links

- Master plan: [plan.md](./plan.md)
- Previous: [phase-03-medium-quality.md](./phase-03-medium-quality.md)

## Overview

These are cosmetic and minor maintainability issues with no security,
availability, or correctness impact. They can be deferred indefinitely.
This phase is included for completeness but should not block any release.
Pick items opportunistically when touching the relevant code.

## Key Insights

The LOW issues (32-50) fall into these categories:

1. **Naming conventions:** Some functions use inconsistent casing or
   abbreviations (e.g. `clientName2` in protobuf mapping). Not worth
   renaming if it would diverge from the upstream proto field names.
2. **YAGNI stubs:** Dead code or unused helper functions that were
   written speculatively. Remove if confirmed unused.
3. **Debug file permissions:** Debug log files (when `GLM_PROXY_DEBUG` is
   set) may be created with default umask. Could be mode 600. Low impact
   since debug is opt-in and local.
4. **Error context:** Some error messages lack enough context to diagnose
   (e.g. "Invalid JSON body" without the raw body snippet). Add truncated
   context to error logs.
5. **Documentation gaps:** Minor doc/comment inaccuracies not covered by
   issue 26 (VISION_MODEL).

## Requirements

- R1: No behavior changes.
- R2: No new dependencies.
- R3: Each item is independently shippable.

## Architecture

No architectural changes. Each item is a small, isolated edit.

## Related Code Files

- `proxy/glm-proxy.js` — debug logging, error context
- `proxy/windsurf-provider.js` — naming, unused exports
- `proxy/windsurf-server.js` — error messages
- `docs/` — minor doc fixes

## Implementation Steps

Since this phase is optional, steps are not enumerated in detail. When
picking up an item:

1. Identify the specific LOW issue number from the review.
2. Make the minimal isolated change.
3. Verify no behavior change via a test request.
4. Commit independently.

## Todo

- [ ] 4.1 Triage LOW issues 32-50 into "do" vs "skip" (most likely skip)
- [ ] 4.2 (Optional) Remove confirmed-unused YAGNI stubs
- [ ] 4.3 (Optional) Add mode 600 to debug log files
- [ ] 4.4 (Optional) Improve error message context in proxy error paths
- [ ] 4.5 (Optional) Fix minor doc inaccuracies

## Success Criteria

- No regressions introduced.
- Each item independently revertable.

## Risk Assessment

- **Very low.** These are cosmetic changes. Main risk is introducing a
  typo or accidental behavior change during edits. Mitigation: test after
  each change.

## Security Considerations

- Debug file permissions (issue category 3) has minor security value
  (prevents other local users from reading debug logs that may contain
  request content). Worth doing if debug mode is used in shared
  environments.

## Next Steps

- None. This is the final phase. If skipped, no follow-up required.
- All security, availability, and correctness issues are resolved by
  Phases 1-3.
