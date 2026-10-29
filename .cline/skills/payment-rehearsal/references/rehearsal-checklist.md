# Payment rehearsal checklist

Use the relevant provider service and tests; do not assume every provider implements identical semantics.

- **Policy:** payment feature flag, provider selection, scoped key, amount/currency bounds, write confirmation, refund double-confirmation.
- **Request:** stable idempotency key across retry; timeout/ambiguous response does not create an unsafe duplicate.
- **Webhook:** authentic signature, malformed/missing fields rejected, event deduplicated, replay does not repeat side effects.
- **Lifecycle:** checkout/session, payment status, invoice/refund states map to supported internal states; out-of-order events do not regress terminal state.
- **Persistence:** session/event rows scoped correctly; transaction and unique constraints support duplicate delivery.
- **Privacy:** no secrets, card data, raw webhook body, or unnecessary customer details in logs/errors.
- **Failure paths:** provider error, DB error, duplicate event, invalid signature, missing configuration, and retry are handled predictably.
- **Isolation:** use fake provider and temporary DB; ensure no test points at production endpoints.

Current entry points are documented in `api/README.md`; implementation starting points include `api/services/paymentProviderSwitchboard.js` and provider-specific payment services. Confirm paths before use.
