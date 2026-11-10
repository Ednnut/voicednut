function enabledLabel(value) {
    return value === true ? 'enabled' : 'disabled';
}

function sanitizeDisplayText(value, maxLength = 80) {
    return String(value || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, maxLength) || 'unnamed';
}

function formatCartesiaStatus(status = {}) {
    const apiVersion = typeof status.apiVersion === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(status.apiVersion)
        ? status.apiVersion
        : 'unknown';
    const lines = [
        'Cartesia server status (read-only)',
        `API key configured: ${status.configured === true ? 'yes' : 'no'}`,
        `Managed Agents enabled: ${enabledLabel(status.enabled)}`,
        `API version: ${apiVersion}`,
        `Outbound dispatch: ${enabledLabel(status.dispatchEnabled)}`,
        `Batch dispatch: ${enabledLabel(status.batchDispatchEnabled)}`,
        `Batch reconciliation: ${enabledLabel(status.batchReconciliationEnabled)}${Number.isSafeInteger(status.batchReconciliationIntervalMs) ? ` (${Math.round(status.batchReconciliationIntervalMs / 1000)}s)` : ''}`,
        `Batch recipient retention: ${enabledLabel(status.batchRetentionEnabled)}${Number.isSafeInteger(status.batchRetentionDays) && status.batchRetentionDays > 0 ? ` (${status.batchRetentionDays} days)` : ''}`,
        `Destination allowlist entries: ${Number.isSafeInteger(status.destinationAllowlistCount) && status.destinationAllowlistCount >= 0 ? status.destinationAllowlistCount : 0}`,
        `Webhook secret configured: ${status.webhookConfigured === true ? 'yes' : 'no'}`,
        `Phone number changes: ${enabledLabel(status.phoneNumberMutationsEnabled)}`,
        `Phone number provisioning: ${enabledLabel(status.phoneNumberProvisioningEnabled)}`,
        `SIP changes: ${enabledLabel(status.sipProviderMutationsEnabled)}`,
    ];
    return lines.join('\n');
}

