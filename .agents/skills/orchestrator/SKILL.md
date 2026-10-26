---
name: orchestrator
description: Route VOICEDNUT engineering requests to the smallest useful workflow; use for planning, cross-cutting work, or when task type and risk need triage.
---

# VOICEDNUT task routing

Classify the requested outcome (feature, bug, refactor, provider/API, AI, UI, data, security, operations, or release). Inspect applicable `AGENTS.md`, `git status`, manifests, and relevant code before editing. Preserve in-progress changes.

## Workflow

1. State scope, constraints, affected package/boundary, and observable acceptance criteria.
2. Select only relevant skills: `architecture` for boundaries; `telephony` for calls/providers; `api` for contracts; `ai` for agents; `frontend` and `ui` for Mini App; `testing` for verification; `security` for identity/data/permissions; `database` for persistence; `devops` for CI/infrastructure; `performance` for measured bottlenecks; `release` for release readiness. Combine only where the task crosses those areas.
3. Inspect existing patterns and official documentation for external behavior. Choose the smallest reversible implementation and focused tests.
4. Implement incrementally, run appropriate checks, review diff and security impact, then report exact results and unresolved risks.

## Guardrails and tools

Use repository code, package scripts, local Codex tools, and available GitHub/web tools only when relevant. Check actual MCP/tool availability before relying on it. Never assume skills install tools or grant permissions. Keep secrets and customer content out of output. Get approval before destructive, billable, production, credential, external-write, or untrusted-code operations.

## Done when

Acceptance criteria are addressed; relevant validation and diff review are complete; commands and outcomes are truthful; remaining risks and rollback are stated. Do not claim unrun checks passed.
