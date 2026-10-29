# API catalog pointers

The canonical machine-readable inventory is [`docs/api-integrations.json`](../../../../docs/api-integrations.json). The readable, generated API and SDK reference is [`docs/api-integrations.md`](../../../../docs/api-integrations.md).

After changing the registry, run `node scripts/check-api-docs-catalog.js --write-markdown` to regenerate the readable view, then run `node scripts/check-api-docs-catalog.js` to check registry coverage and drift. To map a provider change, use `node scripts/provider-impact.js --list` and `node scripts/provider-impact.js --provider <registry-id>`. These local tools do not fetch vendor documentation or certify that the code matches it; use current official docs for the affected integration as required by this skill.
