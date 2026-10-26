# Phase 14 — Vapi inbound number configuration

Date: 2026-10-25  
Status: administrators can configure a Vapi number to send incoming assistant requests to VOICEDNUT, after assigning an eligible local route.

## Implemented

- Added `POST /api/vapi/phone-numbers/:phoneNumberId/configure-inbound`, protected by the existing admin-token guard.
- The endpoint requires a valid Vapi phone-number UUID, a current local inbound route, enabled Vapi credentials, and a configured HTTPS `VAPI_WEBHOOK_URL`, `VAPI_WEBHOOK_CREDENTIAL_ID`, and `VAPI_WEBHOOK_BEARER_TOKEN`.
- The service reads the Vapi number first and patches only the `server` configuration, setting its URL and Custom Credential ID while preserving other server settings such as timeout and headers. It is idempotent when the number already has the target URL and credential.
- The service rejects inactive numbers, numbers assigned to an assistant, squad, or workflow, and numbers with a different server URL or credential. It does not silently replace an existing call path or webhook destination. Clear those assignments or resolve conflicting server settings in Vapi, then retry.
- The response includes only the phone-number ID and configuration flags. Provider credentials and webhook settings are not returned or logged.

## Rollback and limits

This endpoint does not update local route selection or delete Vapi resources. It changes only the number's server URL and credential; other existing server fields are preserved. To roll back, restore the number's prior server URL and credential in Vapi. The endpoint deliberately refuses numbers with a static assistant/squad/workflow assignment, so it does not need to save or restore those assignments.

The route requires an eligible local inbound mapping from [Phase 12](phase12-vapi-inbound-assistant-routing.md). No live Vapi phone-number update or inbound call was performed.

## Verification

- Client tests cover documented GET and PATCH phone-number endpoints.
- Service tests cover explicit local-route prerequisite, HTTPS and webhook credential validation, no-overwrite conflicts, preservation of existing server settings, idempotence, and sensitive-field exclusion.
- Full API suite: **195 passing**. Syntax checks and `git diff --check` passed.

## Official references

- [Vapi Update Phone Number API](https://docs.vapi.ai/api-reference/phone-numbers/update)
- [Vapi assistant-request phone-number configuration](https://docs.vapi.ai/assistants/personalization)
- [Vapi server URLs and credential configuration](https://docs.vapi.ai/server-url/setting-server-urls)
