---
name: bug-hunt
description: Review code for likely defects, logic errors, security risks, and unhandled edge cases; report actionable findings without fixing them unless asked.
---

# Bug hunt

Use for a code review, risk scan, or request to identify bugs. Establish the target scope and expected behavior, then inspect relevant code and tests. Follow data and control flow to substantiate each finding; prioritize reproducible impact over speculative style concerns.

Report findings first, ordered by severity. For each, give a concise title, exact file/line, triggering conditions, impact, and a practical fix direction. Distinguish confirmed defects from plausible risks. Note important areas checked with no finding only when useful. Do not modify code unless asked to fix it.
