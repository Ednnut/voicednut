# Phase 17 — Vapi web calls in Mini App

Date: 2026-10-25  
Status: authorized Mini App operators can test a currently published, compatible Vapi template from the browser.

## Implemented

- Added a Vapi web-call test panel to Provider Control. It lists only current, live templates with a compatible, synchronized mapping and starts or ends browser calls using the official Vapi Web SDK.
- The Mini App API endpoints require an authenticated session with `provider_manage` and check the request Origin against `VAPI_WEB_ALLOWED_ORIGINS`. The listing endpoint returns only local mapping labels and IDs.
- Starting a call makes the server create a Vapi web call with its private API client and the exact synced assistant ID/version. The browser receives only that call's join URL/token and reconnects with the official Web SDK; it does not receive a reusable Vapi API key or choose assistant overrides.
- The database query excludes drafts, stale template versions, incompatible mappings, and any mapping that is not the latest preview for that template version.
- The client requests microphone access only when the operator starts a call. The UI displays call state and generic errors; it does not read or store transcript messages.
- The call is started by assistant ID with no client-supplied overrides. The Mini App never receives `VAPI_PRIVATE_API_KEY`.

## Configuration and limits

Set `VAPI_ENABLED=true` and comma-separated exact `VAPI_WEB_ALLOWED_ORIGINS` values. Calls use the existing server-only `VAPI_PRIVATE_API_KEY`; no public key configuration is used by this Mini App call flow.

This operator test call does not create a legacy `calls` row. Its durable idempotency record now makes the provider call ID available to the admin call inspector and reconciliation endpoint described in [Phase 18](phase18-vapi-web-call-operations.md). The server stores only the provider call ID and template correlation metadata, never the join token. The Mini App retains the attempt key in session storage until the call ends. If a request times out or Vapi’s outcome is otherwise unknown, the same key fails closed and prevents a duplicate provider call. Operators must check Vapi call logs before clearing browser session storage or starting a new attempt. If Vapi webhooks are configured, eligible lifecycle events continue through the existing sanitized Vapi event ledger. No production provider selection or phone routing changes. No live call was started during implementation.

Rollback by removing the Provider Control panel and Mini App Vapi endpoints, then set `VAPI_ENABLED=false` and clear `VAPI_WEB_ALLOWED_ORIGINS`. No database schema change is required.

## Verification

- `cd api && npm test`: **208 passing**. Coverage includes idempotency reservation and safe response projection, origin checks, and live/current/synced mapping filtering.
- Mini App ESLint passed for `VapiWebCallPanel.tsx` and `ProviderControlPage.tsx`; `npm run build` passed.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:e2e`: **1 passed**.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/voicednut-playwright-browsers npm run test:a11y`: **1 passed**.
- API `node --check` checks and `git diff --check` passed. No live Vapi call was made.

## Official references

- [Vapi Create Call API](https://docs.vapi.ai/api-reference/calls/create)
- [Vapi API keys and browser use](https://docs.vapi.ai/security-and-privacy/api-keys)
- [Vapi Web SDK](https://github.com/VapiAI/client-sdk-web)
