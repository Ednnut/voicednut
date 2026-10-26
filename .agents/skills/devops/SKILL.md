---
name: devops
description: Change or review VOICEDNUT environments, CI/CD, infrastructure, observability, deployment, or operational recovery.
---

## Workflow

1. Inspect workflow triggers, permissions, secrets references, pinned actions, environments, runtime versions, artifacts, hosting, health checks, and rollback behavior.
2. Prefer least privilege, immutable action references, deterministic builds, explicit health verification, and staged rollouts compatible with current hosting.
3. Validate workflow syntax and commands locally where possible. Distinguish repository edits from GitHub settings and live infrastructure.
4. Document backups, deployment order, health checks, rollback/forward recovery, and required external configuration.

## Guardrails, tools, and approval

Use existing GitHub Actions, Docker/AWS tools only if available and required, and official platform docs. Never expose secrets or assume a GitHub environment is protected without verifying required reviewers. Ask before production access, deploy, infrastructure mutation, billable resources, or destructive commands.

## Done when

Workflow changes are validated, permissions and recovery are reviewed, external prerequisites are explicit, and no production action is claimed unless approved and observed.
