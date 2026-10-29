---
name: setup-bootstrap
description: Set up or repair VOICEDNUT development environments and automate repeatable local engineering workflows.
---

# Set up without damaging local state

First identify the package and environment. Inspect versions, package scripts, lockfiles, and existing setup before installing or overwriting anything. Production and shared-host changes belong to `devops` and require explicit authorization.

## Workflow

1. Check Node against `.nvmrc`, package manager and lockfile, installed dependencies, required local tools, and setup scripts. For env files, inspect key names only; never print values.
2. Use the repository's documented setup command. Prefer lockfile-based installs where supported. Avoid global installs and extra tooling unless the workflow needs them.
3. Make configuration changes non-destructively. Do not overwrite existing `.env` files or invent credentials; leave missing secret values for the user to supply privately.
4. For repetitive work, prefer a small documented script with stable arguments and a clear dry-run or safety boundary over a pasted one-off command. Keep it idempotent where practical.
5. Run only the setup checks authorized for the task and report exact commands, outcomes, installed tools, and manual steps still needed.
