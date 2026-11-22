const config = require('../config');
const httpClient = require('../utils/httpClient');
const { escapeMarkdown, buildLine, sendEphemeral, buildMainMenuReplyMarkup } = require('../utils/ui');
const { getAccessProfile, getDeniedAuditSummary } = require('../utils/capabilities');
const { getDeadLetterStatusFields } = require('../utils/deadLetterStatus');
const { getProviderStatusFields } = require('../utils/providerStatus');
const { buildCallbackData } = require('../utils/actions');

async function replyApiError(ctx, error, fallback, options = {}) {
    const message = httpClient.getUserMessage(error, fallback);
    return ctx.reply(message, options);
}

async function requireAdminAccess(ctx) {
    const access = await getAccessProfile(ctx);
    if (!access?.isAdmin) {
        await ctx.reply('❌ Access denied. This action is available to administrators only.');
        return null;
    }
    return access;
}

function formatTimestamp(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
}

function formatPhoneSuffix(value) {
    if (!value) return 'n/a';
    const digits = String(value).replace(/\D+/g, '');
    if (!digits) return 'n/a';
    return digits.slice(-4);
}

function getArrayPayload(response, key) {
    if (Array.isArray(response?.data?.[key])) return response.data[key];
    if (Array.isArray(response?.data?.data?.[key])) return response.data.data[key];
    return [];
}

function formatCallbackTaskLine(task) {
    const id = escapeMarkdown(String(task?.id ?? 'unknown'));
    const status = escapeMarkdown(String(task?.status || 'unknown'));
    const runAt = escapeMarkdown(formatTimestamp(task?.run_at));
    const phone = escapeMarkdown(formatPhoneSuffix(task?.phone_number));
    return `• #${id} ${status} at ${runAt} for xxxx${phone}`;
}

function formatDeadLetterLine(entry) {
    const { id, jobType, reason } = getDeadLetterStatusFields(entry);
    return `• #${escapeMarkdown(id)} ${escapeMarkdown(jobType)} — ${escapeMarkdown(reason)}`;
}

function formatReviewCaseLine(reviewCase) {
    const id = escapeMarkdown(String(reviewCase?.id ?? 'unknown'));
    const status = escapeMarkdown(String(reviewCase?.status || 'open'));
    const action = escapeMarkdown(String(reviewCase?.requested_action || 'review_case'));
    const reason = escapeMarkdown(String(reviewCase?.reason || 'No reason provided'));
    return `• #${id} ${status} ${action}: ${reason}`;
}

function normalizeDispositionLabel(call) {
    return String(
        call?.call_disposition_label ||
        call?.call_disposition ||
        'Unclassified'
    );
}

