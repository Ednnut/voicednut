# Task: Implement a Mini App feature or page change

Use `miniapp-feature` + `frontend` + `ui` (+ `api-contract-change` when contracts change, `security` when identity/data/permissions move). Stack stays React 18 + TypeScript + Vite + Telegram UI + existing CSS/SCSS.

1. Read `miniapp/AGENTS.md` and inspect the closest existing page/component pattern (e.g. `src/pages/AdminDashboard/ScriptStudioPage.tsx`), routing, service layer, and current worktree changes first.
2. If an API action is involved, define it contract-first: add to `src/contracts/api-actions.ts` registry + payload guards, mirror server-side validation in `api/app.js`, keep auth/session/capability gating intact; run `npm run validate:contracts` before building UI on top.
3. Implement the smallest complete flow including loading, empty, error, disabled, and success states; reuse shared components; keyboard-operable with correct semantics and contrast; responsive at 390×844, 768×1024, 1280×800.
4. Verify: `cd miniapp && npm run validate:prod`; Playwright `test:e2e` for meaningful user-visible flows and `test:a11y` reporting baseline violations honestly; record screenshots only where supported.
5. Summarize files changed, acceptance criteria evidence, remaining limitations, and anything intentionally deferred.

No new UI frameworks, component kits, state libraries, or external visual-testing services without a demonstrated gap and approval. No deploys from this workflow (`deploy` script exists but is release-gated).
