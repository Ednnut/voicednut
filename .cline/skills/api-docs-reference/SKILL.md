---
name: api-docs-reference
description: Review current official API and SDK documentation whenever explaining, changing, debugging, or auditing an external API integration used by VOICEDNUT; confirm versions and use examples that match project conventions. Use for provider APIs, webhooks, SDK integrations, and external platform contracts.
---

# API documentation reference workflow

Use this skill whenever work explains, changes, or diagnoses a request, response, SDK call, authentication flow, webhook, model selection, API version, retry, or provider behavior. Start with [the catalog pointers](references/api-catalog.md), then verify current implementation paths and vendor docs in the checkout.

## Required review

1. Identify every external API/SDK affected by the task and the exact endpoint, event, method, or feature in use. For cross-provider changes, review each affected provider separately.
2. Inspect implementation and focused tests first. Record the package version from the manifest and lockfile; for HTTP clients, inspect the base URL, version prefix/header, request shape, auth, response parsing, timeout/retry, and webhook validation.
3. Open the provider's **current official** API reference and relevant guide/examples. Confirm endpoint and version status, authentication, required fields, response/error shapes, limits/pagination, idempotency/retry semantics, webhook signature/replay rules, and any migration/deprecation notices that affect the change. Use a configured documentation MCP if available; otherwise browse the official vendor site. Never assume an MCP is connected.
4. Compare the live documentation to the repository code, lockfile, README, and tests. Treat an SDK package version, endpoint path version, provider API version header, and model identifier as separate version axes.
5. Build or update examples from the official sample plus the repository's client conventions. Keep examples minimal and runnable with placeholders; do not put secrets, real phone numbers, customer data, or billable operations in examples. Mark examples as sandbox/test-only if they perform writes.
6. If documentation reveals a mismatch, state the exact source and version evidence. For a requested fix, preserve current boundaries and safety gates, add focused fake-provider coverage when appropriate, and update the catalog's version notes and checked date if the project reference has changed.
7. Report links to the exact docs pages used, package/API versions found, which sample pattern was followed, and unresolved discrepancies. Do not claim an integration is current or compliant unless you checked the relevant current docs and code.

## Project-wide inventory requests

When asked to review all project APIs, enumerate integrations from package manifests/lockfiles, base URLs, provider adapters, routes/webhooks, environment/configuration names, connector packs, and documentation. Compare the discovered set with `docs/api-integrations.json`; add missing APIs and label integrations as **implemented**, **selectable/configured**, or **docs/sample-only**. Run `node scripts/check-api-docs-catalog.js` to check coverage and generated-doc freshness. This inventory is not proof that credentials are configured or services are reachable.

Before assessing the blast radius of a provider/API version, SDK, webhook, or provider configuration change, run `node scripts/provider-impact.js --provider <registry-id>`. Treat its output as a search aid: inspect listed owners, matches, tests, environment variable names, and official docs in context, then add any missing explicit impact metadata to the registry.

## Guardrails

- Prefer vendor-owned docs, API references, changelogs, SDK repositories, and sample repositories. Use current docs, not model memory or third-party tutorials, for claims about provider behavior.
- Documentation browsing is read-only. Never use docs examples to send calls/messages, create payments, issue refunds, mutate customer records, or change production configuration.
- Keep secrets and personal data out of URLs, browser queries, logs, and generated sample code.
- Pair with `integration-catalog` for path discovery, `provider-contract-audit` for findings-first conformance review, and the owning domain skill for implementation.
- Do not load every API doc for unrelated tasks. Review the official docs for every API actually touched; do a full inventory/doc pass only when the request is project-wide.
