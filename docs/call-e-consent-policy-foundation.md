# CALL-E consent and opt-out policy foundation

Date: 2026-10-26

## Objective and acceptance

Build a no-call policy layer that blocks CALL-E service submission unless consent evidence is current for the pinned template's business and exact destination. A stored opt-out must block the destination regardless of later consent events. The policy layer must not claim that an evidence reference itself proves legally sufficient consent.

## Implementation

- Added `api/services/callEContactPolicyService.js` to validate business scope, E.164 destination, event idempotency key, source, timestamps, and opaque evidence references.
- Added append-only `call_e_contact_policy_events` persistence with business/destination/event indexes and event-key conflict detection. It stores destination phone numbers and is therefore personal data.
- Added eligibility evaluation for the most recent consent event, including future-dated and expired evidence. Any opt-out event blocks eligibility; no clear-opt-out API exists.
- Updated CALL-E outbound service checks to require a pinned `business_id`, current evidence, and non-opted-out destination before it reserves the dispatch slot or idempotency record.
- Added append-only `call_e_business_operator_events` grants/revocations provisioned through admin-token-protected routes. Evidence writes require a Mini App session with `provider_manage` plus a current `policy_manager` membership for the template's server-derived business ID.
- Added consent and opt-out evidence routes. They derive `business_id` from the template, take the actor from the authenticated Mini App session, reject extra client fields, and return no destination or evidence reference. This is operator-entered evidence, not independent verification or proof of legal sufficiency; recipient self-service opt-out is not provided.
- Added `recorded_by_telegram_id` to policy rows, with an idempotent additive migration for existing policy tables. Status now reports pilot evidence review as an outstanding gate while dispatch tenant authorization remains unwired.

## Compatibility, privacy, and recovery

The schema change is additive and initialized with `CREATE TABLE IF NOT EXISTS`; older application versions ignore the table. The API tolerates an empty policy table and denies CALL-E service submission when evidence is missing. Roll back application code while preserving policy rows. Do not drop the table as part of rollback. Production use requires an approved SQLite backup/integrity check, access-control review, encryption-at-rest confirmation, and documented retention/deletion policy. No production database was migrated or read.

Consent records are scoped by the template's `business_id`; policy writes require an admin-provisioned membership for that business. This does not independently verify business ownership or the underlying consent evidence. Destination and evidence metadata must not be logged or surfaced in generic status responses. An evidence reference is an operator-supplied pointer, not independent proof of consent. Membership and policy event rows are append-only; preserve them during rollback.

## Verification

- `cd api && ./node_modules/.bin/mocha __tests__/callEContactPolicyService.test.js __tests__/callEOutboundCallService.test.js __tests__/callEIntegrationRehearsal.test.js __tests__/callEClient.test.js --reporter dot`: **29 passing**.
- `node --check services/callEContactPolicyService.js`, `node --check services/callEOutboundCallService.js`, `node --check db/db.js`, and `git diff --check`: passed.
- Full API suite: **271 passing**, including the new membership, route authorization, actor persistence, and migration coverage.
- Mini App: `npm run validate:prod` passed; `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:e2e` passed (**2 tests**); `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:a11y` passed (**1 test**).
- All CALL-E provider calls in these checks used stubs. No provider call or production database operation occurred.

## Remaining gates

1. Review operator-submitted consent/opt-out evidence for the approved pilot destination and provide an approved recipient self-service opt-out channel.
2. Add a separately reviewed authenticated CALL-E dispatch route with tenant authorization, confirmation provenance, one-call cap/concurrency wiring, and a route-level kill switch.
3. Complete the sanitized template/account review, approved test destination and consent verification, owner approval, and production recovery review before any pilot.
