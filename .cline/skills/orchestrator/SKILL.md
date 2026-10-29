---
name: orchestrator
description: Route VOICEDNUT engineering requests to the smallest useful workflow; use for planning, cross-cutting work, ambiguous tasks, multi-phase changes, or when task type and risk need triage. Entry point for new-code generation (codegen), bug fixes (via debugger), code explanation (codebase-explainer), safe refactors (refactor), schema/data migrations (migration-runner), environment setup (setup-bootstrap), and pre-merge review (review).
---

# VOICEDNUT task routing

Classify the requested outcome (feature, bug, refactor, provider/API, AI, UI, data, security, operations, or release). Inspect applicable `AGENTS.md`, `git status`, manifests, and relevant code before editing. Preserve in-progress changes.

## Workflow

1. State scope, constraints, affected package/boundary, and observable acceptance criteria.
2. Select only relevant skills: `architecture` for boundaries; `telephony` for calls/providers; `api` for contracts; `ai` for agents; `frontend` and `ui` for Mini App; `testing` for verification; `security` for identity/data/permissions; `database` for persistence; `devops` for CI/infrastructure; `performance` for measured bottlenecks; `release` for release readiness. Combine only where the task crosses those areas.
   Task-shape skills select by the requested outcome, then combine with only the domain skills the change needs: `codegen` for newly authored code; `miniapp-feature` for a user-visible Mini App flow (pair with `frontend`/`ui`); `miniapp-visual-qa` for browser verification; `api-contract-change` for routes or action-bridge contracts (pair with `api`); `api-incident-triage` for evidence-led API failure diagnosis; `api-docs-reference` whenever external API/SDK/provider behavior is explained, changed, debugged, or audited; `offline-voice-rehearsal` for fake-provider call lifecycle rehearsal (pair with `telephony`); `payment-rehearsal` for isolated fake-provider payment lifecycle verification; `integration-catalog` for mapping integrations and their owning code; `provider-contract-audit` for findings-first official-doc conformance reviews; `debugger` for fixing confirmed symptoms; `codebase-explainer` when understanding is the deliverable; `refactor` for behavior-preserving structure changes; `migration-runner` for schema or stored-data changes (use `database` for persistence design); `setup-bootstrap` for environment repair or recurring local routines; `review` for findings-first audits; `provider-onboarding` for adding or extending voice/messaging providers (pair with `telephony`).
   Default routing hints: Mini App page or user flow → `miniapp-feature` + `frontend`/`ui`; requested browser QA → `miniapp-visual-qa`; route, response, or bridge action → `api-contract-change` + `api`; API failure diagnosis → `api-incident-triage`; any external API/SDK/provider behavior → `api-docs-reference` + owning domain skill; offline call rehearsal → `offline-voice-rehearsal` + `telephony`; payment rehearsal → `payment-rehearsal` + the relevant payment/domain skill; integration inventory/map → `integration-catalog`; provider contract audit → `provider-contract-audit` + `api-docs-reference` + owning domain skill; new general feature → `codegen` + owning domain skill; new/changed voice or messaging provider → `provider-onboarding` + `telephony` + `api-docs-reference`; bug fix → `debugger`; explanation → `codebase-explainer`; structure-only change → `refactor`; schema/data change → `database` + `migration-runner`; environment setup → `setup-bootstrap`; requested audit → `review`. Add `testing`, `security`, or `release` only when the work or acceptance criteria need them.
3. Inspect existing patterns and official documentation for external behavior. Choose the smallest reversible implementation and focused tests.
4. Implement incrementally, run appropriate checks, review diff and security impact, then report exact results and unresolved risks.

## Guardrails and tools

Use repository code, package scripts, local Codex tools, and available GitHub/web tools only when relevant. Check actual MCP/tool availability before relying on it. Never assume skills install tools or grant permissions. Keep secrets and customer content out of output. Get approval before destructive, billable, production, credential, external-write, or untrusted-code operations.

## Done when

Acceptance criteria are addressed; relevant validation and diff review are complete; commands and outcomes are truthful; remaining risks and rollback are stated. Do not claim unrun checks passed.
