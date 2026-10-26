# Phase 3 — Provider and template abstractions

Date: 2026-10-25  
Status: implemented first provider-dispatch and template-execution boundary.

## Implemented

Added a normalized call-template execution context in `api/adapters/templateExecution.js`. It records:

- local template ID and pinned version (or marks a call as inline);
- selected provider and requested call flow;
- a SHA-256 configuration fingerprint over relevant call-template configuration fields;
- optional provider resource ID, compatibility status, deployment status, and fallback provider fields for later mappings.

Outbound and inbound calls now attach this context to their in-memory call configuration and existing call-runtime state snapshots. Context is carried through call setup, persisted call configuration, call-created state, and hydration. Unknown mappings are explicitly represented as `unassessed`/`unmapped`; the change does not imply Vapi compatibility or synchronization.

Outbound call creation and provider call termination now use a small `VoiceProviderRegistry` contract. Twilio, Plivo, and Vonage adapters preserve their existing provider-specific request builders, identifiers, and lifecycle calls; capability checks still come from `providerFlowPolicy`.

The existing `providerFlowPolicy` remains the capability source for Twilio, Plivo, and Vonage flow compatibility. Existing keypad requirements and provider filtering remain in their existing code path.

## Preserved

- Existing provider selection, readiness, keypad gating, retries/failover, call creation, idempotency, and provider-specific metadata remain unchanged.
- Call templates remain stored and governed by `call_templates` and `call_template_versions`.
- No database schema migration, provider resource creation, live call, or provider switch was performed.

## Files changed

- `api/adapters/templateExecution.js` — normalized execution-context builder and stable configuration fingerprint.
- `api/adapters/voiceProviderRegistry.js` — normalized provider creation/termination contract.
- `api/app.js` — use provider registry and attach context to outbound and inbound call config/state.
- `api/__tests__/templateExecution.test.js` and `api/__tests__/voiceProviderRegistry.test.js` — focused contract tests.

## Verification

- Focused tests: 8 passing.
- Full API suite: 133 passing.
- `node --check` passed for the changed JavaScript files.
- `git diff --check` passed before the inbound-context follow-up; a final diff check is pending.

The dependency install initially skipped sqlite3's native install script, so the full API suite could not load SQLite. After allowing and rebuilding the already-locked `sqlite3@5.1.7` binding in the local environment, the suite passed. No `allowScripts` configuration was retained in `api/package.json`.

## Boundary and outstanding verification

This phase does not create provider mappings or migrate template records. The runtime database and deployment export were not available, so live template compatibility and production mappings remain unassessed. AWS-related call execution remains outside the current registry operations because this path did not establish an AWS outbound/termination adapter contract. These are inputs for later provider expansion, not grounds to infer compatibility.
