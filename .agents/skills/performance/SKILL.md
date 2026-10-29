---
name: performance
description: Investigate measurable VOICEDNUT performance problems and regressions — Mini App load/render/bundle size, api/app.js request latency and event-loop blocking, SQLite query plans and index gaps (sqlite3 CLI available), provider/network fanout, timeouts, memory, or PM2 runtime behavior. Requires a baseline measurement before and after any change.
---

## Workflow

1. Establish the affected user path and baseline metric: latency, throughput, query plan, render count, bundle size, or memory.
2. Profile or measure using available local tools before changing code; inspect caching, request fanout, rendering, indexes, payload size, and resource limits as relevant.
3. Make one targeted change, then repeat the same measurement and relevant correctness tests.
4. Report environment, method, before/after values, tradeoffs, and variability; avoid unsupported performance claims.

## Guardrails, tools, and approval

Use installed profilers, browser devtools/Playwright, SQLite explain plans, and repository benchmarks. Do not add telemetry that captures sensitive data. Ask before load testing shared/production systems or paid observability services.

## Done when

A measurable bottleneck is addressed or ruled out, correctness checks pass, and measured results plus limitations are recorded.
