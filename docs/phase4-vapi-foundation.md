# Phase 4 — Vapi foundation

Date: 2026-10-25  
Status: server-side client foundation implemented; integration remains disabled by default.

## Implemented

- `api/services/vapiClient.js` sends server-side bearer-authenticated requests to the documented Vapi API host and exposes assistant list/get/create/update and call creation methods.
- Requests have a bounded timeout. Errors expose a stable code, HTTP status, and retryability while omitting response bodies and credentials. The client does not automatically retry mutating requests.
- `VAPI_ENABLED` defaults to false. `VAPI_PRIVATE_API_KEY` is read only by the server-side client. There is no browser exposure, live account request, assistant creation, or call creation in this phase.
- `api/adapters/vapiTemplateAdapter.js` makes an explicit template-to-assistant mapping preview. It requires explicit Vapi model settings and marks unknown tools, knowledge, call-flow, transfer, structured-output, squad, and provider-specific behaviors as unsupported. It does not provision Vapi resources.

## Verification

- Full API suite: 138 passing.
- `node --check` passed for changed JavaScript files; `git diff --check` passed.
- Mini App build was attempted, but cannot run because its local dependencies are absent (`tsc: not found`). No Playwright config or browser tests are present in the repository, so mobile browser validation was unavailable. The Mini App UI itself was not changed.

## Limits

The mapping preview is intentionally not wired to an endpoint or provider registry. Vapi API keys and deployment configuration are unavailable in this workspace. Vapi webhook validation, assistant synchronization, real provider calls, retry policy beyond no automatic retries, and live compatibility validation remain future work.

## Official references

- [Vapi Create Assistant API](https://docs.vapi.ai/api-reference/assistants/create)
- [Vapi Create Call API](https://docs.vapi.ai/api-reference/calls/create)
- [Vapi API keys and server-side private key guidance](https://docs.vapi.ai/security-and-privacy/api-keys)
