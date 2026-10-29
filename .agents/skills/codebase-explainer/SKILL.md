---
name: codebase-explainer
description: Explain how unfamiliar, complex, or legacy VOICEDNUT code works, including API, bot, Mini App, database, provider, and historical flows.
---

# Explain from code evidence

The deliverable is an accurate explanation. Do not edit code unless the user also asks for a change; route that work after establishing the relevant behavior.

## Workflow

1. Identify the entry point and question: behavior, data flow, design intent, or failure modes. Use `rg` to find definitions and registrations, then read relevant code rather than inferring from names.
2. Trace the shortest complete path that answers the question. Follow consequential indirections such as middleware, services, adapters, database helpers, contracts, and provider clients. Use nearby tests to confirm observable behavior and docs to understand stated intent.
3. Separate verified behavior from inference. When code, tests, and docs disagree, say which evidence is current and why; do not present comments or old docs as runtime truth.
4. Explain the path in plain language. Include file links or line anchors, important guards (auth, tenancy, flags, idempotency), error behavior, and side effects such as writes, provider calls, timers, or webhook fan-out when relevant.

Prefer a concise direct answer followed by a compact flow. Read only enough of large files to establish the path; avoid dumping secrets, transcripts, phone numbers, or customer rows.
