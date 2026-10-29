# API triage evidence

Ask for or record only details needed to reproduce the issue:

- Route, HTTP method, Mini App action, or webhook type.
- Approximate UTC time and environment (local, test, or production as reported by the user).
- Request/correlation ID, if available and safe to share.
- Expected status/behavior and observed status/error code.
- Whether the issue is repeatable and whether it affects one request or a wider set.
- Relevant sanitized logs with credentials, personal data, transcripts, and payment details removed.

Do not ask for API tokens, raw authorization headers, full webhook payloads, customer database rows, or complete call transcripts. If an external observability tool is connected, use the narrowest read-only query and summarize findings without copying sensitive values.
