# Phase 5 — Existing template integration

Date: 2026-10-25  
Status: authenticated compatibility preview and guarded assistant sync implemented; no call routing has been switched to Vapi.

`POST /api/call-scripts/:id/vapi-preview` loads the persisted local template behind the existing admin-token guard. It accepts optional explicit `vapi_model` and `vapi_voice` candidates and returns a preview with source template identity, mapped fields, missing requirements, and unsupported features. The endpoint stores an audit row containing a SHA-256 fingerprint and a summary only; submitted model/voice configuration and API keys are not stored. Credential-like fields in the submitted candidate settings are rejected. It does not call Vapi. Prompt, greeting, model, and voice choices must all be explicit before the adapter reports structural compatibility; this is not live Vapi validation.

`GET /api/call-scripts/:id/vapi-mappings` lists the versioned preview records for that template. The database record is keyed by template ID, version, and fingerprint, so repeated previews are idempotent while changes to the source or candidate configuration create a separate audit entry. Only the compatibility status and a summary of mapped/missing/unsupported field names are stored.

`POST /api/call-scripts/:id/vapi-sync` is available behind the same admin-token guard and requires `VAPI_ENABLED=true` plus a server-only private key. It creates or updates a saved assistant from a structurally compatible mapping, includes a deterministic VOICEDNUT mapping marker in Vapi assistant metadata, and stores the returned assistant ID/version and sync status locally. On an uncertain create outcome, retries search Vapi assistant metadata and refuse a second create if the original result cannot be resolved. A durable claim prevents concurrent sync requests for the same mapping. This does not assign a phone number, publish a routing change, create a call, or switch traffic.

Template-level tools, knowledge resources, transfer behavior, structured outputs, squads, call flow semantics, provider-specific behavior, payment workflow, digit capture/OTP, existing voice model, objective flow, conversation profiles, and terminator behavior are marked unsupported pending dedicated mappings. Unknown configuration keys also fail closed. Existing templates and execution continue through their existing providers.

## Verification

- Full API suite: 148 passing.
- Mapping persistence uses a temporary SQLite database in tests; repeated upserts preserve one record per template version and candidate fingerprint.
- Sync service tests cover create/update reuse, reconciliation after local persistence loss, refusal to repeat an uncertain create, and incompatible-template blocking.
- JavaScript syntax checks and `git diff --check` pass.

The current route uses the existing global admin token; organization-level ownership/authorization and representative deployment template data remain unverified. The sync path was tested only with mocked Vapi responses because this workspace has no Vapi credentials. Remote publication/version selection, call routing, webhooks, tools, live schema validation, and real-call validation remain future work.

## Official references

- [Create Assistant](https://docs.vapi.ai/api-reference/assistants/create)
- [List Assistants](https://docs.vapi.ai/api-reference/assistants/list)
- [Get Assistant](https://docs.vapi.ai/api-reference/assistants/get)
- [Update Assistant](https://docs.vapi.ai/api-reference/assistants/update)
- [Server authentication](https://docs.vapi.ai/server-url/server-authentication)
