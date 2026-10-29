# Mini App action-bridge map

Use this reference for changes that send an action through the Mini App bridge. Confirm every location in the current checkout before editing; contracts and routing can evolve.

1. **Contract and IDs:** `miniapp/src/contracts/miniappParityContracts.ts` defines canonical dashboard action IDs and related contract data.
2. **Client guards and transport:** inspect `miniapp/src/services/admin-dashboard/dashboardActionGuards.ts`, `dashboardApiContracts.ts`, `dashboardTransport.ts`, and the nearest page/service caller.
3. **Server registration and allow-list:** inspect the Mini App supported-action list and action resolution/spec helpers in `api/app.js`.
4. **Request entry:** `/miniapp/action` is session-protected, rate-limited, and payload-size-limited before action validation, idempotency checks, and capability authorization. Verify current middleware and ordering in code.
5. **Handler and result:** trace the selected action's handler to the service/DB/provider operation and response. Keep response shape aligned with the Mini App contract and guard.
6. **Coverage:** find the nearest API contract/action tests and Mini App contract/e2e tests. Stub any external I/O.

Do not treat a client guard as authorization. Enforce access and input constraints on the server as well.
