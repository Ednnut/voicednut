# CALL-E Controlled Pilot Runbook

**Current readiness: NO-GO.** This runbook prepares a future pilot; it does not authorize a call or enable provider access. CALL-E outbound dispatch is not routed in VOICEDNUT. `CALLE_ENABLED` remains `false` and `CALLE_ALLOWED_DESTINATIONS` remains empty by default. No API key, test number, template mapping, or account eligibility has been verified for this workspace.

## Readiness gates

Do not schedule or submit a pilot until every item below has an owner and recorded evidence.

| Gate | Evidence required | Current state |
|---|---|---|
| Template | Sanitized deployment snapshot reviewed against CALL-E Calls V2; one immutable VOICEDNUT template/version approved; no payment, OTP/digit capture, transfer, or unsupported behavior | **Open:** no sanitized runtime snapshot |
| Provider account | Owner confirms test account/key and test host; supported destination and language confirmed against current CALL-E region docs | **Open:** no account/key check |
| Destination | Explicitly authorized test destination; consent and opt-out evidence; test number is on an exact allowlist in the eventual dispatch service | **Open:** destination not selected |
| Authorization | Named business owner, operator, security reviewer, and written approval for the exact one-call request fingerprint | **Open:** no pilot approval |
| Application controls | A separately reviewed dispatch route that binds template version, destination, task, result schema, and idempotency key; authenticated confirmation carries the exact preview fingerprint; concurrency one; one-call cap; immediate kill switch | **Partial:** admin-provisioned business memberships and authenticated, business-scoped consent/opt-out evidence routes exist. Policy events are append-only and opt-outs remain sticky; evidence is operator supplied and has not been reviewed for a pilot destination. The service enforces exact fingerprint, destination allowlist, and persisted policy checks. Its additive SQLite one-reservation lifetime cap releases only after a known pre-creation provider rejection; unknown acceptance holds it. No authenticated dispatch route connects these controls, and dispatch tenant authorization, confirmation provenance, and route-level kill switch remain open. |
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
3. Deploy the reviewed additive schema and application version in the approved test environment. Verify health, admin auth, rate limit, and that the status route reports provider access disabled/unconfigured, destination allowlist empty, dispatch unavailable, `pilotReady: false`, and the outstanding dispatch tenant authorization, confirmation provenance, pilot evidence review, one-call-cap wiring, and concurrency wiring blockers while `CALLE_ENABLED=false`. Preserve `call_e_pilot_dispatch_guard`, `call_e_contact_policy_events`, and `call_e_business_operator_events` during rollback; never clear a reserved or consumed row to retry an uncertain request. Policy and membership tables contain personal identifiers, so apply the approved SQLite backup and access controls.
4. Review a no-call preview. Verify compatibility, masked destination, and result schema. Confirm the preview action does not submit any provider request.
5. Only after written approval of the exact request, enable the separately reviewed dispatch control for the test environment and enforce the one-call cap. This codebase currently has no dispatch route; do not enable a key or flag expecting a call path to appear.
6. Observe the provider Call ID and local VOICEDNUT ID. Poll/reconcile through the authenticated local-ID route. Stop when result readiness becomes available, unavailable, or not applicable; do not use a completed execution status as a success decision.
7. Have the named reviewer assess the outcome and evidence. Do not update customer records, book services, collect payments, or otherwise commit business actions based solely on CALL-E output.
8. Record only the test outcome, status transitions, sanitized errors, latency, and approved cost evidence. Keep the authorized destination and any transcript out of ordinary logs and this runbook.

## Stop and recovery

- Stop immediately for a mismatched template fingerprint, wrong destination, missing consent evidence, unexpected language/region, duplicate acceptance, invalid result schema, unrecognized event, or unclear call outcome.
- Disable the CALL-E feature switch to prevent new CALL-E API operations. Preserve idempotency and reconciliation rows for investigation; do not drop the additive table during rollback.
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
