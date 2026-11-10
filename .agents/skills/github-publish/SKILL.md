---
name: github-publish
description: Commit and push requested repository changes to GitHub. Use when the user asks to commit, push, or publish local changes; defaults to branch `main` and commit message `updated`.
---

# GitHub Publish

Use this skill only for a user-requested commit or push. Its defaults are target branch `main` and commit message `updated`; apply explicit overrides from the user's current request.

## Workflow

1. Read repository instructions and inspect `git status`, the current branch, recent commits, and configured remotes. Do not print credential-bearing remote URLs. Confirm the repository and target branch are the intended ones.
2. Inspect the full diff, including staged, unstaged, and untracked files. Preserve pre-existing user changes. Identify the files that belong to the requested change; do not sweep unrelated work into the commit. If the request clearly covers all current repository changes, include them after reviewing each file.
3. Check for secrets, generated artifacts, accidental deletions, and unrelated changes. Stage only the intended files, then inspect the staged diff and summary before committing. Never use `reset --hard`, `clean`, stash, force-push, or history rewriting to make publishing easier.
4. Run relevant checks available in the repository and report their actual outcomes. Do not claim checks passed if they were skipped or failed.
5. Commit with the requested message, or `updated` by default. Verify the resulting commit and ensure it targets `main` (or the user's explicit override).
6. Push only when the user requested a push/publish. Push to the configured intended remote and target branch. If the branch has diverged, the remote is ambiguous, credentials/access are unavailable, checks reveal a blocking issue, or a non-fast-forward push is rejected, stop and report the exact blocker. Never force-push or silently change remotes/branches.
7. Verify the local branch and resulting remote state when access permits. Summarize the commit hash, branch, remote, files included, checks, and push result.

An explicit user request to commit and push authorizes those Git operations for the reviewed scope. It does not authorize unrelated external writes, releases, deployments, or changes to repository settings.
