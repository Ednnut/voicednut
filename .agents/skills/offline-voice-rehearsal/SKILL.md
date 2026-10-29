---
name: offline-voice-rehearsal
description: Rehearse a VOICEDNUT outbound voice workflow with fake provider responses and temporary persistence, proving lifecycle and duplicate safety without live calls.
---

# Rehearse voice flows without dialing

Use only for an explicitly requested offline rehearsal or when preparing a deterministic provider lifecycle check. Pair with `telephony`; add `testing`, `database`, or `security` when their behavior is in scope. The rehearsal must never contact a provider, use real credentials, or enable dispatch.

## Workflow

1. Inspect root instructions, the worktree, the provider service/client seam, and nearest tests. For the current CALL-E example, use `api/__tests__/callEIntegrationRehearsal.test.js` as the reference; verify it still represents current code before relying on it.
2. Build the rehearsal around an injected fake client and synthetic responses. Use temporary SQLite state where persistence matters. Keep destination values synthetic and provider flags disabled.
3. Cover the lifecycle needed for the task: accepted or queued state, exact idempotent replay, changed-request conflict, duplicate event delivery, pending/terminal/result-ready states, timeout or uncertain acceptance, and sensitive-content redaction. Skip cases unrelated to the provider contract.
4. Assert both positive outcomes and safety invariants: one fake mutation for a replay, no fresh operation after uncertain acceptance, tenant/business scope retained, and no transcript/result or secret content persisted or returned unless the product explicitly requires an approved representation.
5. Run only the focused offline test or command that the user requested. Confirm network access remains stubbed and generated temporary data is removed.
6. Report the exact fake-provider behavior exercised, persistence inspected, command/result, and explicitly state that no live call or external provider operation occurred.

## Rehearsal reference

Use [rehearsal-checklist.md](references/rehearsal-checklist.md) to scope the lifecycle and safety assertions. It supplements, rather than replaces, current provider documentation and the owning service's contract.
