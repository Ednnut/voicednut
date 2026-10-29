# Task: Verify all packages

Run the full documented verification pass and report a results table (command → outcome). Do not fix anything unless asked; classify each failure as regression vs. pre-existing baseline by checking `git status` and prior CI first.

1. API: `cd api && npm test -- --reporter dot` — expect 271 passing on a clean tree.
2. Bot: `cd bot && node --test`.
3. Mini App: `cd miniapp && npm run validate:prod`; then `npm run test:e2e` and `npm run test:a11y` if Playwright chromium binaries are installed (if missing, report that as a setup gap instead of downloading without approval).
4. Repo hygiene: `git status --short`, `git diff --check`, confirm no stray scratch dirs (`api/coverage/`) and no secrets staged (`.env` names only, never values).

Output: one table with exact commands, pass/fail counts, durations, and any skipped check with its reason.