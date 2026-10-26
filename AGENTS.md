# VOICEDNUT contributor instructions

## Before changing code

- Read applicable `AGENTS.md` files, package manifests, and the relevant implementation before editing. Check `git status` and preserve existing user changes.
- Trace existing provider, API, database, and UI boundaries before adding abstractions or dependencies. Extend existing patterns when they fit.
- Use current official vendor documentation for provider or platform behavior. Use a configured documentation MCP when available; otherwise use the vendor's official documentation site. Never assume an MCP is connected.
- Classify the request and use `.agents/skills/orchestrator/SKILL.md` to route it to only the relevant specialist skills. Skill files guide workflows; they do not install tools, connect MCP servers, or grant permissions.

## Safety and data

- Keep credentials in approved secret stores or environment variables. Never print, commit, or log secrets, full call transcripts, payment details, or unnecessary personal data.
- Preserve authentication, authorization, idempotency, replay protection, rate limits, and business/tenant scoping. Treat webhook payloads and provider responses as untrusted input.
- Stub provider calls in tests. Do not initiate live calls, messages, payments, refunds, or other billable provider operations without explicit approval.
- Ask before destructive changes, production operations, external writes, credentials access, or executing untrusted code. Keep sandbox and approval protections enabled.

## Changes and verification

- Make incremental, reversible changes; avoid duplicate logic and broad rewrites. Explain material assumptions and risks.
- Add or update focused tests for behavior changes. Use Playwright for relevant user-visible Mini App flows; do not add browser tests for changes that do not affect browser behavior.
- Run relevant documented checks and report the exact commands and outcomes. Do not claim a check passed unless it ran successfully.
- For database or deployment changes, document compatibility, backup, and rollback steps before applying them. Never deploy without explicit approval.

## Task routing

- Use `architecture` for cross-package boundaries, shared contracts, or broad refactors; `telephony` for voice, call, messaging, and webhook behavior; `api` for other API contracts and integrations; `ai` for agents, prompts, tools, and evals.
- For Mini App work, normally consider `frontend`, `ui`, and `testing`; add `security` when identity/data/permissions are involved, `api` when backend contracts change, `performance` for measured loading/rendering/runtime concerns, and `release` for production-facing changes.
- Use `database` for schema/persistence work, `security` for security reviews, `devops` for CI/infrastructure/deployment, `performance` for measured bottlenecks, and `release` for final readiness. Do not load every skill for routine work.
- Define observable acceptance criteria, inspect relevant code first, implement the smallest reversible change, run relevant checks, inspect the diff and security impact, and report actual results, risks, and rollback.
