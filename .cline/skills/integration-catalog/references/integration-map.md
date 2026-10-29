# VOICEDNUT integration map (starting points)

Confirm paths with `rg --files` before relying on this map.

| Area | Starting points | Trace next |
| --- | --- | --- |
| Voice / AI calls | `api/services/vapiClient.js`, `api/services/vapi*Service.js`, `api/services/callEClient.js`, `api/adapters/` | provider onboarding, call routes, webhook services, persistence, provider tests |
| Speech / models | `api/services/deepgramVoiceAgentPreflight.js`, `api/services/deepgramVoiceModels.js` | AI and telephony configuration, model validation, preflight tests |
| Payments | `api/services/paymentProviderSwitchboard.js`, `api/services/paypalPaymentService.js`, `api/services/stripePaymentService.js`, `api/services/squarePaymentService.js` | `api/routes`, webhook routes, session persistence, connector policy and payment tests |
| Messaging / CRM | `api/adapters/`, `api/services/crmContactSyncService.js` | channel routes, sync policy, opt-out/consent, tests |
| Telegram Mini App | `miniapp/src/`, `miniapp/package.json` | action bridge, Telegram auth/session, UI contracts, Playwright tests |
| API / persistence | `api/app.js`, `api/routes/`, `api/db/db.js` | middleware, tenant scope, schema, migration and route tests |

The API README documents the current PayPal, Stripe, Square and provider preflight workflows. Use code plus focused tests as the source of truth for implementation behavior. Never infer that a configured variable exists in a deployment or that a provider account is reachable.