function summarizeDispositionCounts(calls) {
    const counts = new Map();
    for (const call of calls) {
        if (!call?.call_disposition && !call?.call_disposition_label) {
            continue;
        }
        const label = normalizeDispositionLabel(call);
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
}

async function handleStatusCommand(ctx) {
    try {
        const access = await requireAdminAccess(ctx);
        if (!access) return;

        await sendEphemeral(ctx, '🔍 Checking system status...');

        const startTime = Date.now();
        const healthHeaders = {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
        if (config.admin?.apiToken) {
            healthHeaders['x-admin-token'] = config.admin.apiToken;
        }
        const response = await httpClient.get(null, `${config.apiUrl}/ready`, {
            timeout: 15000,
            headers: healthHeaders
        });
        const responseTime = Date.now() - startTime;

        const health = response.data;

        const apiHealthStatus = health.status || 'healthy';
        let message = `🔍 *System Status Report*\n\n`;
        let spekoDlqEntries = [];
        let spekoUsageAvailable = false;
        message += `🤖 Bot: ✅ Online & Responsive\n`;
        message += `🌐 API: ${health.status === 'healthy' ? '✅' : '❌'} ${escapeMarkdown(apiHealthStatus)}\n`;
        message += `${buildLine('⚡', 'API Response Time', `${responseTime}ms`)}\n\n`;

        if (health.services) {
            message += `*🔧 Services Status:*\n`;

            const db = health.services.database;
            message += `${buildLine('🗄️', 'Database', db?.connected ? '✅ Connected' : '❌ Disconnected')}\n`;
            if (db?.recent_calls !== undefined) {
                message += `${buildLine('📋', 'Recent DB Calls', db.recent_calls)}\n`;
            }

            const webhook = health.services.webhook_service;
            if (webhook) {
                message += `${buildLine('📡', 'Webhook Service', `${webhook.status === 'running' ? '✅' : '⚠️'} ${escapeMarkdown(webhook.status)}`)}\n`;
                if (webhook.processed_today !== undefined) {
                    message += `${buildLine('📨', 'Webhooks Today', webhook.processed_today)}\n`;
                }
            }

            const notifications = health.services.notification_system;
            if (notifications) {
                message += `${buildLine('🔔', 'Notifications', `${escapeMarkdown(String(notifications.success_rate || 'N/A'))} success rate`)}\n`;
            }

            const providers = getProviderStatusFields(health.services.provider_failover);
            if (providers.length) {
                spekoUsageAvailable = providers.some((provider) =>
                    provider.name === 'speko' && provider.configured
                );
                message += `\n*📞 Call Provider Configuration*\n`;
                for (const provider of providers) {
                    const state = !provider.configured
                        ? '⚪ Not configured'
                        : provider.degraded
                            ? '⚠️ Degraded'
                            : provider.circuitState === 'half_open'
                                ? '🟡 Recovering'
                                : '✅ Configured';
                    const evidence = provider.healthScore === null
                        ? ''
                        : `; observed score ${provider.healthScore}/100`;
                    message += `${buildLine('•', provider.name, `${state}${evidence}`)}\n`;
                }
                message += `_Configuration and circuit state only; this view does not probe live provider connectivity._\n`;
            }

            const callJobs = health.services.call_jobs;
            if (callJobs) {
                const dlqCount = Number(callJobs.open_dead_letters) || 0;
                message += `${buildLine('🧰', 'Call jobs', `${Number(callJobs.pending) || 0} pending, ${Number(callJobs.running) || 0} running`)}\n`;
                message += `${buildLine(dlqCount > 0 ? '⚠️' : '✅', 'Open dead letters', dlqCount)}\n`;
                if (dlqCount > 0) {
                    try {
                        const dlqResponse = await httpClient.get(
                            null,
                            `${config.apiUrl}/admin/call-jobs/dlq/summary?status=open&limit=3&provider_details=true`,
                            { timeout: 8000, headers: healthHeaders },
                        );
                        const entries = getArrayPayload(dlqResponse, 'rows');
                        spekoDlqEntries = entries.filter((entry) =>
                            ['outbound_call', 'callback_call'].includes(String(entry?.job_type || '')) &&
                            String(entry?.provider || '').toLowerCase() === 'speko'
                        );
                        if (entries.length) {
                            message += `\n*⚠️ Recent jobs requiring review:*\n`;
                            message += entries.map(formatDeadLetterLine).join('\n');
                            if (dlqCount > entries.length) {
                                message += `\n• ${dlqCount - entries.length} more open item(s)`;
                            }
                            message += '\n';
                        }
                    } catch (_) {
                        message += '\nReview item details are temporarily unavailable.\n';
                    }
                }
            }

            message += `\n`;
        }

        message += `*📊 Call Statistics:*\n`;
        message += `${buildLine('📞', 'Active Calls', health.active_calls || 0)}\n`;
        message += `${buildLine('📈', 'Live Connections', health.active_calls || 0)}\n`;

        const audit = getDeniedAuditSummary();
        if (audit.total > 0) {
            message += `${buildLine('🔒', `Access denials (${audit.windowSeconds}s)`, `${audit.total} across ${audit.users} user(s), ${audit.rateLimited} rate-limited`)}\n`;
            if (audit.recent && audit.recent.length > 0) {
                const recentLines = audit.recent.map((entry) => {
                    const suffix = entry.userId ? String(entry.userId).slice(-4) : 'unknown';
                    const who = `user#${suffix}`;
                    const actionLabel = escapeMarkdown(entry.actionLabel || entry.capability || 'action');
                    const role = escapeMarkdown(entry.role || 'unknown');
                    const when = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : 'recent';
                    return `• ${who} (${role}) blocked on ${actionLabel} at ${escapeMarkdown(when)}`;
                });
                message += `\n*🔐 Recent denials:*\n${recentLines.join('\n')}\n`;
            }
        }

        if (health.adaptation_engine) {
            message += `\n*🤖 AI Features:*\n`;
            message += `${buildLine('🧠', 'Adaptation Engine', '✅ Active')}\n`;
            message += `${buildLine('🧩', 'Function Scripts', health.adaptation_engine.available_scripts || 0)}\n`;
            message += `${buildLine('⚙️', 'Active Systems', health.adaptation_engine.active_function_systems || 0)}\n`;
        }

        if (health.inbound_defaults || health.inbound_env_defaults) {
            message += `\n*📥 Inbound Defaults:*\n`;
            const inbound = health.inbound_defaults || {};
            if (inbound.mode === 'script') {
                message += `${buildLine('📄', 'Default Script', `${escapeMarkdown(inbound.name || 'Unnamed')} (${escapeMarkdown(String(inbound.script_id || ''))})`)}\n`;
            } else {
                message += `${buildLine('📄', 'Default Script', 'Built-in')}\n`;
            }
            const envDefaults = health.inbound_env_defaults || {};
            const envPrompt = envDefaults.prompt ? 'set' : 'unset';
            const envFirst = envDefaults.first_message ? 'set' : 'unset';
            message += `${buildLine('⚙️', 'Env Defaults', `prompt: ${envPrompt}, first_message: ${envFirst}`)}\n`;
        }

        if (health.enhanced_features) {
            message += `${buildLine('🚀', 'Enhanced Mode', '✅ Enabled')}\n`;
        }

        if (health.system_health && health.system_health.length > 0) {
            message += `\n*🔍 Recent Activity:*\n`;
            health.system_health.slice(0, 3).forEach(log => {
                const status = log.status === 'error' ? '❌' : '✅';
                message += `${status} ${escapeMarkdown(log.service_name)}: ${log.count} ${escapeMarkdown(log.status)}\n`;
            });
        }

        message += `\n${buildLine('⏰','Last Updated', escapeMarkdown(new Date(health.timestamp).toLocaleString()))}`;
        message += `\n${buildLine('📡','API Endpoint', escapeMarkdown(config.apiUrl))}`;

        const replyMarkup = buildMainMenuReplyMarkup(ctx);
        if (spekoUsageAvailable) {
            replyMarkup.inline_keyboard.unshift([
                {
                    text: '📊 Speko usage & budget',
                    callback_data: buildCallbackData(ctx, 'SPEKO_USAGE'),
                },
                {
                    text: '📈 Speko activity',
                    callback_data: buildCallbackData(ctx, 'SPEKO_METRICS'),
                },
            ]);
        }
        const reconcileButtons = spekoDlqEntries.slice(0, 3).map((entry) => {
            const id = Number(entry?.id);
            if (!Number.isInteger(id) || id < 1) return null;
            return [{
                text: `🔎 Reconcile call DLQ #${id}`,
                callback_data: buildCallbackData(ctx, `DLQ_RECONCILE:${id}`),
            }];
        }).filter(Boolean);
        if (reconcileButtons.length) {
            replyMarkup.inline_keyboard = [...reconcileButtons, ...(replyMarkup.inline_keyboard || [])];
        }
        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
    } catch (error) {
        console.error('Status command error:', error);
        const message = `${httpClient.getUserMessage(error, 'System status check failed.')}\nAPI: ${config.apiUrl}`;
        await ctx.reply(message, {
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    }
}

async function handleHealthCommand(ctx) {
    try {
        const access = await getAccessProfile(ctx);
        if (!access?.isAuthorized) {
            return ctx.reply('❌ Access denied. Your account is not authorized for this action.');
        }

        const startTime = Date.now();

        try {
            const response = await httpClient.get(null, `${config.apiUrl}/health`, {
                timeout: 8000,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });
            const responseTime = Date.now() - startTime;

            const health = response.data;

            let message = `🏥 *Health Check*\n\n`;
            message += `🤖 Bot: ✅ Responsive\n`;
            message += `🌐 API: ${health.status === 'healthy' ? '✅' : '⚠️'} ${health.status || 'responding'}\n`;
            message += `⚡ Response Time: ${responseTime}ms\n`;

            if (health.active_calls !== undefined) {
                message += `📞 Active Calls: ${health.active_calls}\n`;
            }

            if (health.services?.database?.connected !== undefined) {
                message += `🗄️ Database: ${health.services.database.connected ? '✅' : '❌'} ${health.services.database.connected ? 'Connected' : 'Disconnected'}\n`;
            }

            message += `⏰ Checked: ${new Date().toLocaleTimeString()}`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                reply_markup: buildMainMenuReplyMarkup(ctx)
            });
        } catch (apiError) {
            const message = `${httpClient.getUserMessage(apiError, 'API unreachable.')}\nAPI: ${config.apiUrl}`;
            await ctx.reply(message, {
                reply_markup: buildMainMenuReplyMarkup(ctx)
            });
        }
    } catch (error) {
        console.error('Health command error:', error);
        await replyApiError(ctx, error, 'Health check failed.', {
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    }
}

async function handleCallbackTasksCommand(ctx) {
    try {
        const access = await requireAdminAccess(ctx);
        if (!access) return;

        await sendEphemeral(ctx, '📞 Loading callback tasks...');

        const response = await httpClient.get(null, `${config.apiUrl}/api/callback-tasks?limit=10`, {
            timeout: 15000
        });
        const callbackTasks = getArrayPayload(response, 'callback_tasks');

        let message = '📞 *Callback Tasks*\n\n';
        if (!callbackTasks.length) {
            message += 'No callback tasks found.';
        } else {
            message += callbackTasks.map(formatCallbackTaskLine).join('\n');
        }

        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    } catch (error) {
        console.error('Callback tasks command error:', error);
        await replyApiError(ctx, error, 'Failed to load callback tasks.', {
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    }
}

async function handleReviewCasesCommand(ctx) {
    try {
        const access = await requireAdminAccess(ctx);
        if (!access) return;

        await sendEphemeral(ctx, '🗂️ Loading review cases...');

        const response = await httpClient.get(null, `${config.apiUrl}/api/review-cases?limit=10`, {
            timeout: 15000
        });
        const reviewCases = getArrayPayload(response, 'review_cases');

        let message = '🗂️ *Review Cases*\n\n';
        if (!reviewCases.length) {
            message += 'No review cases found.';
        } else {
            message += reviewCases.map(formatReviewCaseLine).join('\n');
        }

        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    } catch (error) {
        console.error('Review cases command error:', error);
        await replyApiError(ctx, error, 'Failed to load review cases.', {
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    }
}

async function handleDomainStatsCommand(ctx) {
    try {
        const access = await requireAdminAccess(ctx);
        if (!access) return;

        await sendEphemeral(ctx, '📊 Loading recent domain outcomes...');

        const response = await httpClient.get(null, `${config.apiUrl}/api/calls?limit=20`, {
            timeout: 15000
        });
        const calls = getArrayPayload(response, 'calls');
        const topDispositions = summarizeDispositionCounts(calls);
        const recentOutcomes = calls
            .filter((call) => call?.call_disposition || call?.call_disposition_label)
            .slice(0, 5);

        let message = '📊 *Domain Outcomes*\n\n';
        if (!topDispositions.length) {
            message += 'No structured call dispositions found.';
        } else {
            message += '*Top Outcomes*\n';
            message += topDispositions
                .map(([label, count]) => `• ${escapeMarkdown(label)}: ${count}`)
                .join('\n');
        }

        if (recentOutcomes.length) {
            message += '\n\n*Recent Outcomes*\n';
            message += recentOutcomes.map((call) => {
                const label = escapeMarkdown(normalizeDispositionLabel(call));
                const source = escapeMarkdown(String(call?.call_disposition_source || 'unknown'));
                const updatedAt = escapeMarkdown(formatTimestamp(call?.call_disposition_updated_at));
                return `• ${label} via ${source} at ${updatedAt}`;
            }).join('\n');
        }

        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    } catch (error) {
        console.error('Domain stats command error:', error);
        await replyApiError(ctx, error, 'Failed to load domain outcomes.', {
            reply_markup: buildMainMenuReplyMarkup(ctx)
        });
    }
}

function registerApiCommands(bot) {
    bot.command('status', handleStatusCommand);
    bot.command('callbacks', handleCallbackTasksCommand);
    bot.command('reviewcases', handleReviewCasesCommand);
    bot.command('domainstats', handleDomainStatsCommand);
    bot.command(['health', 'ping'], handleHealthCommand);
}

module.exports = {
    registerApiCommands,
    handleStatusCommand,
    handleHealthCommand,
    handleCallbackTasksCommand,
    handleReviewCasesCommand,
    handleDomainStatsCommand,
    formatDeadLetterLine
};
