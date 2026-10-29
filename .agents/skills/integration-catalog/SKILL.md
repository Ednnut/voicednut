---
name: integration-catalog
description: Map VOICEDNUT integrations to their owning clients, adapters, routes, configuration names, tests, and docs before changing or debugging an integration. Use when asked what integrations exist, where an integration lives, or how a provider is wired.
---

# Integration catalog

Build an evidence-based map of the integration relevant to the request. Start from `references/integration-map.md`, then confirm current paths and behavior in the repository; the inventory is a navigation aid and can become stale.

## Workflow

1. Read root `AGENTS.md`, check `git status`, and preserve user changes.
2. Identify the provider/product and capability: voice, messaging, AI, payments, CRM, Telegram/Mini App, or deployment/observability.
3. Trace the full path from configuration and feature gate through client/adapter, service, route/webhook, persistence, and focused tests. Prefer existing project boundaries.
4. Report exact paths, public entry points, configuration variable **names** (never values), current test coverage, and documented official vendor references when useful.
5. Distinguish code support, configured credentials, reachable external service, and production readiness. Repository evidence alone cannot prove the last three.

## Guardrails

- Do not print secrets or inspect credential values. Environment variable names and whether code checks for their presence are enough.
- Do not make provider calls, live payments, calls, messages, or external writes while cataloging.
- Verify official vendor behavior from current documentation before making claims about provider contracts.
- For any integration behavior change or failure diagnosis, load `api-docs-reference` and review the relevant current official endpoint docs; `references/integration-map.md` is only a code navigation map.
- Pair with `codebase-explainer` when the requested deliverable is a narrative explanation; pair with `provider-contract-audit` for a conformance review; use the owning domain skill when changing code.
