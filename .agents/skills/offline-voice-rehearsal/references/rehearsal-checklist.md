# Offline voice rehearsal checklist

Adapt this checklist to the provider and operation under test.

## Fake boundary

- Inject a fake provider client; do not initialize a real SDK client or read provider credentials.
- Use temporary database files and synthetic identifiers/content.
- Keep provider feature flags and dispatch controls off; the fake must be the only transport.

## Lifecycle and safety

- Verify accepted/pending and relevant terminal or result-ready states separately.
- Replay the same idempotency key and request; assert one fake mutation.
- Change a request under the same key and assert the documented conflict.
- Simulate timeout/uncertain acceptance and prove no blind second dispatch occurs.
- Replay duplicate events and verify stable deduplication.
- Check auth/business scope at the service boundary where it is owned.
- Assert logs, API output, and persisted rows omit secrets and unnecessary transcript/result content.

## Result report

Record the exact command, lifecycle cases exercised, fake call count, persistence invariants, and whether any real provider I/O occurred (expected: none).
