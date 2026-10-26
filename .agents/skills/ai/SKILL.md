---
name: ai
description: Design or improve VOICEDNUT AI agents, prompts, tools, routing, memory, workforce behavior, evaluations, or safety controls.
---

## Workflow

1. Trace current model/provider abstractions, prompt/config sources, tool policies, memory boundaries, and evaluations.
2. Define task success, allowed actions, refusal/escalation behavior, tenant scope, and sensitive-data handling before changing prompts or tools.
3. Verify model/provider APIs and SDK behavior from official docs. Prefer structured outputs, least-privilege tools, bounded context, and explicit timeouts.
4. Add offline evals for expected behavior, refusals, tool selection, malformed inputs, and regressions. Keep live model calls optional and explicitly gated.

## Guardrails, tools, and approval

Use existing AI SDKs, local tests/evals, and official model/provider docs. Treat model output as untrusted; validate before side effects. Never leak secrets or unnecessary call/user data into prompts, traces, or fixtures. Ask before billable live evals, external writes, or production changes.

## Done when

Behavior has measurable acceptance criteria, relevant offline evaluations pass, side effects remain gated, and limitations/cost assumptions are reported without claiming unsupported model capabilities.
