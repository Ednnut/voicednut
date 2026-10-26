# CALL-E consent and opt-out policy foundation

Date: 2026-10-26

## Objective and acceptance

Build a no-call policy layer that blocks CALL-E service submission unless consent evidence is current for the pinned template's business and exact destination. A stored opt-out must block the destination regardless of later consent events. The policy layer must not claim that an evidence reference itself proves legally sufficient consent.

## Implementation

- Added `api/services/callEContactPolicyService.js` to validate business scope, E.164 destination, event idempotency key, source, timestamps, and opaque evidence references.
- Added append-only `call_e_contact_policy_events` persistence with business/destination/event indexes and event-key conflict detection. It stores destination phone numbers and is therefore personal data.
- Added eligibility evaluation for the most recent consent event, including future-dated and expired evidence. Any opt-out event blocks eligibility; no clear-opt-out API exists.
- Updated CALL-E outbound service checks to require a pinned `business_id`, current evidence, and non-opted-out destination before it reserves the dispatch slot or idempotency record.
- Kept evidence ingestion unrouted. The current admin token and Mini App capability model do not establish a business-scoped operator identity. Status now reports consent evidence ingestion as an outstanding launch gate.

## Compatibility, privacy, and recovery

The schema change is additive and initialized with `CREATE TABLE IF NOT EXISTS`; older application versions ignore the table. The API tolerates an empty policy table and denies CALL-E service submission when evidence is missing. Roll back application code while preserving policy rows. Do not drop the table as part of rollback. Production use requires an approved SQLite backup/integrity check, access-control review, encryption-at-rest confirmation, and documented retention/deletion policy. No production database was migrated or read.

Consent records are scoped by the template's `business_id`, but this is data partitioning only. The application does not verify that an operator owns that business. Destination and evidence metadata must not be logged or surfaced in generic status responses. An evidence reference is an operator-supplied pointer, not independent proof of consent.

## Verification

- `cd api && ./node_modules/.bin/mocha __tests__/callEContactPolicyService.test.js __tests__/callEOutboundCallService.test.js __tests__/callEIntegrationRehearsal.test.js __tests__/callEClient.test.js --reporter dot`: **29 passing**.
- `node --check services/callEContactPolicyService.js`, `node --check services/callEOutboundCallService.js`, `node --check db/db.js`, and `git diff --check`: passed.
- Full API suite: **265 passing**.
- Mini App: `npm run validate:prod` passed; `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:e2e` passed (**2 tests**); `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:a11y` passed (**1 test**).
- All CALL-E provider calls in these checks used stubs. No provider call or production database operation occurred.

## Remaining gates

1. Add a business-scoped operator identity and authorization check before exposing consent/opt-out evidence ingestion.
2. Add verified evidence capture and a controlled, auditable route for recording recipient opt-outs.
3. Connect the policy checks to the separately reviewed authenticated CALL-E dispatch route and pilot kill switch.
4. Complete the sanitized template/account review, approved test destination and consent verification, owner approval, and production recovery review before any pilot.
