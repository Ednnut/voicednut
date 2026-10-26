---
name: release
description: Perform final VOICEDNUT release readiness, risk, compatibility, verification, and rollback review.
---

## Workflow

1. Inspect the full diff, worktree state, release target, package versions, migrations, config changes, and relevant CI results.
2. Verify acceptance criteria, tests/builds, secrets handling, tenant/auth boundaries, provider side effects, runtime compatibility, and deployment prerequisites.
3. Confirm release notes and rollback/forward recovery for risky changes; list known failures and external approvals still needed.
4. Produce a go/no-go recommendation based only on evidence. Do not deploy or publish as part of readiness review.

## Guardrails, tools, and approval

Use repository checks, Git, CI status tools if available, and official release/platform docs. Do not expose secrets or represent unverified settings as configured. Deployment, publishing, destructive operations, and billable external actions require explicit approval.

## Done when

Every acceptance criterion has evidence or a stated gap, the diff and recovery path are reviewed, risks are prioritized, and the release recommendation does not overstate verification.
