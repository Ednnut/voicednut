# Mini App development notes

## Frontend workflow

- Preserve the existing React 18, TypeScript, Vite, Telegram UI, CSS/SCSS, routing, and data-fetching patterns. Reuse shared components; do not introduce another UI framework, component library, or styling system without a demonstrated gap and approval.
- For meaningful UI changes, inspect responsive behavior at relevant desktop/tablet/mobile widths and check semantic labels, keyboard focus/order, form feedback, loading, empty, success, and error states. Use Playwright when a real user flow benefits from browser coverage; use only available/configured visual or accessibility tools.
- Before editing, read applicable root instructions and check current worktree changes. Preserve API authentication, Telegram session handling, capability-gated actions, and tenant boundaries.
- For frontend tasks, route through `frontend` and `ui`; consider `testing`, `security`, `api`, `performance`, and `release` only when their criteria apply.

## CometChat documentation

When changing or adding CometChat functionality in the Mini App, consult current CometChat documentation before implementation. If a Context7 documentation MCP is available in the current session, first resolve the relevant library ID and query the specific React SDK/UI Kit/API behavior in scope. Otherwise, use CometChat's official documentation site. Do not assume an MCP is connected or rely on a previously returned library ID without resolving it again. Verify package/API names against the repository before adding dependencies.

If `cometchat/docs-mcp` becomes available in the plugin marketplace, use it only after plugin status confirms it is installed and connected. Do not claim any documentation MCP is installed unless the current session confirms it.