function registerCartesiaCommand(bot, options = {}) {
    const apiConfig = options.config || require('../config');
    const client = options.httpClient || require('../utils/httpClient');
    const resolveAccess = options.getAccessProfile || require('../utils/capabilities').getAccessProfile;

    async function replyUnavailable(ctx) {
        await ctx.reply('Cartesia action is unavailable. Check the API server and try again.');
    }

    async function handleStatus(ctx) {
        try {
            const response = await client.get(
                null,
                `${apiConfig.apiUrl}/api/cartesia/status`,
                { timeout: 10000 },
            );
            const payload = response?.data;
            if (payload?.success !== true || !payload.status || typeof payload.status !== 'object') {
                await replyUnavailable(ctx);
                return;
            }
            await ctx.reply(formatCartesiaStatus(payload.status));
        } catch (_) {
            await replyUnavailable(ctx);
        }
    }

    async function handleProfilePreview(ctx, scriptId, voiceId) {
        if (!/^\d{1,12}$/.test(scriptId) || Number(scriptId) <= 0 || !/^[A-Za-z0-9_-]{1,200}$/.test(voiceId)) {
            await ctx.reply('Usage: /cartesia profile <script_id> <voice_id>');
            return;
        }
        try {
            const scriptResponse = await client.get(
                null,
                `${apiConfig.apiUrl}/api/call-scripts/${scriptId}`,
                { timeout: 10000 },
            );
            const script = scriptResponse?.data?.script;
            const expectedVersion = Number(script?.version);
            if (scriptResponse?.data?.success !== true || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
                await ctx.reply('Unable to load that call script. Check the script ID and try again.');
                return;
            }
            const previewResponse = await client.post(
                null,
                `${apiConfig.apiUrl}/api/call-scripts/${scriptId}/cartesia-speech-profile/preview`,
                { voice_id: voiceId, expected_version: expectedVersion },
                { timeout: 10000 },
            );
            const preview = previewResponse?.data?.preview;
            if (previewResponse?.data?.success !== true ||
                preview?.voice_id !== voiceId ||
                Number(preview?.expected_version) !== expectedVersion ||
                !/^[a-f0-9]{64}$/.test(String(preview?.fingerprint || ''))) {
                await ctx.reply('Cartesia speech profile preview failed. No script changes were made.');
                return;
            }
            await ctx.reply([
                'Cartesia speech profile preview (not saved)',
                `Script: ${scriptId} — ${sanitizeDisplayText(script.name)}`,
                `Voice ID: ${voiceId}`,
                `Script version: ${expectedVersion}`,
                'Lifecycle after apply: draft',
                `Voice access: ${preview.provider_voice_validation === 'format_only' ? 'ID format checked; account availability not verified' : 'not verified'}`,
                '',
                `To apply this exact preview, run:\n/cartesia apply ${scriptId} ${voiceId} ${expectedVersion} ${preview.fingerprint}`,
            ].join('\n'));
        } catch (_) {
            await replyUnavailable(ctx);
        }
    }

    async function handleProfileApply(ctx, scriptId, voiceId, expectedVersionRaw, fingerprint) {
        const expectedVersion = Number(expectedVersionRaw);
        if (!/^\d{1,12}$/.test(scriptId) || Number(scriptId) <= 0 ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(voiceId) ||
            !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0 ||
            !/^[a-f0-9]{64}$/.test(fingerprint)) {
            await ctx.reply('Usage: /cartesia apply <script_id> <voice_id> <expected_version> <preview_fingerprint>');
            return;
        }
        try {
            const response = await client.put(
                null,
                `${apiConfig.apiUrl}/api/call-scripts/${scriptId}/cartesia-speech-profile`,
                {
                    voice_id: voiceId,
                    expected_version: expectedVersion,
                    approved: true,
                    confirmed_fingerprint: fingerprint,
                },
                {
                    timeout: 15000,
                    headers: { 'Idempotency-Key': `cartesia-profile-${scriptId}-${expectedVersion}-${fingerprint}` },
                },
            );
            if (response?.data?.success !== true) {
                await ctx.reply('Cartesia speech profile update was not confirmed by the API.');
                return;
            }
            await ctx.reply(`Cartesia voice profile saved for script ${scriptId} as version ${response.data.version} (${response.data.lifecycle_state}).`);
        } catch (_) {
            await ctx.reply('Cartesia speech profile update failed. The API may have rejected a stale preview; run /cartesia profile again before retrying.');
        }
    }

    async function handleBatch(ctx, batchId) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId)) {
            await ctx.reply('Usage: /cartesia batch <batch_id>');
            return;
        }
        try {
            const response = await client.post(null, `${apiConfig.apiUrl}/api/cartesia/call-batches/${encodeURIComponent(batchId)}/reconcile`, {}, { timeout: 15000 });
            const batch = response?.data?.batch;
            if (response?.data?.success !== true || batch?.id !== batchId) {
                await ctx.reply('Unable to load that Cartesia batch.');
                return;
            }
            await ctx.reply([
                'Cartesia batch status (read-only)',
                `ID: ${batch.id}`,
                `Status: ${sanitizeDisplayText(batch.status, 32)}`,
                `Scheduled: ${Number.isSafeInteger(batch.totalCallsScheduled) ? batch.totalCallsScheduled : 0}`,
                `Dispatched: ${Number.isSafeInteger(batch.totalCallsDispatched) ? batch.totalCallsDispatched : 0}`,
                `Finished: ${Number.isSafeInteger(batch.totalCallsFinished) ? batch.totalCallsFinished : 0}`,
                `Retry count: ${Number.isSafeInteger(batch.retryCount) ? batch.retryCount : 0}`,
                `Locally reconciled recipients: ${batch.reconciliation?.persisted === true ? Number(batch.reconciliation.recipientCount) || 0 : 'not a VOICEDNUT-created batch'}`,
                'Cartesia batch cancellation stops queued calls; calls already in progress continue.',
            ].join('\n'));
        } catch (_) {
            await replyUnavailable(ctx);
        }
    }

    async function handleBatchCancel(ctx, batchId, confirmation) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || confirmation !== 'CANCEL') {
            await ctx.reply('Usage: /cartesia cancel-batch <batch_id> CANCEL');
            return;
        }
        try {
            const response = await client.post(
                null,
                `${apiConfig.apiUrl}/api/cartesia/call-batches/${encodeURIComponent(batchId)}/cancel`,
                { approved: true },
                { timeout: 15000 },
            );
            if (response?.data?.success !== true || response?.data?.batch?.id !== batchId) {
                await ctx.reply('Cartesia did not confirm batch cancellation. Refresh batch status before retrying.');
                return;
            }
            await ctx.reply(`Cartesia batch ${batchId} cancellation was confirmed. Calls already in progress may continue.`);
        } catch (_) {
            await ctx.reply('Cartesia batch cancellation failed or is unresolved. Refresh batch status before retrying.');
        }
    }

    async function handleBatchRetentionPreview(ctx, batchId, mode) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || mode !== 'PREVIEW') {
            await ctx.reply('Usage: /cartesia purge-batch <batch_id> PREVIEW');
            return;
        }
        try {
            const response = await client.post(
                null,
                `${apiConfig.apiUrl}/api/cartesia/call-batches/${encodeURIComponent(batchId)}/retention/preview`,
                {},
                { timeout: 15000 },
            );
            const preview = response?.data?.preview;
            if (response?.data?.success !== true || preview?.batchId !== batchId) {
                await ctx.reply('Unable to prepare a Cartesia batch retention preview.');
                return;
            }
            if (preview.eligible !== true || !/^[a-f0-9]{64}$/.test(String(preview.fingerprint || ''))) {
                await ctx.reply(`No recipient data will be deleted. Retention eligibility: ${sanitizeDisplayText(preview.reason || 'not eligible', 48)}; configured minimum age: ${Number.isSafeInteger(preview.retentionDays) ? preview.retentionDays : 0} days.`);
                return;
            }
            await ctx.reply([
                'Cartesia recipient retention preview (no data deleted)',
                `Batch: ${batchId}`,
                `Terminal status: ${sanitizeDisplayText(preview.status, 32)}`,
                `Recipient records: ${Number.isSafeInteger(preview.recipientCount) ? preview.recipientCount : 0}`,
                `Minimum age: ${preview.retentionDays} days`,
                `Eligible since: ${sanitizeDisplayText(preview.expiresAt, 40)}`,
                `Preview fingerprint: ${preview.fingerprint}`,
                `To delete these local recipient records, run:\n/cartesia purge-batch ${batchId} PURGE ${preview.fingerprint}`,
                'Provider calls, batch totals, and Cartesia data are not affected.',
            ].join('\n'));
        } catch (_) {
            await replyUnavailable(ctx);
        }
    }

    async function handleBatchRetentionPurge(ctx, batchId, mode, fingerprint) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || mode !== 'PURGE' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
            await ctx.reply('Usage: /cartesia purge-batch <batch_id> PURGE <preview_fingerprint>');
            return;
        }
        try {
            const response = await client.post(
                null,
                `${apiConfig.apiUrl}/api/cartesia/call-batches/${encodeURIComponent(batchId)}/retention`,
                { approved: true, confirmed_fingerprint: fingerprint },
                { timeout: 15000 },
            );
            const result = response?.data?.result;
            if (response?.data?.success !== true || result?.batchId !== batchId || !Number.isSafeInteger(result.deletedCount)) {
                await ctx.reply('Cartesia batch recipient deletion was not confirmed. Refresh local batch records before retrying.');
                return;
            }
            await ctx.reply(`Deleted ${result.deletedCount} expired recipient records from local batch ${batchId}. Batch totals and Cartesia provider data were unchanged.`);
        } catch (_) {
            await ctx.reply('Cartesia batch recipient deletion failed or is unresolved. Run a new retention preview before retrying.');
        }
    }

    bot.command('cartesia', async (ctx) => {
        const access = await resolveAccess(ctx);
        if (!access?.isAdmin) {
            await ctx.reply('Access denied. Cartesia status is available to administrators only.');
            return;
        }
        const args = String(ctx.message?.text || '').trim().split(/\s+/).slice(1);
        const action = String(args[0] || 'status').trim().toLowerCase();
        if (action === 'status' && args.length <= 1) return handleStatus(ctx);
        if (action === 'batch' && args.length === 2) return handleBatch(ctx, args[1]);
        if (action === 'cancel-batch' && args.length === 3) return handleBatchCancel(ctx, args[1], args[2]);
        if (action === 'purge-batch' && args.length === 3 && args[2] === 'PREVIEW') return handleBatchRetentionPreview(ctx, args[1], args[2]);
        if (action === 'purge-batch' && args.length === 3 && args[2] === 'PURGE') return handleBatchRetentionPurge(ctx, args[1], args[2], '');
        if (action === 'purge-batch' && args.length === 4) return handleBatchRetentionPurge(ctx, args[1], args[2], args[3]);
        if (action === 'profile' && args.length === 3) return handleProfilePreview(ctx, args[1], args[2]);
        if (action === 'apply' && args.length === 5) return handleProfileApply(ctx, args[1], args[2], args[3], args[4]);
        await ctx.reply([
            'Cartesia commands (admin only)',
            '/cartesia status',
            '/cartesia batch <batch_id> — read batch status',
            '/cartesia cancel-batch <batch_id> CANCEL — stop queued calls; in-progress calls continue',
            '/cartesia purge-batch <batch_id> PREVIEW — preview expired local recipient data',
            '/cartesia purge-batch <batch_id> PURGE <fingerprint> — explicitly delete previewed local recipient data',
            '/cartesia profile <script_id> <voice_id> — preview only',
            '/cartesia apply <script_id> <voice_id> <expected_version> <preview_fingerprint> — confirm and save',
        ].join('\n'));
    });
}

module.exports = registerCartesiaCommand;
module.exports.registerCartesiaCommand = registerCartesiaCommand;
module.exports.formatCartesiaStatus = formatCartesiaStatus;
