# VOICEDNUT contributor instructions

## Before changing code

- Read applicable `AGENTS.md` files, package manifests, and the relevant implementation before editing. Check `git status` and preserve existing user changes.
- Trace existing provider, API, database, and UI boundaries before adding abstractions or dependencies. Extend existing patterns when they fit.
- For every task that explains, changes, debugs, or audits external API/SDK/provider behavior, load `.agents/skills/api-docs-reference/SKILL.md` and review the current official docs for each affected integration. Use its catalog as an index, not as a substitute for current endpoint documentation. Use a configured documentation MCP when available; otherwise browse the vendor's official site. Never assume an MCP is connected.
- For any Cartesia Line SDK or CLI task—including implementation, debugging, review, or usage questions—always load `.agents/skills/cartesia-line/SKILL.md` before proceeding. This required skill is pinned to [`cartesia-ai/skills` commit `0ee3f4a4ad8e9cf9d314962448b721cdc34fae42`](https://github.com/cartesia-ai/skills/tree/0ee3f4a4ad8e9cf9d314962448b721cdc34fae42/skills/cartesia-line). Continue to verify current Line behavior in official Cartesia docs. For Cartesia application APIs (Sonic, Ink, voices, and Managed Agent WebSockets), load `.agents/skills/cartesia-api/SKILL.md`.
- Classify the request and use `.agents/skills/orchestrator/SKILL.md` to route it to only the relevant specialist skills. Skill files guide workflows; they do not install tools, connect MCP servers, or grant permissions.
- Task-shape skills beside the domain ones: `codegen` for new code, `miniapp-feature` for Mini App user flows, `miniapp-visual-qa` for browser QA, `api-contract-change` for routes and action-bridge contracts, `api-incident-triage` for API failure diagnosis, `api-docs-reference` for current official API/SDK references on external integration work, `offline-voice-rehearsal` for fake-provider call lifecycle checks, `payment-rehearsal` for isolated payment lifecycle checks, `integration-catalog` for mapping project integrations, `provider-contract-audit` for official-doc contract reviews, `debugger` for symptom→cause work, `codebase-explainer` for legacy/complex code, `refactor` for behavior-preserving structure changes, `migration-runner` for schema/data execution (design stays with `database`), `setup-bootstrap` for environment setup and repeated local routines, `review` for findings-first audits, and `provider-onboarding` for new or extended voice providers. Combine these with relevant domain skills; state the selected set in one line before starting.

## Tooling available in this workspace

- Node 24 (`.nvmrc`), npm 12 and pnpm; `rg` (ripgrep 14) at `~/.local/bin`; `sqlite3` CLI; `jq`; git and GitHub CLI present (repo token is pull-only — do not assume push or GitHub settings access); Docker available.
- Test entry points: API `cd api && npm test -- --reporter dot` (Mocha, provider I/O stubbed; 271 tests baseline) or single file `npx mocha __tests__/<file>.test.js`; bot `cd bot && node --test`; Mini App `npm run validate:prod`, `test:e2e`, `test:a11y` (Playwright chromium). On-demand coverage via `npx --yes c8` (not a repo dependency; needs network approval and leaves an unignored `api/coverage/` scratch dir — clean it up).
- No MCP server is configured; verify availability in-session before relying on one. Never claim a tool, check, or connection that was not actually exercised.

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

## Subagent delegation

- For each engineering task, use subagents when independent exploration, implementation slices, or review can materially reduce elapsed time or keep the main thread focused. Skip delegation for tiny edits and work that depends on one sequential investigation.
- Delegate read-heavy discovery to `repo_explorer`; use `miniapp_worker` for an isolated Mini App implementation slice; use `change_reviewer` for an independent, read-only review of meaningful changes. Give each agent one bounded deliverable and ask for concise findings with file references.
- Keep at most two agents active at once. Avoid parallel edits to the same files; the main agent owns integration, verification, and the final diff review. Subagents inherit the parent sandbox and approvals.
