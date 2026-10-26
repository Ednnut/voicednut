# CALL-E Controlled Pilot Runbook

**Current readiness: NO-GO.** This runbook prepares a future pilot; it does not authorize a call or enable provider access. A dispatch route exists but is inert by default: `CALLE_ENABLED=false`, `CALLE_DISPATCH_ENABLED=false`, `CALLE_PILOT_READINESS_REVIEWED=false`, approval fields are empty, and `CALLE_ALLOWED_DESTINATIONS` is empty. No API key, test number, template mapping, or account eligibility has been verified for this workspace.

## Readiness gates

Do not schedule or submit a pilot until every item below has an owner and recorded evidence.

| Gate | Evidence required | Current state |
|---|---|---|
| Template | Sanitized deployment snapshot reviewed against CALL-E Calls V2; one immutable VOICEDNUT template/version approved; no payment, OTP/digit capture, transfer, or unsupported behavior | **Open:** no sanitized runtime snapshot |
| Provider account | Owner confirms test account/key and test host; supported destination and language confirmed against current CALL-E region docs | **Open:** no account/key check |
| Destination | Explicitly authorized test destination; consent and opt-out evidence; test number is on an exact allowlist in the dispatch service | **Open:** destination not selected |
| Authorization | Named business owner, operator, security reviewer, and written approval for the exact one-call request fingerprint | **Open:** no pilot approval |
| Application controls | Route binds template version, destination, task, result schema, idempotency key, exact preview approval, authenticated confirmation, concurrency one, one-call cap, independent kill switch | **Implemented in code, not pilot-verified:** dispatch checks both feature flags, a nonexpired exact-fingerprint approval configuration, current business membership, the authenticated operator's matching confirmation, allowlist, and consent/opt-out policy, then uses the durable one-call guard. The Mini App requires a separate explicit action with a charge warning. Approval reference configuration is only a pointer and is not proof of the approval itself. Leave both switches off until all external gates close. |
| Tenant scope | Tenant/business identity and local call ownership enforced for operator actions | **Open:** current reconciliation route is global-admin only |
| Recovery | SQLite backup and integrity check plan, support contact, event reconciliation and provider incident procedure reviewed | **Documented:** production backup still must be performed by the deployment owner before rollout; new policy-event rows contain destination personal data and must be retained/protected |

Previewing a template in the Mini App is a no-call check. The Script Designer status lookup and admin reconciliation endpoint only read existing records and do not create a call. Do not treat either as proof that an account, destination, or live dispatch path is ready.

## Pilot envelope after all gates pass

- Use the CALL-E test host and a test-compatible key. Keep credentials in the approved runtime secret store; do not place them in Mini App configuration, fixtures, or logs.
- Limit the pilot to one explicitly approved local template version and one authorized test destination. Enforce an exact destination allowlist server-side.
- Allow one in-flight call and one total call for the first run. No campaign, queue, schedule, automatic retry, provider fallback, or background redial.
- Persist the exact immutable request fingerprint and idempotency key before dispatch. After timeout or uncertain acceptance, reconcile or replay only the identical request with that key.
- Show the masked destination, template/version, task purpose, result fields, and possible charges in the operator confirmation. Changing any input requires a new preview and authorization.
- Review status, outcome, and result readiness separately. Do not infer success from `status=completed`. Keep provider result/transcript review access limited and do not make downstream business writes from a model result without existing policy and human approval.
- Confirm current region and billing details from [CALL-E regions and languages](https://docs.heycall-e.com/guides/regions-and-languages), [Calls API](https://docs.heycall-e.com/api-reference/calls), and [Billing](https://docs.heycall-e.com/billing) before the approved run.

## Run sequence

1. Confirm all readiness gates with the named owners. Record the exact template version, request fingerprint, approved destination reference, test environment, and one-call cap.
2. Take the deployment owner’s approved SQLite online backup. Verify it with `PRAGMA integrity_check`; record backup location and restore owner without copying customer data into this document.
3. Deploy the reviewed additive schema and application version in the approved test environment. Verify health, admin auth, rate limit, and that status reports both switches off, approval absent, provider access disabled/unconfigured, allowlist empty, and `pilotReady: false`. Preserve `call_e_pilot_dispatch_guard`, `call_e_contact_policy_events`, `call_e_business_operator_events`, and `call_e_operator_confirmation_events` during rollback; never clear a reserved or consumed row to retry an uncertain request. Policy, membership, and confirmation tables contain personal identifiers, so apply the approved SQLite backup and access controls.
4. Review a no-call preview. Verify compatibility, masked destination, and result schema. Confirm the preview action does not submit any provider request.
5. Only after all written approvals and external readiness gates are reviewed, configure the exact approved fingerprint, opaque approval reference, and expiry in the approved secret/configuration store; set `CALLE_PILOT_READINESS_REVIEWED=true` only after account, destination, consent, and recovery reviews. Enable `CALLE_ENABLED` and `CALLE_DISPATCH_ENABLED` only in the approved test environment. Verify the exact destination is allowlisted and the operator has confirmed the exact preview. The dispatch kill switch can be turned off independently to stop new dispatch requests.
6. Observe the provider Call ID and local VOICEDNUT ID. Poll/reconcile through the authenticated local-ID route. Stop when result readiness becomes available, unavailable, or not applicable; do not use a completed execution status as a success decision.
7. Have the named reviewer assess the outcome and evidence. Do not update customer records, book services, collect payments, or otherwise commit business actions based solely on CALL-E output.
8. Record only the test outcome, status transitions, sanitized errors, latency, and approved cost evidence. Keep the authorized destination and any transcript out of ordinary logs and this runbook.

## Stop and recovery

- Stop immediately for a mismatched template fingerprint, wrong destination, missing consent evidence, unexpected language/region, duplicate acceptance, invalid result schema, unrecognized event, or unclear call outcome.
- Disable `CALLE_DISPATCH_ENABLED` immediately to prevent new dispatches; disable `CALLE_ENABLED` to block all CALL-E API operations. Preserve idempotency, reconciliation, confirmation, and pilot guard rows for investigation; do not clear an unresolved reservation or drop additive tables during rollback.
- On uncertain acceptance, do not create a new idempotency key or switch providers. Reconcile the existing local Call. CALL-E cancel only applies before provider submission and cannot end an active call; use the provider’s documented support/control path for active-call incidents.
- Roll back the application version if needed while retaining the additive table. Restore the pre-deployment backup only for confirmed corruption after preserving the failed database and reviewing writes since the backup.
- Notify the business owner and security reviewer. Resume only after the cause is understood and the affected request is explicitly reauthorized.

## Approval record for a future pilot

Complete this record outside source control before any live test:

- Business owner and written approval reference:
- Security reviewer:
- Operator:
- Test environment and CALL-E host:
- Approved template ID/version and fingerprint:
- Authorized destination reference and consent evidence:
- Region/language:
- One-call limit and spend limit:
- Backup verification and recovery owner:
- Support/escalation contact:
- Approval date and expiry:
