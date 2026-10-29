# VOICEDNUT — Cline working rules

These rules complement root `AGENTS.md` and `miniapp/AGENTS.md`; read those first for safety and routing. Canonical skills live in `.agents/skills/<name>/SKILL.md`; Cline discovers the mirrored copies under `.cline/skills/`. After editing a canonical skill, run `scripts/sync-agent-skills.sh` to refresh Cline's copies.

## Before any edit

- Run `git status`, preserve user changes, and state the selected skill set in one line.
- Locate real definitions with `rg` before asserting how anything works; `api/app.js` is ~31k lines — never answer from names or memory.
- For every task explaining, changing, debugging, or auditing external API/SDK/provider behavior, load `.agents/skills/api-docs-reference/SKILL.md` (or its `.cline/skills` mirror) and review current official docs for each affected integration. Use `references/api-catalog.md` as an index; it is not a replacement for endpoint-level docs.
- New code extends existing patterns: API services/adapters are constructor-injected classes under `api/services` / `api/adapters`; Mini App stays on React 18 + TS + Vite + Telegram UI; DB changes follow the additive idempotent startup pattern in `api/db/db.js`.

## Verification commands (run from owning package)

- API: `cd api && npm test -- --reporter dot` (baseline 271 passing) · single file `npx mocha __tests__/<file>.test.js`
- Bot: `cd bot && node --test`
- Mini App: `npm run validate:contracts && npm run lint && npm run build` (= `validate:prod`) · `npm run test:e2e` · `npm run test:a11y`
- Docs/config-only change: review the full diff and use `git diff --check` when verification is requested; confirm no stale flag/route names survive.
- Report exact commands and outcomes; never claim an unrun check passed.

## Hard guardrails

- No secrets, transcripts, phone numbers, or customer rows in logs, output, fixtures, or commits. Credentials only via env/secret store; `.env` files stay git-ignored.
- Preserve auth, tenant/business scoping, idempotency keys, rate limits, webhook replay defenses, and default-off feature flags (`CALLE_*` and provider gates).
- Tests stub all provider I/O. Never initiate live calls, SMS, payments, refunds, or billable provider operations without explicit approval. No production access, deploys, or external writes unless the user approves that specific action.
- Provider payloads and webhook bodies are untrusted input; validate and bound everything derived from them.

## Task-shape → skill map

new code from an intent (feature/route/service/component/script) → `codegen` + owning domain skill · Mini App page or flow → `miniapp-feature` + `frontend`/`ui` · browser QA → `miniapp-visual-qa` · route/action contract → `api-contract-change` + `api` · API failure diagnosis → `api-incident-triage` · external API/SDK/provider behavior → `api-docs-reference` + owning domain skill · offline call rehearsal → `offline-voice-rehearsal` + `telephony` · payment rehearsal → `payment-rehearsal` + payment/domain skill · integration inventory/map → `integration-catalog` · provider contract audit → `provider-contract-audit` + `api-docs-reference` + owning domain skill · bug fix → `debugger` · explain/read code → `codebase-explainer` · structure-only change → `refactor` (+ `architecture` if boundaries move) · schema/backfill → `migration-runner` (+ `database`) · env setup/scripts → `setup-bootstrap` · audit a diff/area → `review` (+ `security`) · new or extended voice provider → `provider-onboarding` + `telephony` + `api-docs-reference` · readiness/NO-GO → `release`.
