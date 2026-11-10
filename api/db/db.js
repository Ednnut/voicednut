const sqlite3 = require('sqlite3').verbose();
const crypto = require('node:crypto');
const path = require('path');
const crypto = require('crypto');
const {
    buildObjectiveTagsForFlow,
    getEffectiveObjectiveTags,
    getPrimaryFlowType,
    normalizeCallScriptFlowType,
    parseObjectiveTags,
} = require('../functions/FlowMetadata');
const { normalizeRelationshipProfileType } = require('../functions/Dating');

const CALL_STATUS_ORDER = Object.freeze([
    'queued',
    'initiated',
    'ringing',
    'answered',
    'in-progress',
    'completed',
    'voicemail',
    'busy',
    'no-answer',
    'failed',
    'canceled',
]);
const CALL_ACTIVE_STATUSES = Object.freeze([
    'queued',
    'initiated',
    'ringing',
    'answered',
    'in-progress',
    'connecting',
]);
const CALL_DISPOSITION_STATE = 'call_disposition';
const VALID_CALL_DISPOSITIONS = Object.freeze([
    'tax_refund_status_answered',
    'tax_missing_docs_followup',
    'tax_notice_help_requested',
    'tax_consultation_booked',
    'tax_resolution_case_created',
    'bank_servicing_resolved',
    'bank_secure_followup_sent',
    'fraud_confirmed_legitimate',
    'fraud_denied_transaction',
    'fraud_uncertain_review_required',
    'collections_payment_link_sent',
    'collections_promise_to_pay',
    'collections_hardship_flagged',
    'collections_dispute_created',
    'low_confidence_safe_stop',
    'verification_incomplete',
    'policy_blocked',
]);
function normalizeCallStatusForDb(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
}

function normalizeCallDispositionForDb(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function isValidCallDisposition(value) {
    return VALID_CALL_DISPOSITIONS.includes(normalizeCallDispositionForDb(value));
}

function parseJsonObjectForDb(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function normalizeSquareLinkType(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .slice(0, 80);
}

function addSquareSessionLink(links, related_type, related_id) {
    const relatedType = normalizeSquareLinkType(related_type);
    const relatedId = String(related_id || '').trim();
    if (!relatedType || !relatedId) return;
    links.push({ related_type: relatedType, related_id: relatedId.slice(0, 160) });
}

function collectSquarePaymentSessionLinks(external_id, payload = {}) {
    const links = [];
    const externalId = String(external_id || payload.external_id || '').trim();
    const metadata = parseJsonObjectForDb(payload.metadata);
    const relatedLinks = Array.isArray(payload.related_links) ? payload.related_links : [];

    addSquareSessionLink(links, 'external_id', externalId);
    if (String(payload.action || '').includes('payment_link')) {
        addSquareSessionLink(links, 'payment_link', externalId);
    }

    addSquareSessionLink(links, 'payment_link', metadata.payment_link_id);
    addSquareSessionLink(links, 'payment_link', metadata.checkout_session_id);
    addSquareSessionLink(links, 'payment_link', metadata.square_payment_link_id);
    addSquareSessionLink(links, 'order', metadata.order_id);
    addSquareSessionLink(links, 'payment', metadata.payment_id);
    addSquareSessionLink(links, 'payment', metadata.payment_intent_id);
    addSquareSessionLink(links, 'payment', metadata.square_payment_id);
    addSquareSessionLink(links, 'payment', metadata.square_resource_id);
    addSquareSessionLink(links, 'refund', metadata.refund_id);
    addSquareSessionLink(links, 'refund', metadata.square_refund_id);

    relatedLinks.forEach((link) => {
        if (!link || typeof link !== 'object') return;
        addSquareSessionLink(links, link.related_type || link.type, link.related_id || link.id);
    });

    const seen = new Set();
    return links.filter((link) => {
        const key = `${link.related_type}:${link.related_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseDispositionStateRow(row) {
    if (!row?.data) return null;
    try {
        const parsed = JSON.parse(row.data);
        const disposition = normalizeCallDispositionForDb(parsed?.disposition);
        if (!isValidCallDisposition(disposition)) return null;
        return {
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
            disposition,
            updated_at: row.timestamp || parsed?.updated_at || null,
        };
    } catch (_) {
        return null;
    }
}

function getCallStatusRank(status) {
    return CALL_STATUS_ORDER.indexOf(normalizeCallStatusForDb(status));
}

class EnhancedDatabase {
    constructor() {
        this.db = null;
        this.isInitialized = false;
        this.dbPath = path.join(__dirname, 'data.db');
        this.emailDlqColumnsEnsured = false;
        this.emailQueueColumnsEnsured = false;
        this.outboundRateLastCleanupMs = 0;
        this.callECampaignWriteChain = Promise.resolve();
    }

    async applyConnectionPragmas() {
        if (!this.db) return;
        const runPragma = (sql) => new Promise((resolve, reject) => {
            this.db.run(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Improve durability/concurrency characteristics for SQLite in production-like workloads.
        await runPragma('PRAGMA foreign_keys = ON');
        await runPragma('PRAGMA journal_mode = WAL');
        await runPragma('PRAGMA synchronous = NORMAL');
        await runPragma('PRAGMA busy_timeout = 5000');
    }

    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Error opening enhanced database:', err);
                    reject(err);
                    return;
                }
                console.log('Connected to enhanced SQLite database');
                this.applyConnectionPragmas()
                    .then(() => this.createEnhancedTables())
                    .then(() => this.ensureOutboundContactDispatchCartesiaProvider())
                    .then(() => this.ensureOutboundCallBusinessScopeColumn())
                    .then(() => this.ensureCartesiaCampaignProgressColumns())
                    .then(() => this.ensureCartesiaVoiceGovernanceColumns())
                    .then(() => this.ensureCallESensitiveDataColumns())
                    .then(() => this.ensureCallEMissionEnhancementColumns())
                    .then(() => this.initializeSMSTables())
                    .then(() => this.initializeEmailTables())
                    .then(() => this.initializePostCallAutomationTables())
                    .then(() => this.ensureEmailDlqColumns())
                    .then(() => this.ensureEmailQueueColumns())
                    .then(() => {
                        this.isInitialized = true;
                        console.log('✅ Enhanced database initialization complete');
                        resolve();
                    })
                    .catch(reject);
            });
        });
    }

    async createEnhancedTables() {
        const tables = [
            // Enhanced calls table with comprehensive tracking
            `CREATE TABLE IF NOT EXISTS calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT UNIQUE NOT NULL,
                phone_number TEXT NOT NULL,
                prompt TEXT,
                first_message TEXT,
                user_chat_id TEXT,
                status TEXT DEFAULT 'initiated',
                twilio_status TEXT,
                direction TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                started_at DATETIME,
                ended_at DATETIME,
                duration INTEGER,
                call_summary TEXT,
                ai_analysis TEXT,
                business_context TEXT,
                generated_functions TEXT,
                answered_by TEXT,
                error_code TEXT,
                error_message TEXT,
                ring_duration INTEGER,
                answer_delay INTEGER,
                business_id TEXT
            )`,

            // Enhanced call transcripts table with personality tracking
            `CREATE TABLE IF NOT EXISTS call_transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                speaker TEXT NOT NULL CHECK(speaker IN ('user', 'ai')),
                message TEXT NOT NULL,
                interaction_count INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                personality_used TEXT,
                adaptation_data TEXT,
                confidence_score REAL,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Add backward compatibility table name
            `CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                speaker TEXT NOT NULL CHECK(speaker IN ('user', 'ai')),
                message TEXT NOT NULL,
                interaction_count INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                personality_used TEXT,
                adaptation_data TEXT,
                confidence_score REAL,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Enhanced call states for comprehensive real-time tracking
            `CREATE TABLE IF NOT EXISTS call_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                state TEXT NOT NULL,
                data TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                sequence_number INTEGER,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // One durable human-handoff attempt per call; the unique call_sid
            // and guarded state transitions prevent duplicate transfer legs.
            `CREATE TABLE IF NOT EXISTS call_handoff_sessions (
                call_sid TEXT PRIMARY KEY,
                state TEXT NOT NULL CHECK(state IN ('awaiting_confirmation', 'dispatching', 'started_unconfirmed', 'outcome_unknown', 'cancelled', 'expired', 'failed')),
                destination_e164 TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            `CREATE TABLE IF NOT EXISTS call_outcomes (
                call_sid TEXT PRIMARY KEY,
                script_used TEXT,
                script_version TEXT,
                profile_used TEXT,
                primary_flow TEXT,
                objective_tags TEXT,
                provider_used TEXT,
                voice_used TEXT,
                first_message_version TEXT,
                disposition TEXT,
                callback_action_created INTEGER DEFAULT 0,
                review_case_action_created INTEGER DEFAULT 0,
                secure_follow_up_action_created INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Caller flags for inbound allow/block/spam decisions
            `CREATE TABLE IF NOT EXISTS caller_flags (
                phone_number TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK(status IN ('blocked', 'allowed', 'spam')),
                note TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT,
                source TEXT
            )`,

            // Digit capture events (DTMF, spoken, gather)
            `CREATE TABLE IF NOT EXISTS call_digits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                source TEXT NOT NULL,
                profile TEXT NOT NULL,
                digits TEXT,
                len INTEGER,
                accepted INTEGER DEFAULT 0,
                reason TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Call templates for outbound call presets
            `CREATE TABLE IF NOT EXISTS call_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                prompt TEXT,
                first_message TEXT,
                version INTEGER DEFAULT 1,
                business_id TEXT,
                voice_model TEXT,
                objective_tags TEXT,
                supports_payment INTEGER,
                supports_digit_capture INTEGER,
                requires_otp INTEGER DEFAULT 0,
                default_profile TEXT,
                expected_length INTEGER,
                allow_terminator INTEGER DEFAULT 0,
                terminator_char TEXT,
                payment_enabled INTEGER DEFAULT 0,
                payment_connector TEXT,
                payment_amount TEXT,
                payment_currency TEXT,
                payment_description TEXT,
                payment_policy TEXT,
                agent_config_json TEXT,
                payment_start_message TEXT,
                payment_success_message TEXT,
                payment_failure_message TEXT,
                payment_retry_message TEXT,
                lifecycle_state TEXT DEFAULT 'draft',
                submitted_for_review_at DATETIME,
                reviewed_at DATETIME,
                reviewed_by TEXT,
                review_note TEXT,
                live_at DATETIME,
                live_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Version snapshots for call-template governance (diff/rollback)
            `CREATE TABLE IF NOT EXISTS call_template_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                reason TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(template_id, version),
                FOREIGN KEY(template_id) REFERENCES call_templates(id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_template_promotion_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL CHECK(template_version > 0),
                actor_label TEXT NOT NULL,
                simulation_run_id TEXT NOT NULL,
                simulation_score INTEGER NOT NULL CHECK(simulation_score BETWEEN 90 AND 100),
                config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
                previous_live_template_id INTEGER,
                previous_live_version INTEGER,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS call_agent_simulation_runs (
                run_id TEXT PRIMARY KEY,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                created_by TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                config_fingerprint TEXT NOT NULL,
                scenario_ids_json TEXT NOT NULL,
                results_json TEXT NOT NULL,
                score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
                passed_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                UNIQUE(template_id, idempotency_key),
                FOREIGN KEY(template_id) REFERENCES call_templates(id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_agent_simulation_runs_template_created ON call_agent_simulation_runs(template_id, created_at DESC)',

            // Auditable local mapping state for call-template compatibility with Vapi.
            `CREATE TABLE IF NOT EXISTS vapi_template_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                config_fingerprint TEXT NOT NULL,
                compatibility_status TEXT NOT NULL CHECK(compatibility_status IN ('compatible', 'incompatible')),
                mapping_status TEXT NOT NULL DEFAULT 'previewed' CHECK(mapping_status IN ('previewed', 'provisioned', 'stale')),
                sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK(sync_status IN ('not_synced', 'syncing', 'synced', 'unknown', 'failed')),
                vapi_assistant_id TEXT,
                vapi_assistant_version TEXT,
                summary_json TEXT NOT NULL,
                reviewed_by TEXT,
                last_sync_started_at DATETIME,
                last_synced_at DATETIME,
                last_sync_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(template_id, template_version, config_fingerprint)
            )`,

            `CREATE TABLE IF NOT EXISTS vapi_simulation_runs (
                vapi_run_id TEXT PRIMARY KEY,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                mapping_id INTEGER NOT NULL,
                assistant_id TEXT NOT NULL,
                suite_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                safety_status TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(template_id, idempotency_key),
                FOREIGN KEY(template_id) REFERENCES call_templates(id) ON DELETE CASCADE,
                FOREIGN KEY(mapping_id) REFERENCES vapi_template_mappings(id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_vapi_simulation_runs_template_created ON vapi_simulation_runs(template_id, created_at DESC)',

            `CREATE TABLE IF NOT EXISTS vapi_inbound_routes (
                phone_number_id TEXT PRIMARY KEY,
                mapping_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mapping_id) REFERENCES vapi_template_mappings(id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS vapi_call_campaigns (
                campaign_id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL UNIQUE,
                request_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                provider TEXT NOT NULL CHECK(provider = 'vapi'),
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                mapping_id INTEGER NOT NULL,
                phone_number_id TEXT NOT NULL,
                time_zone TEXT NOT NULL,
                calling_window_start TEXT NOT NULL,
                calling_window_end TEXT NOT NULL,
                calling_days_json TEXT NOT NULL,
                scheduled_start_at TEXT,
                max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 20),
                max_retries INTEGER NOT NULL DEFAULT 0 CHECK(max_retries BETWEEN 0 AND 3),
                retry_delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK(retry_delay_minutes BETWEEN 0 AND 1440),
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status = 'draft'),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(template_id) REFERENCES call_templates(id) ON DELETE RESTRICT,
                FOREIGN KEY(mapping_id) REFERENCES vapi_template_mappings(id) ON DELETE RESTRICT
            )`,
            'CREATE INDEX IF NOT EXISTS idx_vapi_call_campaigns_created ON vapi_call_campaigns(created_at DESC, campaign_id)',

            // Sanitized Vapi lifecycle events for call correlation and operations.
            `CREATE TABLE IF NOT EXISTS vapi_call_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                provider_call_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                provider_status TEXT,
                destination_type TEXT,
                ended_reason TEXT,
                duration_seconds INTEGER,
                assistant_id TEXT,
                template_id INTEGER,
                template_version INTEGER,
                config_fingerprint TEXT,
                event_timestamp TEXT,
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Enhanced webhook notifications table with delivery metrics
            `CREATE TABLE IF NOT EXISTS webhook_notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                notification_type TEXT NOT NULL,
                telegram_chat_id TEXT NOT NULL,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'retrying')),
                error_message TEXT,
                retry_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_attempt_at DATETIME,
                next_attempt_at DATETIME,
                sent_at DATETIME,
                delivery_time_ms INTEGER,
                telegram_message_id INTEGER,
                priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Notification delivery metrics for analytics - FIXED: Added UNIQUE constraint
            `CREATE TABLE IF NOT EXISTS notification_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                notification_type TEXT NOT NULL,
                total_count INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                failure_count INTEGER DEFAULT 0,
                avg_delivery_time_ms REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date, notification_type)
            )`,

            // Service health monitoring logs
            `CREATE TABLE IF NOT EXISTS service_health_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                service_name TEXT NOT NULL,
                status TEXT NOT NULL,
                details TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Application settings
            `CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Call performance metrics
            `CREATE TABLE IF NOT EXISTS call_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                metric_type TEXT NOT NULL,
                metric_value REAL,
                metric_data TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

            // Durable call job queue (outbound retries, callbacks)
            `CREATE TABLE IF NOT EXISTS call_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type TEXT NOT NULL,
                payload TEXT,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
                run_at DATETIME NOT NULL,
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                locked_at DATETIME,
                completed_at DATETIME
            )`,

            // Durable call-job dead-letter queue
            `CREATE TABLE IF NOT EXISTS call_job_dlq (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL UNIQUE,
                job_type TEXT NOT NULL,
                payload TEXT,
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                dead_letter_reason TEXT,
                status TEXT DEFAULT 'open' CHECK(status IN ('open', 'replayed')),
                replay_count INTEGER DEFAULT 0,
                last_replay_job_id INTEGER,
                replayed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Operational review cases for non-transfer escalations
            `CREATE TABLE IF NOT EXISTS review_cases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT,
                phone_number TEXT,
                requested_action TEXT,
                reason TEXT,
                notes TEXT,
                source TEXT DEFAULT 'api',
                status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
                created_by TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                resolved_at DATETIME
            )`,

            // Outbound API rate-limit counters (shared coordination across app instances)
            `CREATE TABLE IF NOT EXISTS outbound_rate_limits (
                scope TEXT NOT NULL,
                actor_key TEXT NOT NULL,
                window_start INTEGER NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (scope, actor_key)
            )`,

            // Enhanced user sessions tracking - FIXED: Added UNIQUE constraint
            `CREATE TABLE IF NOT EXISTS user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_chat_id TEXT NOT NULL UNIQUE,
                session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
                session_end DATETIME,
                total_calls INTEGER DEFAULT 0,
                successful_calls INTEGER DEFAULT 0,
                failed_calls INTEGER DEFAULT 0,
                total_duration INTEGER DEFAULT 0,
                last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Hierarchical GPT memory (session-level summary per call)
            `CREATE TABLE IF NOT EXISTS gpt_call_memory (
                call_sid TEXT PRIMARY KEY,
                summary TEXT,
                summary_turns INTEGER DEFAULT 0,
                summary_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT
            )`,

            // Long-term facts extracted from conversation
            `CREATE TABLE IF NOT EXISTS gpt_memory_facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL,
                fact_key TEXT NOT NULL,
                fact_text TEXT NOT NULL,
                confidence REAL DEFAULT 0.5,
                source TEXT DEFAULT 'derived',
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(call_sid, fact_key)
            )`,

            // Tool audit + idempotency record
            `CREATE TABLE IF NOT EXISTS gpt_tool_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT,
                trace_id TEXT,
                tool_name TEXT NOT NULL,
                idempotency_key TEXT,
                input_hash TEXT,
                request_payload TEXT,
                response_payload TEXT,
                status TEXT NOT NULL,
                error_message TEXT,
                duration_ms INTEGER,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable idempotency lock/result store for side-effect GPT tools
            `CREATE TABLE IF NOT EXISTS gpt_tool_idempotency (
                idempotency_key TEXT PRIMARY KEY,
                call_sid TEXT,
                trace_id TEXT,
                tool_name TEXT NOT NULL,
                input_hash TEXT,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ok', 'failed')),
                response_payload TEXT,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable PayPal connector state for payment links, invoices, and refunds
            `CREATE TABLE IF NOT EXISTS paypal_payment_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT,
                action TEXT NOT NULL,
                external_id TEXT NOT NULL UNIQUE,
                status TEXT,
                amount TEXT,
                currency TEXT,
                approval_url TEXT,
                idempotency_key TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // PayPal webhook/event idempotency ledger
            `CREATE TABLE IF NOT EXISTS paypal_payment_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                external_event_id TEXT NOT NULL UNIQUE,
                event_type TEXT,
                resource_id TEXT,
                status TEXT,
                payload TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable Stripe connector state for checkout sessions, invoices, and refunds
            `CREATE TABLE IF NOT EXISTS stripe_payment_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT,
                action TEXT NOT NULL,
                external_id TEXT NOT NULL UNIQUE,
                status TEXT,
                amount TEXT,
                currency TEXT,
                approval_url TEXT,
                idempotency_key TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Stripe webhook/event idempotency ledger
            `CREATE TABLE IF NOT EXISTS stripe_payment_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                external_event_id TEXT NOT NULL UNIQUE,
                event_type TEXT,
                resource_id TEXT,
                status TEXT,
                payload TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable Square connector state for checkout links, payments, orders, and refunds
            `CREATE TABLE IF NOT EXISTS square_payment_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT,
                action TEXT NOT NULL,
                external_id TEXT NOT NULL UNIQUE,
                status TEXT,
                amount TEXT,
                currency TEXT,
                approval_url TEXT,
                idempotency_key TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Square webhook/event idempotency ledger
            `CREATE TABLE IF NOT EXISTS square_payment_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                external_event_id TEXT NOT NULL UNIQUE,
                event_type TEXT,
                resource_id TEXT,
                status TEXT,
                payload TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Indexed related Square IDs for payment link, order, payment, and refund correlation
            `CREATE TABLE IF NOT EXISTS square_payment_session_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_external_id TEXT NOT NULL,
                related_type TEXT NOT NULL,
                related_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(related_type, related_id)
            )`,

            // Durable provider webhook idempotency guard
            `CREATE TABLE IF NOT EXISTS provider_event_idempotency (
                event_key TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_webhook_events (
                webhook_request_id TEXT PRIMARY KEY,
                call_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                webhook_id TEXT NOT NULL,
                event_type TEXT NOT NULL CHECK(event_type IN ('call_started', 'call_completed', 'call_failed', 'call_turn', 'post_call_analysis')),
                event_timestamp TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,

            // Outbound call idempotency guard (provider-agnostic)
            `CREATE TABLE IF NOT EXISTS outbound_call_idempotency (
                idempotency_key TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                business_id TEXT,
                request_hash TEXT,
                call_sid TEXT,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
                response_payload TEXT,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_campaigns (
                campaign_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                approved_by TEXT,
                request_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                campaign_name TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                from_number_id TEXT NOT NULL,
                target_concurrency_limit INTEGER NOT NULL,
                scheduled_at TEXT,
                status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'submitting', 'submitted', 'unknown', 'blocked')),
                recipient_count INTEGER NOT NULL CHECK(recipient_count BETWEEN 1 AND 25),
                ready_count INTEGER NOT NULL,
                blocked_count INTEGER NOT NULL,
                encryption_key_version INTEGER NOT NULL,
                provider_batch_id TEXT,
                provider_status TEXT,
                provider_retry_count INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(business_id, request_key)
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_campaign_recipients (
                campaign_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                encrypted_destination TEXT NOT NULL,
                encrypted_dynamic_variables TEXT,
                destination_masked TEXT NOT NULL,
                readiness TEXT NOT NULL CHECK(readiness IN ('ready', 'blocked')),
                reason_code TEXT NOT NULL,
                provider_recipient_id TEXT,
                provider_call_id TEXT,
                provider_status TEXT,
                provider_end_reason TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(campaign_id, position),
                FOREIGN KEY(campaign_id) REFERENCES cartesia_campaigns(campaign_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_call_review_rules (
                business_id TEXT PRIMARY KEY,
                review_failed_calls INTEGER NOT NULL DEFAULT 1 CHECK(review_failed_calls IN (0, 1)),
                review_tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(review_tool_calls IN (0, 1)),
                review_missing_summary INTEGER NOT NULL DEFAULT 0 CHECK(review_missing_summary IN (0, 1)),
                updated_by TEXT,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_campaign_daily_reservations (
                campaign_id TEXT NOT NULL,
                business_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                usage_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('reserved', 'released')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                released_at DATETIME,
                PRIMARY KEY(campaign_id, recipient_position),
                FOREIGN KEY(campaign_id) REFERENCES cartesia_campaigns(campaign_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_campaign_retry_attempts (
                campaign_id TEXT NOT NULL,
                retry_number INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('submitting', 'accepted', 'unknown', 'rejected')),
                candidate_count INTEGER NOT NULL,
                actor_id TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(campaign_id, retry_number),
                FOREIGN KEY(campaign_id) REFERENCES cartesia_campaigns(campaign_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_campaign_retry_daily_reservations (
                campaign_id TEXT NOT NULL,
                retry_number INTEGER NOT NULL,
                business_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                usage_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('reserved', 'released')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                released_at DATETIME,
                PRIMARY KEY(campaign_id, retry_number, recipient_position),
                FOREIGN KEY(campaign_id) REFERENCES cartesia_campaigns(campaign_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_voice_governance (
                consent_id TEXT PRIMARY KEY,
                actor_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('instant_clone', 'pro_clone_dataset')),
                resource_id TEXT,
                resource_type TEXT CHECK(resource_type IS NULL OR resource_type IN ('voice', 'dataset', 'fine_tune')),
                fine_tune_id TEXT,
                sample_count INTEGER NOT NULL DEFAULT 0,
                active_operations INTEGER NOT NULL DEFAULT 0,
                operation_token TEXT,
                operation_started_at DATETIME,
                resource_name TEXT,
                status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'deleted', 'provider_failed')),
                consented_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revoked_at DATETIME,
                deleted_at DATETIME
            )`,
            'CREATE INDEX IF NOT EXISTS idx_cartesia_voice_governance_status ON cartesia_voice_governance(status, consented_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_campaigns_scope ON cartesia_campaigns(business_id, status, created_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_campaign_daily_usage ON cartesia_campaign_daily_reservations(business_id, usage_date, status)',

            // Cartesia Managed Agents call metadata only. Transcript and summary
            // content is fetched from Cartesia on demand and is not copied here.
            `CREATE TABLE IF NOT EXISTS cartesia_calls (
                local_call_id TEXT PRIMARY KEY,
                provider_call_id TEXT UNIQUE NOT NULL,
                business_id TEXT,
                agent_id TEXT NOT NULL,
                from_number_id TEXT,
                phone_number TEXT,
                direction TEXT CHECK(direction IS NULL OR direction IN ('inbound', 'outbound')),
                status TEXT NOT NULL CHECK(status IN ('created', 'started', 'completed', 'failed')),
                start_time TEXT,
                end_time TEXT,
                end_reason TEXT,
                telephony_account_type TEXT CHECK(telephony_account_type IS NULL OR telephony_account_type IN ('cartesia', 'twilio', 'sip_trunk')),
                last_event_timestamp TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable Cartesia batch snapshots. Recipient rows intentionally omit
            // dynamic variables and free-form provider error messages.
            `CREATE TABLE IF NOT EXISTS cartesia_call_batches (
                provider_batch_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                name TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                from_number_id TEXT NOT NULL,
                region TEXT,
                target_concurrency_limit INTEGER,
                status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
                total_calls_scheduled INTEGER NOT NULL DEFAULT 0,
                total_calls_dispatched INTEGER NOT NULL DEFAULT 0,
                total_calls_finished INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                provider_created_at TEXT,
                scheduled_at TEXT,
                admitted_at TEXT,
                provider_updated_at TEXT,
                last_synced_at TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                reconcile_attempt_count INTEGER NOT NULL DEFAULT 0,
                reconcile_next_at TEXT,
                reconcile_lease_until TEXT,
                reconcile_lease_token TEXT,
                reconcile_last_error_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_call_batch_recipients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_batch_id TEXT NOT NULL,
                attempt_key TEXT NOT NULL,
                provider_recipient_id TEXT,
                phone_number TEXT NOT NULL,
                provider_status TEXT,
                provider_call_id TEXT,
                end_reason TEXT,
                has_provider_error INTEGER NOT NULL DEFAULT 0 CHECK(has_provider_error IN (0, 1)),
                local_state TEXT NOT NULL CHECK(local_state IN ('awaiting_provider_snapshot', 'provider_snapshot')),
                provider_created_at TEXT,
                snapshot_updated_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(provider_batch_id, attempt_key),
                FOREIGN KEY(provider_batch_id) REFERENCES cartesia_call_batches(provider_batch_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS cartesia_batch_retention_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type = 'admin_api'),
                actor_id TEXT NOT NULL,
                provider_batch_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('recipient_purge')),
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed')),
                recipient_count INTEGER NOT NULL DEFAULT 0,
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable dedupe ledger for Cartesia's stable webhook_request_id.
            `CREATE TABLE IF NOT EXISTS cartesia_webhook_events (
                webhook_request_id TEXT PRIMARY KEY,
                provider_call_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_timestamp TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Append-only Cartesia private call-review access metadata; never store call content.
            `CREATE TABLE IF NOT EXISTS cartesia_call_review_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_telegram_id TEXT NOT NULL,
                business_id TEXT,
                provider_call_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('allowed', 'denied', 'failed')),
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Metadata-only audit of Cartesia administrative actions; never store credentials or provider payloads.
            `CREATE TABLE IF NOT EXISTS cartesia_admin_action_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_telegram_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('phone_agent_assignment')),
                resource_type TEXT NOT NULL CHECK(resource_type IN ('phone_number')),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                previous_agent_id TEXT,
                target_agent_id TEXT,
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Admin-token phone-number mutations have a distinct actor type and omit contact details.
            `CREATE TABLE IF NOT EXISTS cartesia_phone_number_operation_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type IN ('admin_api', 'miniapp_user')),
                actor_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('phone_agent_assignment', 'phone_number_import', 'phone_number_provision', 'phone_number_release')),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                target_agent_id TEXT,
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Metadata-only audit of Cartesia telephony provider configuration changes.
            `CREATE TABLE IF NOT EXISTS cartesia_provider_operation_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type = 'admin_api'),
                actor_id TEXT NOT NULL CHECK(actor_id = 'shared_admin_token'),
                action TEXT NOT NULL CHECK(action IN ('twilio_provider_create', 'twilio_provider_update', 'sip_provider_create', 'sip_provider_update', 'telephony_provider_delete')),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Additive metadata-only audit table for agent webhook changes; the older provider audit table has a fixed action CHECK constraint.
            `CREATE TABLE IF NOT EXISTS cartesia_webhook_assignment_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type = 'admin_api'),
                actor_id TEXT NOT NULL CHECK(actor_id = 'shared_admin_token'),
                action TEXT NOT NULL CHECK(action = 'agent_webhook_assignment'),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            `CREATE TABLE IF NOT EXISTS cartesia_webhook_creation_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type = 'admin_api'),
                actor_id TEXT NOT NULL CHECK(actor_id = 'shared_admin_token'),
                action TEXT NOT NULL CHECK(action = 'webhook_create'),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Call dispatch/cancellation audit intentionally excludes destination and conversation data.
            `CREATE TABLE IF NOT EXISTS cartesia_call_operation_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_type TEXT NOT NULL CHECK(actor_type = 'admin_api'),
                actor_id TEXT NOT NULL CHECK(actor_id = 'shared_admin_token'),
                action TEXT NOT NULL CHECK(action IN ('outbound_call_dispatch', 'outbound_call_cancel')),
                resource_id TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('requested', 'succeeded', 'failed', 'outcome_unknown')),
                request_fingerprint TEXT NOT NULL,
                reason_code TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // CALL-E normalized lifecycle and durable event cursor; deliberately excludes phone, transcript, result, and raw event payloads.
            `CREATE TABLE IF NOT EXISTS call_e_reconciliation (
                local_call_id TEXT PRIMARY KEY,
                provider_call_id TEXT UNIQUE,
                business_id TEXT,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                request_hash TEXT NOT NULL,
                result_schema_json TEXT NOT NULL,
                execution_status TEXT,
                call_outcome TEXT,
                result_status TEXT,
                error_code TEXT,
                event_cursor TEXT,
                last_event_id TEXT,
                seen_event_ids_json TEXT NOT NULL DEFAULT '[]',
                ivr_dtmf_observed INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Stores only the terminal webhook's stable identifiers, never its PII-bearing payload.
            `CREATE TABLE IF NOT EXISTS call_e_webhook_receipts (
                provider_call_id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL CHECK(event_type IN ('call.completed', 'call.failed', 'call.canceled')),
                processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,

            // CALL-E campaign rehearsal reports contain masked destinations only; they are not a dispatch queue.
            `CREATE TABLE IF NOT EXISTS call_e_campaign_reviews (
                campaign_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                schema_fingerprint TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                created_by TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'rejected')) DEFAULT 'draft',
                recipient_count INTEGER NOT NULL,
                ready_count INTEGER NOT NULL,
                blocked_count INTEGER NOT NULL,
                reviewed_by TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reviewed_at DATETIME,
                CHECK(recipient_count BETWEEN 1 AND 25),
                CHECK(ready_count >= 0 AND blocked_count >= 0 AND ready_count + blocked_count = recipient_count)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_campaign_review_recipients (
                campaign_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                destination_masked TEXT NOT NULL,
                readiness TEXT NOT NULL CHECK(readiness IN ('ready', 'blocked')),
                reason_code TEXT NOT NULL CHECK(reason_code IN ('compatible', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired', 'consent_not_effective', 'opted_out', 'policy_storage_unavailable', 'template_incompatible', 'preview_failed')),
                PRIMARY KEY(campaign_id, position),
                FOREIGN KEY(campaign_id) REFERENCES call_e_campaign_reviews(campaign_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_campaign_reviews_business_status ON call_e_campaign_reviews(business_id, status, created_at DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_campaign_execution_rehearsals (
                rehearsal_id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL,
                business_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                started_by TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('completed')),
                recipient_count INTEGER NOT NULL,
                ready_count INTEGER NOT NULL,
                blocked_count INTEGER NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(campaign_id, request_hash),
                FOREIGN KEY(campaign_id) REFERENCES call_e_campaign_reviews(campaign_id) ON DELETE CASCADE,
                CHECK(recipient_count BETWEEN 1 AND 25),
                CHECK(ready_count >= 0 AND blocked_count >= 0 AND ready_count + blocked_count = recipient_count)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_campaign_execution_rehearsal_rows (
                rehearsal_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('simulated_ready', 'blocked')),
                reason_code TEXT NOT NULL CHECK(reason_code IN ('compatible', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired', 'consent_not_effective', 'opted_out', 'policy_storage_unavailable', 'template_incompatible', 'preview_failed')),
                PRIMARY KEY(rehearsal_id, position),
                FOREIGN KEY(rehearsal_id) REFERENCES call_e_campaign_execution_rehearsals(rehearsal_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_campaign_rehearsals_scope ON call_e_campaign_execution_rehearsals(business_id, campaign_id, created_at DESC)',

            // Durable mission orchestration; destinations are encrypted by the service before persistence.
            `CREATE TABLE IF NOT EXISTS call_e_campaign_missions (
                mission_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                campaign_id TEXT NOT NULL,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                result_schema_json TEXT NOT NULL,
                created_by TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending_approval', 'approved', 'rejected', 'running', 'paused', 'completed', 'canceled', 'needs_review')),
                reviewed_by TEXT,
                reviewed_at DATETIME,
                recipient_count INTEGER NOT NULL CHECK(recipient_count BETWEEN 1 AND 25),
                scheduled_at DATETIME,
                budget_limit_minor INTEGER,
                per_call_cost_ceiling_minor INTEGER,
                budget_currency TEXT,
                encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK(encryption_key_version > 0),
                sensitive_data_expires_at DATETIME,
                sensitive_data_purged_at DATETIME,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(campaign_id) REFERENCES call_e_campaign_reviews(campaign_id)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_campaign_mission_recipients (
                mission_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                encrypted_destination TEXT NOT NULL,
                destination_masked TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'accepted', 'completed', 'failed', 'blocked', 'needs_review', 'canceled')),
                local_call_id TEXT UNIQUE,
                error_code TEXT,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(mission_id, position),
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_campaign_mission_resolutions (
                mission_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                business_id TEXT NOT NULL,
                resolved_by TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision IN ('continue', 'cancel')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(mission_id, idempotency_key),
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            // Single configured worker lease per mission; stores status codes only, never request/recipient data.
            `CREATE TABLE IF NOT EXISTS call_e_campaign_mission_worker_leases (
                mission_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                lease_owner TEXT,
                lease_token TEXT,
                lease_expires_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_state TEXT NOT NULL DEFAULT 'idle' CHECK(last_state IN ('idle', 'leased', 'call_accepted', 'waiting_for_call', 'waiting_for_result', 'recovery_required', 'needs_review', 'completed', 'canceled', 'error')),
                last_error_code TEXT,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_business_safety_policies (
                business_id TEXT PRIMARY KEY,
                max_calls_per_day INTEGER NOT NULL DEFAULT 0 CHECK(max_calls_per_day BETWEEN 0 AND 1000),
                quiet_hours_start TEXT,
                quiet_hours_end TEXT,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                emergency_stop INTEGER NOT NULL DEFAULT 1 CHECK(emergency_stop IN (0, 1)),
                contact_cooldown_hours INTEGER NOT NULL DEFAULT 0 CHECK(contact_cooldown_hours BETWEEN 0 AND 8760),
                updated_by TEXT NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_worker_controls (
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
                updated_by TEXT NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(business_id, mission_id),
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_business_dispatch_reservations (
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                usage_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('reserved', 'released')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                released_at DATETIME,
                PRIMARY KEY(mission_id, recipient_position),
                FOREIGN KEY(mission_id, recipient_position) REFERENCES call_e_campaign_mission_recipients(mission_id, position) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_dispatch_reservations_usage ON call_e_business_dispatch_reservations(business_id, usage_date, status)',
            `CREATE TABLE IF NOT EXISTS call_e_operations_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('safety_policy_updated', 'worker_paused', 'worker_resumed', 'sensitive_data_purged')),
                mission_id TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_operations_audit_scope ON call_e_operations_audit(business_id, created_at DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_business_mission_policies (
                business_id TEXT PRIMARY KEY,
                secondary_approval_threshold INTEGER NOT NULL DEFAULT 26 CHECK(secondary_approval_threshold BETWEEN 2 AND 26),
                approval_ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK(approval_ttl_hours BETWEEN 1 AND 720),
                review_sla_minutes INTEGER NOT NULL DEFAULT 0 CHECK(review_sla_minutes BETWEEN 0 AND 10080),
                review_repeat_minutes INTEGER NOT NULL DEFAULT 0 CHECK(review_repeat_minutes BETWEEN 0 AND 10080),
                updated_by TEXT NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_secondary_approvals (
                mission_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                reviewed_by TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision = 'approve'),
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_budget_reservations (
                mission_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                reserved_minor INTEGER NOT NULL CHECK(reserved_minor > 0),
                status TEXT NOT NULL CHECK(status IN ('reserved', 'released')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                released_at DATETIME,
                PRIMARY KEY(mission_id, recipient_position),
                FOREIGN KEY(mission_id, recipient_position) REFERENCES call_e_campaign_mission_recipients(mission_id, position) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_contact_dispatch_history (
                business_id TEXT NOT NULL,
                destination_hash TEXT NOT NULL CHECK(length(destination_hash) = 64),
                mission_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('reserved', 'accepted', 'released')),
                attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(mission_id, recipient_position),
                FOREIGN KEY(mission_id, recipient_position) REFERENCES call_e_campaign_mission_recipients(mission_id, position) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_contact_dispatch_cooldown ON call_e_contact_dispatch_history(business_id, destination_hash, status, attempted_at DESC)',
            `CREATE TABLE IF NOT EXISTS outbound_contact_dispatch_history (
                reservation_key TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                destination_hash TEXT NOT NULL CHECK(length(destination_hash) = 64),
                provider TEXT NOT NULL CHECK(provider IN ('twilio', 'plivo', 'vonage', 'vapi', 'call_e', 'cartesia')),
                status TEXT NOT NULL CHECK(status IN ('reserved', 'accepted', 'released')),
                attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            'CREATE INDEX IF NOT EXISTS idx_outbound_contact_dispatch_cooldown ON outbound_contact_dispatch_history(business_id, destination_hash, status, attempted_at DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_mission_escalations (
                mission_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                escalated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deadline_at DATETIME,
                next_escalation_at DATETIME,
                escalation_count INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_review_actions (
                action_id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('assigned', 'acknowledged')),
                actor_id TEXT NOT NULL,
                assigned_to TEXT,
                idempotency_key TEXT NOT NULL UNIQUE,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_mission_review_actions_scope ON call_e_mission_review_actions(business_id, mission_id, action_id DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_mission_escalation_actions (
                action_id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('reassigned', 'deadline_extended', 'repeat_escalated')),
                actor_id TEXT NOT NULL,
                assigned_to TEXT,
                deadline_at TEXT,
                request_hash TEXT,
                idempotency_key TEXT NOT NULL UNIQUE,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_mission_escalation_actions_scope ON call_e_mission_escalation_actions(business_id, mission_id, action_id DESC)',
            `CREATE TRIGGER IF NOT EXISTS call_e_mission_escalation_actions_no_update BEFORE UPDATE ON call_e_mission_escalation_actions
             BEGIN SELECT RAISE(ABORT, 'CALL-E escalation actions are append-only'); END`,
            `CREATE TRIGGER IF NOT EXISTS call_e_mission_escalation_actions_no_delete BEFORE DELETE ON call_e_mission_escalation_actions
             BEGIN SELECT RAISE(ABORT, 'CALL-E escalation actions are append-only'); END`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_cdr_imports (
                import_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                records_json TEXT NOT NULL,
                preview_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('staged', 'committed')),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                committed_at DATETIME,
                UNIQUE(business_id, idempotency_key),
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_mission_cdr_import_scope ON call_e_mission_cdr_imports(business_id, mission_id, created_at DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_mission_usage_records (
                usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                recipient_position INTEGER NOT NULL,
                provider TEXT NOT NULL CHECK(provider IN ('twilio', 'plivo', 'vonage', 'other')),
                provider_call_id TEXT NOT NULL,
                amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
                currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
                billed_duration_seconds INTEGER,
                source_type TEXT NOT NULL CHECK(source_type IN ('provider_cdr', 'invoice', 'operator_estimate')),
                source_reference TEXT NOT NULL,
                recorded_by TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                occurred_at TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(business_id, provider, provider_call_id),
                UNIQUE(business_id, idempotency_key),
                FOREIGN KEY(mission_id, recipient_position) REFERENCES call_e_campaign_mission_recipients(mission_id, position) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_report_digest_subscriptions (
                business_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                interval_hours INTEGER NOT NULL CHECK(interval_hours IN (24, 168)),
                enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                next_delivery_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(business_id, actor_id)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_activity (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                mission_id TEXT NOT NULL,
                event_key TEXT NOT NULL UNIQUE,
                actor_id TEXT,
                event_type TEXT NOT NULL CHECK(event_type IN ('mission_created', 'approval_recorded', 'mission_resolved', 'recipient_transition', 'recipient_retry_requested', 'mission_advanced')),
                recipient_position INTEGER,
                state TEXT NOT NULL,
                error_code TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(mission_id) REFERENCES call_e_campaign_missions(mission_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_mission_activity_scope ON call_e_mission_activity(business_id, mission_id, event_id DESC)',
            `CREATE TRIGGER IF NOT EXISTS call_e_mission_activity_no_update
             BEFORE UPDATE ON call_e_mission_activity
             BEGIN SELECT RAISE(ABORT, 'CALL-E mission activity is append-only'); END`,
            `CREATE TRIGGER IF NOT EXISTS call_e_mission_activity_no_delete
             BEFORE DELETE ON call_e_mission_activity
             BEGIN SELECT RAISE(ABORT, 'CALL-E mission activity is append-only'); END`,
            `CREATE TABLE IF NOT EXISTS call_e_business_provider_routing (
                business_id TEXT PRIMARY KEY,
                provider_order_json TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_mission_alert_subscriptions (
                business_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
                last_notified_event_id INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(business_id, actor_id)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_goal_run_requests (
                goal_run_request_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                goal_id TEXT NOT NULL,
                goal_title TEXT NOT NULL,
                published_run_spec_id TEXT NOT NULL,
                published_run_spec_version INTEGER NOT NULL CHECK(published_run_spec_version > 0),
                destination_masked TEXT NOT NULL,
                encrypted_payload TEXT NOT NULL,
                encrypted_result TEXT,
                encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK(encryption_key_version > 0),
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                idempotency_hash TEXT NOT NULL CHECK(length(idempotency_hash) = 64),
                result_schema_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending_approval', 'approved', 'rejected', 'submitting', 'recovery_required', 'running', 'completed', 'failed', 'canceled', 'needs_review')),
                provider_goal_run_id TEXT,
                execution_status TEXT,
                call_outcome TEXT,
                result_status TEXT,
                error_code TEXT,
                created_by TEXT NOT NULL,
                reviewed_by TEXT,
                reviewed_at DATETIME,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                sensitive_data_expires_at DATETIME,
                sensitive_data_purged_at DATETIME,
                UNIQUE(business_id, idempotency_hash)
            )`,
            `CREATE TABLE IF NOT EXISTS call_e_goal_run_reviews (
                goal_run_request_id TEXT NOT NULL,
                business_id TEXT NOT NULL,
                reviewed_by TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(goal_run_request_id),
                FOREIGN KEY(goal_run_request_id) REFERENCES call_e_goal_run_requests(goal_run_request_id) ON DELETE CASCADE
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_goal_run_requests_scope ON call_e_goal_run_requests(business_id, status, created_at DESC)',
            `CREATE TABLE IF NOT EXISTS call_e_approval_decisions (
                decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL CHECK(entity_type IN ('campaign', 'mission')),
                entity_id TEXT NOT NULL,
                business_id TEXT NOT NULL,
                reviewed_by TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
                request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(entity_type, entity_id)
            )`,
            `INSERT OR IGNORE INTO call_e_approval_decisions
                (entity_type, entity_id, business_id, reviewed_by, decision, request_hash, created_at)
             SELECT 'campaign', campaign_id, business_id, reviewed_by,
                    CASE WHEN status = 'approved' THEN 'approve' ELSE 'reject' END, request_hash,
                    COALESCE(reviewed_at, created_at)
             FROM call_e_campaign_reviews
             WHERE status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL`,
            `INSERT OR IGNORE INTO call_e_approval_decisions
                (entity_type, entity_id, business_id, reviewed_by, decision, request_hash, created_at)
             SELECT 'mission', mission_id, business_id, reviewed_by,
                    CASE WHEN status = 'rejected' THEN 'reject' ELSE 'approve' END,
                    request_hash, COALESCE(reviewed_at, created_at)
             FROM call_e_campaign_missions
             WHERE status != 'pending_approval' AND reviewed_by IS NOT NULL`,
            `CREATE TRIGGER IF NOT EXISTS call_e_approval_decisions_no_update
             BEFORE UPDATE ON call_e_approval_decisions
             BEGIN SELECT RAISE(ABORT, 'CALL-E approval decisions are append-only'); END`,
            `CREATE TRIGGER IF NOT EXISTS call_e_approval_decisions_no_delete
             BEFORE DELETE ON call_e_approval_decisions
             BEGIN SELECT RAISE(ABORT, 'CALL-E approval decisions are append-only'); END`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_approval_decisions_scope ON call_e_approval_decisions(business_id, entity_type, entity_id, decision_id)',
            'CREATE INDEX IF NOT EXISTS idx_call_e_campaign_missions_scope ON call_e_campaign_missions(business_id, status, created_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_call_e_campaign_mission_recipients_queue ON call_e_campaign_mission_recipients(mission_id, status, position)',

            // One lifetime CALL-E pilot slot. A different request key cannot replace a reserved or accepted call.
            `CREATE TABLE IF NOT EXISTS call_e_pilot_dispatch_guard (
                singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
                reservation_key TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('reserved', 'consumed')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Consent/opt-out evidence is append-only and scoped to the template's business; destination is PII.
            `CREATE TABLE IF NOT EXISTS call_e_contact_policy_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                request_hash TEXT NOT NULL,
                business_id TEXT NOT NULL,
                destination TEXT NOT NULL,
                event_type TEXT NOT NULL CHECK(event_type IN ('consent_granted', 'opted_out')),
                source TEXT NOT NULL CHECK(source IN ('web_form', 'written', 'verbal', 'other', 'recipient_request', 'operator_report', 'provider_report')),
                evidence_reference TEXT,
                occurred_at TEXT NOT NULL,
                expires_at TEXT,
                recorded_by_telegram_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                CHECK((event_type = 'consent_granted' AND evidence_reference IS NOT NULL) OR (event_type = 'opted_out' AND evidence_reference IS NULL))
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_contact_policy_scope ON call_e_contact_policy_events(business_id, destination, event_type, occurred_at DESC, id DESC)',

            `CREATE TABLE IF NOT EXISTS call_e_business_operator_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id TEXT NOT NULL,
                telegram_id TEXT NOT NULL,
                event_type TEXT NOT NULL CHECK(event_type IN ('access_granted', 'access_revoked')),
                role TEXT CHECK(role IN ('policy_manager', 'call_operator')),
                actor_type TEXT NOT NULL DEFAULT 'admin_token' CHECK(actor_type = 'admin_token'),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                CHECK((event_type = 'access_granted' AND role IS NOT NULL) OR (event_type = 'access_revoked' AND role IS NULL))
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_business_operator_events_scope ON call_e_business_operator_events(business_id, telegram_id, id DESC)',

            `CREATE TABLE IF NOT EXISTS business_integration_connections (
                connection_id TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                secret_reference TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
                created_by TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                revoked_by TEXT,
                revoked_at DATETIME
            )`,
            'CREATE INDEX IF NOT EXISTS idx_business_integration_connections_scope ON business_integration_connections(business_id, status, provider)',

            `CREATE TABLE IF NOT EXISTS call_e_operator_confirmation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                confirmation_key TEXT NOT NULL UNIQUE,
                request_hash TEXT NOT NULL,
                business_id TEXT NOT NULL,
                template_id INTEGER NOT NULL,
                template_version INTEGER NOT NULL,
                preview_fingerprint TEXT NOT NULL,
                recorded_by_telegram_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            'CREATE INDEX IF NOT EXISTS idx_call_e_operator_confirmation_scope ON call_e_operator_confirmation_events(business_id, template_id, id DESC)',

            // Durable idempotency lock/result store for call-script mutations
            `CREATE TABLE IF NOT EXISTS call_script_mutation_idempotency (
                idempotency_key TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done')),
                response_status INTEGER,
                response_body TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Durable Vonage UUID -> call SID mapping for restart-safe reconciliation
            `CREATE TABLE IF NOT EXISTS vonage_call_mappings (
                vonage_uuid TEXT PRIMARY KEY,
                call_sid TEXT NOT NULL,
                source TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Persisted runtime snapshot for active calls
            `CREATE TABLE IF NOT EXISTS call_runtime_state (
                call_sid TEXT PRIMARY KEY,
                provider TEXT,
                interaction_count INTEGER DEFAULT 0,
                flow_state TEXT,
                call_mode TEXT,
                digit_capture_active INTEGER DEFAULT 0,
                snapshot TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Post-call QA scorecards (single latest report per call_sid)
            `CREATE TABLE IF NOT EXISTS call_quality_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                call_sid TEXT NOT NULL UNIQUE,
                profile TEXT,
                status TEXT NOT NULL,
                score INTEGER,
                passed INTEGER DEFAULT 0,
                shadow_mode INTEGER DEFAULT 1,
                model_version TEXT,
                transcript_turns INTEGER DEFAULT 0,
                user_turns INTEGER DEFAULT 0,
                ai_turns INTEGER DEFAULT 0,
                duration_seconds INTEGER DEFAULT 0,
                findings TEXT,
                metrics TEXT,
                recommendations TEXT,
                evaluated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(call_sid) REFERENCES calls(call_sid)
            )`,

        ];

        for (const table of tables) {
            await new Promise((resolve, reject) => {
                this.db.run(table, (err) => {
                    if (err) {
                        console.error('Error creating enhanced table:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }

        await new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE call_handoff_sessions
                 SET state = 'expired', destination_e164 = '', updated_at = CURRENT_TIMESTAMP
                 WHERE state = 'awaiting_confirmation' AND expires_at <= ?`,
                [Date.now()],
                (err) => err ? reject(err) : resolve(),
            );
        });

        await this.ensureCallColumns(['digit_summary', 'digit_count', 'last_otp', 'last_otp_masked', 'direction', 'business_id']);
        await this.ensureCartesiaBatchReconciliationColumns();
        await this.ensureCallEContactPolicyColumns();
        await this.ensureCallEReconciliationBusinessColumn();
        await this.ensureCallEReconciliationIvrColumn();
        await this.ensureTemplateColumns([
            'version',
            'objective_tags',
            'supports_payment',
            'supports_digit_capture',
            'requires_otp',
            'default_profile',
            'expected_length',
            'allow_terminator',
            'terminator_char',
            'payment_enabled',
            'payment_connector',
            'payment_amount',
            'payment_currency',
            'payment_description',
            'payment_policy',
            'payment_start_message',
            'payment_success_message',
            'payment_failure_message',
            'payment_retry_message',
            'agent_config_json',
            'lifecycle_state',
            'submitted_for_review_at',
            'reviewed_at',
            'reviewed_by',
            'review_note',
            'live_at',
            'live_by'
        ]);
        await this.ensureNotificationColumns(['last_attempt_at', 'next_attempt_at']);
        await this.ensureCallQualityReportColumns(['profile']);
        await this.ensureVapiCallEventColumns(['destination_type']);

        // Create comprehensive indexes for optimal performance
        const indexes = [
            // Call indexes
            'CREATE INDEX IF NOT EXISTS idx_calls_call_sid ON calls(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_calls_user_chat_id ON calls(user_chat_id)',
            'CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status)',
            'CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_calls_twilio_status ON calls(twilio_status)',
            'CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction)',
            'CREATE INDEX IF NOT EXISTS idx_calls_phone_number ON calls(phone_number)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_calls_business_created ON cartesia_calls(business_id, created_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_calls_status_updated ON cartesia_calls(status, updated_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_batches_business_created ON cartesia_call_batches(business_id, created_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_batches_reconciliation_due ON cartesia_call_batches(status, reconcile_next_at, reconcile_lease_until)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_batch_recipients_batch_status ON cartesia_call_batch_recipients(provider_batch_id, provider_status)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_batch_recipients_call_id ON cartesia_call_batch_recipients(provider_call_id)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_batch_retention_audit_created ON cartesia_batch_retention_audit(created_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_webhook_call_event ON cartesia_webhook_events(provider_call_id, event_timestamp)',
            
            // Transcript indexes for both table names
            'CREATE INDEX IF NOT EXISTS idx_transcripts_call_sid ON call_transcripts(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_transcripts_timestamp ON call_transcripts(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_transcripts_speaker ON call_transcripts(speaker)',
            'CREATE INDEX IF NOT EXISTS idx_transcripts_personality ON call_transcripts(personality_used)',
            'CREATE INDEX IF NOT EXISTS idx_legacy_transcripts_call_sid ON transcripts(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_legacy_transcripts_timestamp ON transcripts(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_legacy_transcripts_speaker ON transcripts(speaker)',
            
            // State indexes
            'CREATE INDEX IF NOT EXISTS idx_states_call_sid ON call_states(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_states_timestamp ON call_states(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_states_state ON call_states(state)',
            'CREATE INDEX IF NOT EXISTS idx_call_outcomes_primary_flow ON call_outcomes(primary_flow)',
            'CREATE INDEX IF NOT EXISTS idx_call_outcomes_disposition ON call_outcomes(disposition)',
            'CREATE INDEX IF NOT EXISTS idx_call_outcomes_updated_at ON call_outcomes(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_caller_flags_status ON caller_flags(status)',
            'CREATE INDEX IF NOT EXISTS idx_call_digits_call_sid ON call_digits(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_call_digits_profile ON call_digits(profile)',
            'CREATE INDEX IF NOT EXISTS idx_call_digits_created_at ON call_digits(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_call_templates_name ON call_templates(name)',
            'CREATE INDEX IF NOT EXISTS idx_call_templates_lifecycle_state ON call_templates(lifecycle_state)',
            'CREATE INDEX IF NOT EXISTS idx_call_template_versions_template_version ON call_template_versions(template_id, version)',
            'CREATE INDEX IF NOT EXISTS idx_call_template_promotion_events_template_created ON call_template_promotion_events(template_id, event_id DESC)',
            `CREATE TRIGGER IF NOT EXISTS call_template_promotion_events_no_update
             BEFORE UPDATE ON call_template_promotion_events
             BEGIN SELECT RAISE(ABORT, 'Call script promotion audit is append-only'); END`,
            `CREATE TRIGGER IF NOT EXISTS call_template_promotion_events_no_delete
             BEFORE DELETE ON call_template_promotion_events
             BEGIN SELECT RAISE(ABORT, 'Call script promotion audit is append-only'); END`,
            'CREATE INDEX IF NOT EXISTS idx_vapi_template_mappings_template ON vapi_template_mappings(template_id, template_version, updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_vapi_call_events_call ON vapi_call_events(provider_call_id, received_at)',
            'CREATE INDEX IF NOT EXISTS idx_vapi_call_events_template ON vapi_call_events(template_id, template_version, received_at)',
            
            // Notification indexes
            'CREATE INDEX IF NOT EXISTS idx_notifications_status ON webhook_notifications(status)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_call_sid ON webhook_notifications(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_type ON webhook_notifications(notification_type)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON webhook_notifications(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_chat_id ON webhook_notifications(telegram_chat_id)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_priority ON webhook_notifications(priority)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_next_attempt ON webhook_notifications(next_attempt_at)',
            
            // Metrics indexes
            'CREATE INDEX IF NOT EXISTS idx_metrics_date ON notification_metrics(date)',
            'CREATE INDEX IF NOT EXISTS idx_metrics_type ON notification_metrics(notification_type)',
            'CREATE INDEX IF NOT EXISTS idx_call_metrics_call_sid ON call_metrics(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_call_metrics_type ON call_metrics(metric_type)',
            'CREATE INDEX IF NOT EXISTS idx_call_jobs_status ON call_jobs(status)',
            'CREATE INDEX IF NOT EXISTS idx_call_jobs_run_at ON call_jobs(run_at)',
            'CREATE INDEX IF NOT EXISTS idx_call_job_dlq_status ON call_job_dlq(status)',
            'CREATE INDEX IF NOT EXISTS idx_call_job_dlq_created_at ON call_job_dlq(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_outbound_rate_limits_updated_at ON outbound_rate_limits(updated_at)',
            
            // Health indexes
            'CREATE INDEX IF NOT EXISTS idx_health_service ON service_health_logs(service_name)',
            'CREATE INDEX IF NOT EXISTS idx_health_timestamp ON service_health_logs(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_health_status ON service_health_logs(status)',
            
            // Session indexes
            'CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON user_sessions(telegram_chat_id)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_start ON user_sessions(session_start)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_activity ON user_sessions(last_activity)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_call_memory_updated ON gpt_call_memory(summary_updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_memory_facts_call_sid ON gpt_memory_facts(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_memory_facts_last_seen ON gpt_memory_facts(last_seen_at)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_tool_audit_call_sid ON gpt_tool_audit(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_tool_audit_idempotency ON gpt_tool_audit(idempotency_key)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_tool_audit_created ON gpt_tool_audit(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_tool_idem_status ON gpt_tool_idempotency(status)',
            'CREATE INDEX IF NOT EXISTS idx_gpt_tool_idem_updated ON gpt_tool_idempotency(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_paypal_payment_sessions_call_sid ON paypal_payment_sessions(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_paypal_payment_sessions_status ON paypal_payment_sessions(status)',
            'CREATE INDEX IF NOT EXISTS idx_paypal_payment_sessions_updated ON paypal_payment_sessions(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_paypal_payment_events_type ON paypal_payment_events(event_type)',
            'CREATE INDEX IF NOT EXISTS idx_paypal_payment_events_resource ON paypal_payment_events(resource_id)',
            'CREATE INDEX IF NOT EXISTS idx_stripe_payment_sessions_call_sid ON stripe_payment_sessions(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_stripe_payment_sessions_status ON stripe_payment_sessions(status)',
            'CREATE INDEX IF NOT EXISTS idx_stripe_payment_sessions_updated ON stripe_payment_sessions(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_stripe_payment_events_type ON stripe_payment_events(event_type)',
            'CREATE INDEX IF NOT EXISTS idx_stripe_payment_events_resource ON stripe_payment_events(resource_id)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_sessions_call_sid ON square_payment_sessions(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_sessions_status ON square_payment_sessions(status)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_sessions_updated ON square_payment_sessions(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_events_type ON square_payment_events(event_type)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_events_resource ON square_payment_events(resource_id)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_session_links_session ON square_payment_session_links(session_external_id)',
            'CREATE INDEX IF NOT EXISTS idx_square_payment_session_links_related ON square_payment_session_links(related_id)',
            'CREATE INDEX IF NOT EXISTS idx_provider_event_idem_source ON provider_event_idempotency(source)',
            'CREATE INDEX IF NOT EXISTS idx_provider_event_idem_expires ON provider_event_idempotency(expires_at)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_webhook_events_call ON cartesia_webhook_events(call_id, received_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_cartesia_webhook_events_received ON cartesia_webhook_events(received_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_outbound_call_idem_provider ON outbound_call_idempotency(provider)',
            'CREATE INDEX IF NOT EXISTS idx_outbound_call_idem_status ON outbound_call_idempotency(status)',
            'CREATE INDEX IF NOT EXISTS idx_outbound_call_idem_updated ON outbound_call_idempotency(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_call_script_mutation_idem_status ON call_script_mutation_idempotency(status)',
            'CREATE INDEX IF NOT EXISTS idx_call_script_mutation_idem_updated ON call_script_mutation_idempotency(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_vonage_call_map_call_sid ON vonage_call_mappings(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_vonage_call_map_updated ON vonage_call_mappings(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_call_runtime_state_updated ON call_runtime_state(updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_call_quality_reports_call_sid ON call_quality_reports(call_sid)',
            'CREATE INDEX IF NOT EXISTS idx_call_quality_reports_status ON call_quality_reports(status)',
            'CREATE INDEX IF NOT EXISTS idx_call_quality_reports_updated_at ON call_quality_reports(updated_at)',
        ];

        for (const index of indexes) {
            await new Promise((resolve, reject) => {
                this.db.run(index, (err) => {
                    if (err && !err.message.includes('already exists')) {
                        console.error('Error creating enhanced index:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }

        console.log('✅ Enhanced database tables and indexes created successfully');
    }

    async ensureOutboundContactDispatchCartesiaProvider() {
        const schema = await new Promise((resolve, reject) => {
            this.db.get(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_contact_dispatch_history'",
                (error, row) => error ? reject(error) : resolve(String(row?.sql || '')),
            );
        });
        if (!schema || /'cartesia'/i.test(schema)) return;

        const run = (sql) => new Promise((resolve, reject) => this.db.run(sql, (error) => error ? reject(error) : resolve()));
        try {
            await run('BEGIN IMMEDIATE');
            await run('ALTER TABLE outbound_contact_dispatch_history RENAME TO outbound_contact_dispatch_history_pre_cartesia');
            await run(`CREATE TABLE outbound_contact_dispatch_history (
                reservation_key TEXT PRIMARY KEY,
                business_id TEXT NOT NULL,
                destination_hash TEXT NOT NULL CHECK(length(destination_hash) = 64),
                provider TEXT NOT NULL CHECK(provider IN ('twilio', 'plivo', 'vonage', 'vapi', 'call_e', 'cartesia')),
                status TEXT NOT NULL CHECK(status IN ('reserved', 'accepted', 'released')),
                attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            await run(`INSERT INTO outbound_contact_dispatch_history (
                reservation_key, business_id, destination_hash, provider, status, attempted_at, updated_at
            ) SELECT reservation_key, business_id, destination_hash, provider, status, attempted_at, updated_at
              FROM outbound_contact_dispatch_history_pre_cartesia`);
            await run('DROP TABLE outbound_contact_dispatch_history_pre_cartesia');
            await run('CREATE INDEX IF NOT EXISTS idx_outbound_contact_dispatch_cooldown ON outbound_contact_dispatch_history(business_id, destination_hash, status, attempted_at DESC)');
            await run('COMMIT');
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        }
    }

    async ensureOutboundCallBusinessScopeColumn() {
        const columns = await new Promise((resolve, reject) => this.db.all(
            'PRAGMA table_info(outbound_call_idempotency)', (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))),
        ));
        if (!columns.has('business_id')) await new Promise((resolve, reject) => this.db.run(
            'ALTER TABLE outbound_call_idempotency ADD COLUMN business_id TEXT', (error) => error ? reject(error) : resolve(),
        ));
    }

    async ensureCartesiaCampaignProgressColumns() {
        const columns = await new Promise((resolve, reject) => this.db.all(
            'PRAGMA table_info(cartesia_campaign_recipients)', (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))),
        ));
        for (const [name, type] of [['provider_status', 'TEXT'], ['provider_end_reason', 'TEXT'], ['encrypted_dynamic_variables', 'TEXT']]) {
            if (!columns.has(name)) await new Promise((resolve, reject) => this.db.run(
                `ALTER TABLE cartesia_campaign_recipients ADD COLUMN ${name} ${type}`, (error) => error ? reject(error) : resolve(),
            ));
        }
        const campaignColumns = await new Promise((resolve, reject) => this.db.all(
            'PRAGMA table_info(cartesia_campaigns)', (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))),
        ));
        if (!campaignColumns.has('provider_retry_count')) await new Promise((resolve, reject) => this.db.run(
            'ALTER TABLE cartesia_campaigns ADD COLUMN provider_retry_count INTEGER NOT NULL DEFAULT 0', (error) => error ? reject(error) : resolve(),
        ));
    }

    async ensureCartesiaVoiceGovernanceColumns() {
        const columns = await new Promise((resolve, reject) => this.db.all(
            'PRAGMA table_info(cartesia_voice_governance)', (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))),
        ));
        if (!columns.has('active_operations')) await new Promise((resolve, reject) => this.db.run(
            'ALTER TABLE cartesia_voice_governance ADD COLUMN active_operations INTEGER NOT NULL DEFAULT 0', (error) => error ? reject(error) : resolve(),
        ));
        if (!columns.has('operation_token')) await new Promise((resolve, reject) => this.db.run(
            'ALTER TABLE cartesia_voice_governance ADD COLUMN operation_token TEXT', (error) => error ? reject(error) : resolve(),
        ));
        if (!columns.has('operation_started_at')) await new Promise((resolve, reject) => this.db.run(
            'ALTER TABLE cartesia_voice_governance ADD COLUMN operation_started_at DATETIME', (error) => error ? reject(error) : resolve(),
        ));
    }

    async ensureCallEContactPolicyColumns() {
        const columns = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(call_e_contact_policy_events)', (error, rows) => {
                if (error) return reject(error);
                resolve(new Set((rows || []).map((row) => row.name)));
            });
        });
        if (columns.has('recorded_by_telegram_id')) return;
        await new Promise((resolve, reject) => {
            this.db.run('ALTER TABLE call_e_contact_policy_events ADD COLUMN recorded_by_telegram_id TEXT', (error) => {
                if (error && !String(error.message || '').toLowerCase().includes('duplicate')) return reject(error);
                resolve();
            });
        });
    }

    async ensureCallESensitiveDataColumns() {
        for (const table of ['call_e_campaign_missions', 'call_e_goal_run_requests']) {
            const columns = await new Promise((resolve, reject) => {
                this.db.all(`PRAGMA table_info(${table})`, (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))));
            });
            for (const [name, definition] of [['sensitive_data_expires_at', 'DATETIME'], ['sensitive_data_purged_at', 'DATETIME']]) {
                if (columns.has(name)) continue;
                await new Promise((resolve, reject) => this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, (error) => {
                    if (error && !String(error.message || '').toLowerCase().includes('duplicate')) return reject(error);
                    resolve();
                }));
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE ${table} SET sensitive_data_expires_at = datetime(created_at, '+90 days') WHERE sensitive_data_expires_at IS NULL`,
                (error) => error ? reject(error) : resolve(),
            ));
        }
    }

    async ensureCallEMissionEnhancementColumns() {
        const additions = [
            ['call_e_campaign_missions', 'scheduled_at', 'DATETIME'],
            ['call_e_campaign_missions', 'budget_limit_minor', 'INTEGER'],
            ['call_e_campaign_missions', 'per_call_cost_ceiling_minor', 'INTEGER'],
            ['call_e_campaign_missions', 'budget_currency', 'TEXT'],
            ['call_e_business_safety_policies', 'contact_cooldown_hours', 'INTEGER NOT NULL DEFAULT 0'],
            ['call_e_business_mission_policies', 'review_sla_minutes', 'INTEGER NOT NULL DEFAULT 0'],
            ['call_e_business_mission_policies', 'review_repeat_minutes', 'INTEGER NOT NULL DEFAULT 0'],
            ['call_e_mission_escalation_actions', 'request_hash', 'TEXT'],
        ];
        for (const [table, name, definition] of additions) {
            const columns = await new Promise((resolve, reject) => this.db.all(
                `PRAGMA table_info(${table})`, (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map((row) => row.name))),
            ));
            if (columns.has(name)) continue;
            await new Promise((resolve, reject) => this.db.run(
                `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
                (error) => error && !String(error.message || '').toLowerCase().includes('duplicate') ? reject(error) : resolve(),
            ));
        }
    }

    async ensureCallEReconciliationBusinessColumn() {
        const columns = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(call_e_reconciliation)', (error, rows) => {
                if (error) return reject(error);
                resolve(new Set((rows || []).map((row) => row.name)));
            });
        });
        if (columns.has('business_id')) return;
        await new Promise((resolve, reject) => {
            this.db.run('ALTER TABLE call_e_reconciliation ADD COLUMN business_id TEXT', (error) => {
                if (error && !String(error.message || '').toLowerCase().includes('duplicate')) return reject(error);
                resolve();
            });
        });
    }

<<<<<<< HEAD
    async ensureCallEReconciliationIvrColumn() {
        const columns = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(call_e_reconciliation)', (error, rows) => {
                if (error) return reject(error);
                resolve(new Set((rows || []).map((row) => row.name)));
            });
        });
        if (columns.has('ivr_dtmf_observed')) return;
        await new Promise((resolve, reject) => {
            this.db.run('ALTER TABLE call_e_reconciliation ADD COLUMN ivr_dtmf_observed INTEGER NOT NULL DEFAULT 0', (error) => {
                if (error && !String(error.message || '').toLowerCase().includes('duplicate')) return reject(error);
                resolve();
            });
        });
=======
    async ensureCartesiaBatchReconciliationColumns() {
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(cartesia_call_batches)', (error, rows) => error ? reject(error) : resolve(rows || []));
        });
        const names = new Set(existing.map((row) => row.name));
        const columns = {
            reconcile_attempt_count: 'INTEGER NOT NULL DEFAULT 0',
            reconcile_next_at: 'TEXT',
            reconcile_lease_until: 'TEXT',
            reconcile_lease_token: 'TEXT',
            reconcile_last_error_code: 'TEXT',
        };
        for (const [name, definition] of Object.entries(columns)) {
            if (names.has(name)) continue;
            await new Promise((resolve, reject) => {
                this.db.run(`ALTER TABLE cartesia_call_batches ADD COLUMN ${name} ${definition}`, (error) => {
                    if (!error || String(error.message || '').toLowerCase().includes('duplicate')) resolve();
                    else reject(error);
                });
            });
        }
>>>>>>> 95a068c (updated)
    }

    async ensureCallColumns(columns = []) {
        if (!columns.length) return;
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(calls)', (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });

        const existingNames = new Set(existing.map((row) => row.name));
        const addColumn = (name, definition) => {
            return new Promise((resolve, reject) => {
                this.db.run(`ALTER TABLE calls ADD COLUMN ${name} ${definition}`, (err) => {
                    if (err) {
                        if (String(err.message || '').includes('duplicate')) {
                            resolve();
                        } else {
                            reject(err);
                        }
                    } else {
                        resolve();
                    }
                });
            });
        };

        for (const column of columns) {
            if (existingNames.has(column)) continue;
            if (column === 'digit_summary') {
                await addColumn('digit_summary', 'TEXT');
            } else if (column === 'digit_count') {
                await addColumn('digit_count', 'INTEGER DEFAULT 0');
            } else if (column === 'last_otp') {
                await addColumn('last_otp', 'TEXT');
            } else if (column === 'last_otp_masked') {
                await addColumn('last_otp_masked', 'TEXT');
            } else if (column === 'direction') {
                await addColumn('direction', 'TEXT');
            } else if (column === 'business_id') {
                await addColumn('business_id', 'TEXT');
            }
        }
    }

    async ensureVapiCallEventColumns(columns = []) {
        if (!columns.length) return;
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(vapi_call_events)', (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
        const existingNames = new Set(existing.map((row) => row.name));
        for (const column of columns) {
            if (column !== 'destination_type' || existingNames.has(column)) continue;
            await new Promise((resolve, reject) => {
                this.db.run('ALTER TABLE vapi_call_events ADD COLUMN destination_type TEXT', (err) => {
                    if (err && !String(err.message || '').toLowerCase().includes('duplicate')) return reject(err);
                    resolve();
                });
            });
        }
    }

    async ensureTemplateColumns(columns = []) {
        if (!columns.length) return;
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(call_templates)', (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        const existingNames = new Set(existing.map((row) => row.name));
        const addColumn = (name, definition) => new Promise((resolve, reject) => {
            this.db.run(`ALTER TABLE call_templates ADD COLUMN ${name} ${definition}`, (err) => {
                if (err) {
                    if (String(err.message || '').includes('duplicate')) resolve();
                    else reject(err);
                } else resolve();
            });
        });
        for (const column of columns) {
            if (existingNames.has(column)) continue;
            if (column === 'version') {
                await addColumn('version', 'INTEGER DEFAULT 1');
            } else if (column === 'objective_tags') {
                await addColumn('objective_tags', 'TEXT');
            } else if (column === 'supports_payment') {
                await addColumn('supports_payment', 'INTEGER');
            } else if (column === 'supports_digit_capture') {
                await addColumn('supports_digit_capture', 'INTEGER');
            } else if (column === 'requires_otp') {
                await addColumn('requires_otp', 'INTEGER DEFAULT 0');
            } else if (column === 'default_profile') {
                await addColumn('default_profile', 'TEXT');
            } else if (column === 'expected_length') {
                await addColumn('expected_length', 'INTEGER');
            } else if (column === 'allow_terminator') {
                await addColumn('allow_terminator', 'INTEGER DEFAULT 0');
            } else if (column === 'terminator_char') {
                await addColumn('terminator_char', 'TEXT');
            } else if (column === 'payment_enabled') {
                await addColumn('payment_enabled', 'INTEGER DEFAULT 0');
            } else if (column === 'payment_connector') {
                await addColumn('payment_connector', 'TEXT');
            } else if (column === 'payment_amount') {
                await addColumn('payment_amount', 'TEXT');
            } else if (column === 'payment_currency') {
                await addColumn('payment_currency', 'TEXT');
            } else if (column === 'payment_description') {
                await addColumn('payment_description', 'TEXT');
            } else if (column === 'payment_policy') {
                await addColumn('payment_policy', 'TEXT');
            } else if (column === 'payment_start_message') {
                await addColumn('payment_start_message', 'TEXT');
            } else if (column === 'payment_success_message') {
                await addColumn('payment_success_message', 'TEXT');
            } else if (column === 'payment_failure_message') {
                await addColumn('payment_failure_message', 'TEXT');
            } else if (column === 'payment_retry_message') {
                await addColumn('payment_retry_message', 'TEXT');
            } else if (column === 'agent_config_json') {
                await addColumn('agent_config_json', 'TEXT');
            } else if (column === 'lifecycle_state') {
                await addColumn('lifecycle_state', "TEXT DEFAULT 'draft'");
            } else if (column === 'submitted_for_review_at') {
                await addColumn('submitted_for_review_at', 'DATETIME');
            } else if (column === 'reviewed_at') {
                await addColumn('reviewed_at', 'DATETIME');
            } else if (column === 'reviewed_by') {
                await addColumn('reviewed_by', 'TEXT');
            } else if (column === 'review_note') {
                await addColumn('review_note', 'TEXT');
            } else if (column === 'live_at') {
                await addColumn('live_at', 'DATETIME');
            } else if (column === 'live_by') {
                await addColumn('live_by', 'TEXT');
            }
        }
    }

    // Enhanced call creation with comprehensive metadata
    async createCall(callData) {
        const { 
            call_sid, 
            phone_number, 
            prompt, 
            first_message, 
            user_chat_id, 
            business_context = null,
            generated_functions = null,
            direction = null,
            business_id = null
        } = callData;
        
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO calls (
                    call_sid, phone_number, prompt, first_message, 
                    user_chat_id, status, business_context, generated_functions, direction, business_id
                )
                VALUES (?, ?, ?, ?, ?, 'initiated', ?, ?, ?, ?)
            `);
            
            stmt.run([
                call_sid, 
                phone_number, 
                prompt, 
                first_message, 
                user_chat_id, 
                business_context,
                generated_functions,
                direction,
                business_id
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async ensureNotificationColumns(columns = []) {
        if (!columns.length) return;
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(webhook_notifications)', (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
        const existingNames = new Set(existing.map((row) => row.name));
        const addColumn = (name, definition) => new Promise((resolve, reject) => {
            this.db.run(`ALTER TABLE webhook_notifications ADD COLUMN ${name} ${definition}`, (err) => {
                if (err) {
                    if (String(err.message || '').includes('duplicate')) resolve();
                    else reject(err);
                } else {
                    resolve();
                }
            });
        });

        for (const column of columns) {
            if (existingNames.has(column)) continue;
            if (column === 'last_attempt_at') {
                await addColumn('last_attempt_at', 'DATETIME');
            } else if (column === 'next_attempt_at') {
                await addColumn('next_attempt_at', 'DATETIME');
            }
        }
    }

    async ensureCallQualityReportColumns(columns = []) {
        if (!columns.length) return;
        const existing = await new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(call_quality_reports)', (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
        const existingNames = new Set(existing.map((row) => row.name));
        const addColumn = (name, definition) => new Promise((resolve, reject) => {
            this.db.run(`ALTER TABLE call_quality_reports ADD COLUMN ${name} ${definition}`, (err) => {
                if (err) {
                    if (String(err.message || '').includes('duplicate')) resolve();
                    else reject(err);
                } else {
                    resolve();
                }
            });
        });
        for (const column of columns) {
            if (existingNames.has(column)) continue;
            if (column === 'profile') {
                await addColumn('profile', 'TEXT');
            }
        }
    }

    // Enhanced status update with comprehensive tracking
    async updateCallStatus(call_sid, status, additionalData = {}) {
        return new Promise((resolve, reject) => {
            const normalizedStatus = normalizeCallStatusForDb(status);
            const nextStatusRank = getCallStatusRank(normalizedStatus);
            const allowTerminalUpgrade = additionalData.allow_terminal_upgrade === true
                || additionalData.allowTerminalUpgrade === true;
            const currentStatusExpr = "LOWER(REPLACE(COALESCE(status, ''), '_', '-'))";
            const currentRankExpr = `
                CASE ${currentStatusExpr}
                    WHEN 'queued' THEN 0
                    WHEN 'initiated' THEN 1
                    WHEN 'ringing' THEN 2
                    WHEN 'answered' THEN 3
                    WHEN 'in-progress' THEN 4
                    WHEN 'completed' THEN 5
                    WHEN 'voicemail' THEN 6
                    WHEN 'busy' THEN 7
                    WHEN 'no-answer' THEN 8
                    WHEN 'failed' THEN 9
                    WHEN 'canceled' THEN 10
                    ELSE -1
                END
            `;
            const allowStatusTransitionExpr = `
                (
                    status IS NULL
                    OR TRIM(status) = ''
                    OR ${currentStatusExpr} = ?
                    OR (
                        ${currentStatusExpr} IN ('voicemail', 'busy', 'no-answer', 'failed', 'canceled')
                        AND ? = 1
                        AND ? = 'completed'
                    )
                    OR (
                        ${currentStatusExpr} NOT IN ('completed', 'voicemail', 'busy', 'no-answer', 'failed', 'canceled')
                        AND (
                            ${currentRankExpr} = -1
                            OR ? = -1
                            OR ? >= ${currentRankExpr}
                        )
                    )
                )
            `;

            let updateFields = [`status = CASE WHEN ${allowStatusTransitionExpr} THEN ? ELSE status END`];
            let values = [
                normalizedStatus,
                allowTerminalUpgrade ? 1 : 0,
                normalizedStatus,
                nextStatusRank,
                nextStatusRank,
                status,
            ];

            // Handle all possible additional data fields
            const fieldMappings = {
                'started_at': 'started_at',
                'ended_at': 'ended_at', 
                'duration': 'duration',
                'call_summary': 'call_summary',
                'ai_analysis': 'ai_analysis',
                'twilio_status': 'twilio_status',
                'answered_by': 'answered_by',
                'error_code': 'error_code',
                'error_message': 'error_message',
                'ring_duration': 'ring_duration',
                'answer_delay': 'answer_delay',
                'digit_summary': 'digit_summary',
                'digit_count': 'digit_count',
                'last_otp': 'last_otp',
                'last_otp_masked': 'last_otp_masked'
            };

            Object.entries(fieldMappings).forEach(([key, field]) => {
                if (additionalData[key] !== undefined) {
                    updateFields.push(`${field} = ?`);
                    values.push(additionalData[key]);
                }
            });

            values.push(call_sid);

            const sql = `UPDATE calls SET ${updateFields.join(', ')} WHERE call_sid = ?`;
            
            this.db.run(sql, values, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    // Enhanced call state tracking
    async updateCallState(call_sid, state, data = null) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO call_states (call_sid, state, data, sequence_number)
                VALUES (?, ?, ?, (
                    SELECT COALESCE(MAX(sequence_number), 0) + 1 
                    FROM call_states 
                    WHERE call_sid = ?
                ))
            `);
            
            stmt.run([call_sid, state, data ? JSON.stringify(data) : null, call_sid], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async getLatestCallState(call_sid, state) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT data
                FROM call_states
                WHERE call_sid = ? AND state = ?
                ORDER BY sequence_number DESC
                LIMIT 1
            `;
            this.db.get(sql, [call_sid, state], (err, row) => {
                if (err) {
                    reject(err);
                } else if (!row?.data) {
                    resolve(null);
                } else {
                    try {
                        resolve(JSON.parse(row.data));
                    } catch (parseError) {
                        resolve(null);
                    }
                }
            });
        });
    }

    async createCallHandoffSession(call_sid, destination_e164, expires_at) {
        const callSid = String(call_sid || '').trim();
        const destination = String(destination_e164 || '').trim();
        const expiresAt = Number(expires_at);
        if (!callSid || !/^\+[1-9]\d{7,14}$/.test(destination) || !Number.isSafeInteger(expiresAt)) {
            throw new Error('Invalid call handoff session.');
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO call_handoff_sessions
                    (call_sid, state, destination_e164, expires_at)
                 VALUES (?, 'awaiting_confirmation', ?, ?)`,
                [callSid, destination, expiresAt],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes === 1);
                },
            );
        });
    }

    async getCallHandoffSession(call_sid) {
        const callSid = String(call_sid || '').trim();
        if (!callSid) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT call_sid, state, destination_e164, expires_at, updated_at,
                        CAST(strftime('%s', updated_at) AS INTEGER) * 1000 AS updated_at_ms
                 FROM call_handoff_sessions WHERE call_sid = ?`,
                [callSid],
                (err, row) => err ? reject(err) : resolve(row || null),
            );
        });
    }

    async transitionCallHandoffSession(call_sid, from_state, to_state, options = {}) {
        const callSid = String(call_sid || '').trim();
        const fromState = String(from_state || '').trim();
        const toState = String(to_state || '').trim();
        const allowedStates = new Set([
            'awaiting_confirmation', 'dispatching', 'started_unconfirmed',
            'outcome_unknown', 'cancelled', 'expired', 'failed',
        ]);
        if (!callSid || !allowedStates.has(fromState) || !allowedStates.has(toState)) {
            throw new Error('Invalid call handoff state transition.');
        }
        const now = Number.isSafeInteger(Number(options.now)) ? Number(options.now) : Date.now();
        const requireUnexpired = options.require_unexpired === true;
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE call_handoff_sessions
                 SET state = ?,
                     destination_e164 = CASE WHEN ? = 'awaiting_confirmation' THEN destination_e164 ELSE '' END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE call_sid = ? AND state = ?${requireUnexpired ? ' AND expires_at > ?' : ''}`,
                requireUnexpired
                    ? [toState, toState, callSid, fromState, now]
                    : [toState, toState, callSid, fromState],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes === 1);
                },
            );
        });
    }

    async setCallDisposition(call_sid, disposition, metadata = {}) {
        const normalizedCallSid = String(call_sid || '').trim();
        if (!normalizedCallSid) {
            throw new Error('call_sid is required');
        }

        const normalizedDisposition = normalizeCallDispositionForDb(disposition);
        if (!isValidCallDisposition(normalizedDisposition)) {
            throw new Error(`Unsupported call disposition: ${disposition}`);
        }

        const details =
            metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? { ...metadata }
                : {};
        const payload = {
            ...details,
            disposition: normalizedDisposition,
        };

        await this.updateCallState(normalizedCallSid, CALL_DISPOSITION_STATE, payload);
        await this.upsertCallOutcome({
            call_sid: normalizedCallSid,
            disposition: normalizedDisposition,
        });
        return payload;
    }

    async getLatestCallDisposition(call_sid) {
        const dispositions = await this.getLatestCallDispositions([call_sid]);
        const normalizedCallSid = String(call_sid || '').trim();
        return dispositions[normalizedCallSid] || null;
    }

    async getLatestCallDispositions(callSids = []) {
        const normalizedCallSids = [...new Set(
            (Array.isArray(callSids) ? callSids : [])
                .map((value) => String(value || '').trim())
                .filter(Boolean),
        )];
        if (!normalizedCallSids.length) {
            return {};
        }

        return new Promise((resolve, reject) => {
            const placeholders = normalizedCallSids.map(() => '?').join(', ');
            const sql = `
                SELECT cs.call_sid, cs.data, cs.timestamp
                FROM call_states cs
                INNER JOIN (
                    SELECT call_sid, MAX(sequence_number) AS max_sequence_number
                    FROM call_states
                    WHERE state = ? AND call_sid IN (${placeholders})
                    GROUP BY call_sid
                ) latest
                    ON latest.call_sid = cs.call_sid
                   AND latest.max_sequence_number = cs.sequence_number
                WHERE cs.state = ?
            `;
            this.db.all(
                sql,
                [CALL_DISPOSITION_STATE, ...normalizedCallSids, CALL_DISPOSITION_STATE],
                (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const dispositions = {};
                    (rows || []).forEach((row) => {
                        const parsed = parseDispositionStateRow(row);
                        if (!parsed?.disposition || !row?.call_sid) return;
                        dispositions[row.call_sid] = parsed;
                    });
                    resolve(dispositions);
                },
            );
        });
    }

    async attachLatestCallDispositions(calls = []) {
        const rows = Array.isArray(calls) ? calls : [];
        if (!rows.length) {
            return [];
        }

        const dispositions = await this.getLatestCallDispositions(
            rows.map((row) => row?.call_sid),
        );

        return rows.map((row) => {
            const disposition = row?.call_sid ? dispositions[row.call_sid] : null;
            if (!disposition) return row;
            return {
                ...row,
                call_disposition: disposition.disposition,
                call_disposition_data: disposition,
                call_disposition_updated_at: disposition.updated_at || null,
            };
        });
    }

    async getCallStates(call_sid, options = {}) {
        if (!call_sid) return [];
        const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT state, data, timestamp, sequence_number
                FROM call_states
                WHERE call_sid = ?
                ORDER BY sequence_number DESC
                LIMIT ?
            `;
            this.db.all(sql, [call_sid, limit], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                const parsed = (rows || []).map((row) => {
                    let data = row.data;
                    if (typeof data === 'string' && data) {
                        try {
                            data = JSON.parse(data);
                        } catch (_) {
                            // leave as string
                        }
                    }
                    return {
                        state: row.state,
                        data,
                        timestamp: row.timestamp,
                        sequence_number: row.sequence_number
                    };
                });
                resolve(parsed);
            });
        });
    }

    async getCallStatesAfter(call_sid, after = 0, limit = 100) {
        if (!call_sid) return [];
        const safeAfter = Number.isFinite(Number(after)) ? Number(after) : 0;
        const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT state, data, timestamp, sequence_number
                FROM call_states
                WHERE call_sid = ? AND sequence_number > ?
                ORDER BY sequence_number ASC
                LIMIT ?
            `;
            this.db.all(sql, [call_sid, safeAfter, safeLimit], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                const parsed = (rows || []).map((row) => {
                    let data = row.data;
                    if (typeof data === 'string' && data) {
                        try {
                            data = JSON.parse(data);
                        } catch (_) {
                            // leave as string
                        }
                    }
                    return {
                        state: row.state,
                        data,
                        timestamp: row.timestamp,
                        sequence_number: row.sequence_number
                    };
                });
                resolve(parsed);
            });
        });
    }

    async listStalePaymentSessions(options = {}) {
        const olderThanSeconds = Number.isFinite(Number(options.olderThanSeconds))
            ? Math.max(60, Math.floor(Number(options.olderThanSeconds)))
            : 240;
        const limit = Number.isFinite(Number(options.limit))
            ? Math.max(1, Math.min(100, Math.floor(Number(options.limit))))
            : 20;

        return new Promise((resolve, reject) => {
            const sql = `
                WITH payment_markers AS (
                    SELECT
                        cs.call_sid AS call_sid,
                        MAX(CASE
                            WHEN cs.state IN ('payment_session_requested', 'payment_session_started')
                            THEN cs.sequence_number
                            ELSE NULL
                        END) AS active_seq,
                        MAX(CASE
                            WHEN cs.state IN ('payment_session_completed', 'payment_session_failed')
                            THEN cs.sequence_number
                            ELSE NULL
                        END) AS terminal_seq,
                        MAX(CASE
                            WHEN cs.state IN ('payment_session_requested', 'payment_session_started')
                            THEN cs.timestamp
                            ELSE NULL
                        END) AS active_at
                    FROM call_states cs
                    GROUP BY cs.call_sid
                )
                SELECT
                    pm.call_sid,
                    pm.active_seq,
                    pm.terminal_seq,
                    pm.active_at,
                    c.status AS call_status,
                    c.direction AS call_direction,
                    c.phone_number AS phone_number
                FROM payment_markers pm
                LEFT JOIN calls c ON c.call_sid = pm.call_sid
                WHERE pm.active_seq IS NOT NULL
                  AND (pm.terminal_seq IS NULL OR pm.terminal_seq < pm.active_seq)
                  AND pm.active_at <= datetime('now', '-' || ? || ' seconds')
                ORDER BY pm.active_at ASC
                LIMIT ?
            `;
            this.db.all(sql, [olderThanSeconds, limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getPaymentFunnelAnalytics(options = {}) {
        const hours = Number.isFinite(Number(options.hours))
            ? Math.max(1, Math.min(24 * 90, Math.floor(Number(options.hours))))
            : 24 * 7;
        const limit = Number.isFinite(Number(options.limit))
            ? Math.max(1, Math.min(250, Math.floor(Number(options.limit))))
            : 100;

        return new Promise((resolve, reject) => {
            const sql = `
                WITH created AS (
                    SELECT
                        cs.call_sid AS call_sid,
                        CASE
                            WHEN json_extract(cs.data, '$.payment_enabled') IN (1, '1', 'true', 'TRUE') THEN 1
                            ELSE 0
                        END AS payment_enabled,
                        json_extract(cs.data, '$.script_id') AS script_id,
                        COALESCE(json_extract(cs.data, '$.script_version'), 1) AS script_version,
                        json_extract(cs.data, '$.provider') AS provider,
                        cs.timestamp AS created_at
                    FROM call_states cs
                    WHERE cs.state = 'call_created'
                      AND cs.timestamp >= datetime('now', '-' || ? || ' hours')
                ),
                grouped AS (
                    SELECT
                        c.call_sid AS call_sid,
                        c.payment_enabled AS payment_enabled,
                        c.script_id AS script_id,
                        c.script_version AS script_version,
                        c.provider AS provider,
                        MAX(CASE WHEN s.state = 'payment_session_requested' THEN 1 ELSE 0 END) AS requested,
                        MAX(CASE WHEN s.state = 'payment_session_started' THEN 1 ELSE 0 END) AS capture_started,
                        MAX(CASE WHEN s.state = 'payment_session_completed' THEN 1 ELSE 0 END) AS completed,
                        MAX(CASE WHEN s.state IN ('payment_session_failed', 'payment_session_reconciled', 'payment_session_start_failed') THEN 1 ELSE 0 END) AS failed
                    FROM created c
                    LEFT JOIN call_states s ON s.call_sid = c.call_sid
                    GROUP BY c.call_sid
                )
                SELECT
                    script_id,
                    script_version,
                    provider,
                    COUNT(*) AS calls_total,
                    SUM(payment_enabled) AS offered,
                    SUM(requested) AS requested,
                    SUM(capture_started) AS capture_started,
                    SUM(completed) AS completed,
                    SUM(failed) AS failed
                FROM grouped
                GROUP BY script_id, script_version, provider
                ORDER BY completed DESC, offered DESC, calls_total DESC
                LIMIT ?
            `;
            this.db.all(sql, [hours, limit], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows || []);
            });
        });
    }

    async getCallerFlag(phone_number) {
        if (!phone_number) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT phone_number, status, note, updated_at, updated_by, source
                FROM caller_flags
                WHERE phone_number = ?
                LIMIT 1
            `;
            this.db.get(sql, [phone_number], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async setCallerFlag(phone_number, status, meta = {}) {
        if (!phone_number || !status) return null;
        const note = meta.note || null;
        const updatedBy = meta.updated_by || meta.updatedBy || null;
        const source = meta.source || null;
        const updatedAt = new Date().toISOString();
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO caller_flags (phone_number, status, note, updated_at, updated_by, source)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone_number) DO UPDATE SET
                    status = excluded.status,
                    note = excluded.note,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by,
                    source = excluded.source
            `;
            this.db.run(sql, [phone_number, status, note, updatedAt, updatedBy, source], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ phone_number, status, note, updated_at: updatedAt, updated_by: updatedBy, source });
                }
            });
        });
    }

    async clearCallerFlag(phone_number) {
        if (!phone_number) return 0;
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM caller_flags WHERE phone_number = ?', [phone_number], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async listCallerFlags(filters = {}) {
        const status = filters.status || null;
        const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.min(500, Number(filters.limit))) : 100;
        const sql = status
            ? `SELECT phone_number, status, note, updated_at, updated_by, source FROM caller_flags WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
            : `SELECT phone_number, status, note, updated_at, updated_by, source FROM caller_flags ORDER BY updated_at DESC LIMIT ?`;
        const params = status ? [status, limit] : [limit];
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCallTemplates() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, name, description, prompt, first_message, version, business_id, voice_model,
                       objective_tags, supports_payment, supports_digit_capture,
                       requires_otp, default_profile, expected_length, allow_terminator, terminator_char,
                       payment_enabled, payment_connector, payment_amount, payment_currency, payment_description,
                       payment_policy, agent_config_json,
                       payment_start_message, payment_success_message, payment_failure_message, payment_retry_message,
                       lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                       created_at, updated_at
                FROM call_templates
                ORDER BY id DESC
            `;
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCallTemplateById(id) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, name, description, prompt, first_message, version, business_id, voice_model,
                       objective_tags, supports_payment, supports_digit_capture,
                       requires_otp, default_profile, expected_length, allow_terminator, terminator_char,
                       payment_enabled, payment_connector, payment_amount, payment_currency, payment_description,
                       payment_policy, agent_config_json,
                       payment_start_message, payment_success_message, payment_failure_message, payment_retry_message,
                       lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                       created_at, updated_at
                FROM call_templates
                WHERE id = ?
            `;
            this.db.get(sql, [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async upsertVapiTemplateMapping(mapping = {}) {
        const templateId = Number(mapping.template_id);
        const templateVersion = Number(mapping.template_version);
        const fingerprint = String(mapping.config_fingerprint || "").trim();
        const compatibilityStatus = String(mapping.compatibility_status || "")
            .trim()
            .toLowerCase();
        const summary = mapping.summary && typeof mapping.summary === "object"
            ? mapping.summary
            : {};
        if (!Number.isSafeInteger(templateId) || templateId <= 0) {
            throw new Error("Vapi template mapping requires a valid template ID");
        }
        if (!Number.isSafeInteger(templateVersion) || templateVersion <= 0) {
            throw new Error("Vapi template mapping requires a valid template version");
        }
        if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
            throw new Error("Vapi template mapping requires a SHA-256 fingerprint");
        }
        if (!["compatible", "incompatible"].includes(compatibilityStatus)) {
            throw new Error("Vapi template mapping compatibility status is invalid");
        }
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO vapi_template_mappings (
                    template_id, template_version, config_fingerprint,
                    compatibility_status, mapping_status, summary_json, reviewed_by,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'previewed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(template_id, template_version, config_fingerprint) DO UPDATE SET
                    compatibility_status = excluded.compatibility_status,
                    summary_json = excluded.summary_json,
                    reviewed_by = excluded.reviewed_by,
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(sql, [
                templateId,
                templateVersion,
                fingerprint,
                compatibilityStatus,
                JSON.stringify(summary),
                String(mapping.reviewed_by || "").trim() || null,
            ], function (err) {
                if (err) return reject(err);
                resolve(this.lastID || null);
            });
        });
    }

    async listVapiTemplateMappings(templateId) {
        const normalizedId = Number(templateId);
        if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
            throw new Error("A valid template ID is required");
        }
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, template_id, template_version, config_fingerprint,
                        compatibility_status, mapping_status, sync_status,
                        vapi_assistant_id, vapi_assistant_version, summary_json,
                        reviewed_by, last_sync_started_at, last_synced_at,
                        last_sync_error, created_at, updated_at
                 FROM vapi_template_mappings WHERE template_id = ? ORDER BY updated_at DESC, id DESC`,
                [normalizedId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve((rows || []).map((row) => {
                        let summary = {};
                        try { summary = JSON.parse(row.summary_json || "{}"); } catch (_) {}
                        return { ...row, summary };
                    }));
                },
            );
        });
    }

    async listVapiTemplateMappingsByAssistantId(assistantId) {
        const normalizedId = String(assistantId || "").trim();
        if (!normalizedId || normalizedId.length > 200) {
            throw new Error("A valid Vapi assistant ID is required");
        }
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, template_id, template_version, config_fingerprint,
                        compatibility_status, mapping_status, sync_status,
                        vapi_assistant_id, vapi_assistant_version, summary_json,
                        reviewed_by, last_sync_started_at, last_synced_at,
                        last_sync_error, created_at, updated_at
                 FROM vapi_template_mappings WHERE vapi_assistant_id = ? ORDER BY template_version DESC, updated_at DESC, id DESC`,
                [normalizedId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve((rows || []).map((row) => {
                        let summary = {};
                        try { summary = JSON.parse(row.summary_json || "{}"); } catch (_) {}
                        return { ...row, summary };
                    }));
                },
            );
        });
    }

    async getVapiTemplateMappingById(mappingId) {
        const normalizedId = Number(mappingId);
        if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
            throw new Error("A valid Vapi template mapping ID is required");
        }
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT id, template_id, template_version, config_fingerprint,
                        compatibility_status, mapping_status, sync_status,
                        vapi_assistant_id, vapi_assistant_version, summary_json,
                        reviewed_by, last_synced_at, last_sync_error
                 FROM vapi_template_mappings WHERE id = ?`,
                [normalizedId],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    let summary = {};
                    try { summary = JSON.parse(row.summary_json || "{}"); } catch (_) {}
                    resolve({ ...row, summary });
                },
            );
        });
    }

    async getVapiCallCampaignByIdempotencyKey(idempotencyKey) {
        const key = String(idempotencyKey || '').trim();
        if (!key) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM vapi_call_campaigns WHERE idempotency_key = ? LIMIT 1`,
                [key],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row ? { ...this.normalizeVapiCallCampaignRow(row), request_hash: row.request_hash } : null);
                },
            );
        });
    }

    async getVapiCallCampaign(campaignId) {
        const id = String(campaignId || '').trim();
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM vapi_call_campaigns WHERE campaign_id = ? LIMIT 1`,
                [id],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row ? this.normalizeVapiCallCampaignRow(row) : null);
                },
            );
        });
    }

    async listVapiCallCampaigns(limit = 50) {
        const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM vapi_call_campaigns ORDER BY created_at DESC, campaign_id DESC LIMIT ?`,
                [boundedLimit],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve((rows || []).map((row) => this.normalizeVapiCallCampaignRow(row)));
                },
            );
        });
    }

    normalizeVapiCallCampaignRow(row) {
        let callingDays = [];
        try {
            const parsed = JSON.parse(row.calling_days_json || '[]');
            if (Array.isArray(parsed)) callingDays = parsed.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
        } catch (_) {}
        return {
            campaign_id: row.campaign_id,
            name: row.name,
            provider: row.provider,
            template_id: Number(row.template_id),
            template_version: Number(row.template_version),
            mapping_id: Number(row.mapping_id),
            phone_number_id: row.phone_number_id,
            time_zone: row.time_zone,
            calling_window_start: row.calling_window_start,
            calling_window_end: row.calling_window_end,
            calling_days: callingDays,
            scheduled_start_at: row.scheduled_start_at || null,
            max_concurrency: Number(row.max_concurrency),
            max_retries: Number(row.max_retries),
            retry_delay_minutes: Number(row.retry_delay_minutes),
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    async insertVapiCallCampaign(campaign = {}) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO vapi_call_campaigns (
                    campaign_id, idempotency_key, request_hash, name, provider,
                    template_id, template_version, mapping_id, phone_number_id,
                    time_zone, calling_window_start, calling_window_end, calling_days_json,
                    scheduled_start_at, max_concurrency, max_retries, retry_delay_minutes, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
                [
                    campaign.campaign_id, campaign.idempotency_key, campaign.request_hash,
                    campaign.name, campaign.provider, campaign.template_id, campaign.template_version,
                    campaign.mapping_id, campaign.phone_number_id, campaign.time_zone,
                    campaign.calling_window_start, campaign.calling_window_end,
                    campaign.calling_days_json, campaign.scheduled_start_at,
                    campaign.max_concurrency, campaign.max_retries, campaign.retry_delay_minutes,
                ],
                function (err) {
                    if (err) return reject(err);
                    resolve((this.changes || 0) > 0);
                },
            );
        });
    }

    async listVapiWebCallAssistants() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT m.id, m.template_id, m.template_version, m.vapi_assistant_id,
                        t.name AS template_name
                 FROM vapi_template_mappings m
                 JOIN call_templates t
                   ON t.id = m.template_id
                  AND t.version = m.template_version
                 WHERE m.compatibility_status = 'compatible'
                   AND m.mapping_status = 'provisioned'
                   AND m.sync_status = 'synced'
                   AND m.vapi_assistant_id IS NOT NULL
                   AND m.vapi_assistant_id <> ''
                   AND t.lifecycle_state = 'live'
                   AND m.id = (
                       SELECT current_mapping.id
                       FROM vapi_template_mappings current_mapping
                       WHERE current_mapping.template_id = m.template_id
                         AND current_mapping.template_version = m.template_version
                       ORDER BY current_mapping.updated_at DESC, current_mapping.id DESC
                       LIMIT 1
                   )
                 ORDER BY t.name COLLATE NOCASE, m.template_id, m.id DESC`,
                [],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                },
            );
        });
    }

    async setVapiInboundAssistantRoute(phoneNumberId, mappingId) {
        const phoneId = String(phoneNumberId || "").trim();
        const normalizedMappingId = Number(mappingId);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(phoneId)) throw new Error("A valid Vapi phone number ID is required");
        if (!Number.isSafeInteger(normalizedMappingId) || normalizedMappingId <= 0) throw new Error("A valid Vapi mapping ID is required");
        const eligible = await new Promise((resolve, reject) => {
            this.db.get(
                `SELECT m.id FROM vapi_template_mappings m
                 JOIN call_templates t ON t.id = m.template_id AND t.version = m.template_version
                 WHERE m.id = ? AND m.compatibility_status = 'compatible'
                   AND m.mapping_status = 'provisioned' AND m.sync_status = 'synced'
                   AND m.vapi_assistant_id IS NOT NULL AND m.vapi_assistant_id <> ''`,
                [normalizedMappingId],
                (err, row) => err ? reject(err) : resolve(row || null),
            );
        });
        if (!eligible) throw new Error("Vapi inbound route requires a current synced compatible mapping");
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO vapi_inbound_routes (phone_number_id, mapping_id, created_at, updated_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT(phone_number_id) DO UPDATE SET mapping_id = excluded.mapping_id, updated_at = CURRENT_TIMESTAMP`,
                [phoneId, normalizedMappingId],
                (err) => err ? reject(err) : resolve({ phone_number_id: phoneId, mapping_id: normalizedMappingId }),
            );
        });
    }

    async getVapiInboundAssistantByPhoneNumberId(phoneNumberId) {
        const phoneId = String(phoneNumberId || "").trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(phoneId)) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT m.vapi_assistant_id
                 FROM vapi_inbound_routes r
                 JOIN vapi_template_mappings m ON m.id = r.mapping_id
                 JOIN call_templates t ON t.id = m.template_id AND t.version = m.template_version
                 WHERE r.phone_number_id = ? AND m.compatibility_status = 'compatible'
                   AND m.mapping_status = 'provisioned' AND m.sync_status = 'synced'
                   AND m.vapi_assistant_id IS NOT NULL AND m.vapi_assistant_id <> ''`,
                [phoneId],
                (err, row) => err ? reject(err) : resolve(row || null),
            );
        });
    }

    async deleteVapiInboundAssistantRoute(phoneNumberId) {
        const phoneId = String(phoneNumberId || "").trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(phoneId)) throw new Error("A valid Vapi phone number ID is required");
        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM vapi_inbound_routes WHERE phone_number_id = ?", [phoneId], function (err) {
                if (err) return reject(err);
                resolve({ deleted: this.changes > 0 });
            });
        });
    }

    async claimVapiTemplateSync(templateId, templateVersion, fingerprint) {
        const params = [Number(templateId), Number(templateVersion), String(fingerprint || "")];
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE vapi_template_mappings
                 SET sync_status = 'syncing', last_sync_started_at = CURRENT_TIMESTAMP,
                     last_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE template_id = ? AND template_version = ? AND config_fingerprint = ?
                   AND compatibility_status = 'compatible'
                   AND (sync_status <> 'syncing' OR last_sync_started_at < datetime('now', '-10 minutes'))`,
                params,
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes === 1);
                },
            );
        });
    }

    async completeVapiTemplateSync(mapping = {}) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE vapi_template_mappings
                 SET sync_status = 'synced', mapping_status = 'provisioned',
                     vapi_assistant_id = ?, vapi_assistant_version = ?,
                     last_synced_at = CURRENT_TIMESTAMP, last_sync_error = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE template_id = ? AND template_version = ? AND config_fingerprint = ?`,
                [
                    String(mapping.vapi_assistant_id || "").trim(),
                    String(mapping.vapi_assistant_version || "").trim() || null,
                    Number(mapping.template_id),
                    Number(mapping.template_version),
                    String(mapping.config_fingerprint || ""),
                ],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes === 1);
                },
            );
        });
    }

    async failVapiTemplateSync(mapping = {}) {
        const status = ["unknown", "failed"].includes(String(mapping.sync_status || ""))
            ? String(mapping.sync_status)
            : "failed";
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE vapi_template_mappings
                 SET sync_status = ?, last_sync_error = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE template_id = ? AND template_version = ? AND config_fingerprint = ?`,
                [
                    status,
                    String(mapping.error_code || "vapi_sync_failed").slice(0, 100),
                    Number(mapping.template_id),
                    Number(mapping.template_version),
                    String(mapping.config_fingerprint || ""),
                ],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes === 1);
                },
            );
        });
    }

    async recordVapiCallEvent(event = {}) {
        const eventKey = String(event.event_key || "").trim();
        const providerCallId = String(event.provider_call_id || "").trim();
        const eventType = String(event.event_type || "").trim();
        if (!eventKey || !providerCallId || !eventType) {
            throw new Error("Vapi call event requires event key, call ID, and event type");
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO vapi_call_events (
                    event_key, provider_call_id, event_type, provider_status, destination_type,
                    ended_reason, duration_seconds, assistant_id, template_id,
                    template_version, config_fingerprint, event_timestamp
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    eventKey,
                    providerCallId,
                    eventType,
                    event.provider_status || null,
                    ["number", "sip", "assistant"].includes(String(event.destination_type || "").toLowerCase())
                        ? String(event.destination_type).toLowerCase()
                        : null,
                    event.ended_reason || null,
                    Number.isFinite(Number(event.duration_seconds)) ? Math.max(0, Math.floor(Number(event.duration_seconds))) : null,
                    event.assistant_id || null,
                    Number.isSafeInteger(Number(event.template_id)) && Number(event.template_id) > 0 ? Number(event.template_id) : null,
                    Number.isSafeInteger(Number(event.template_version)) && Number(event.template_version) > 0 ? Number(event.template_version) : null,
                    event.config_fingerprint || null,
                    event.event_timestamp || null,
                ],
                function (err) {
                    if (err) return reject(err);
                    resolve({ inserted: this.changes > 0 });
                },
            );
        });
    }

    async listVapiCallEvents(filters = {}) {
        const templateId = Number(filters.template_id);
        const callId = String(filters.provider_call_id || "").trim();
        const limit = Math.max(1, Math.min(500, Math.floor(Number(filters.limit) || 100)));
        const clauses = [];
        const params = [];
        if (Number.isSafeInteger(templateId) && templateId > 0) {
            clauses.push("template_id = ?");
            params.push(templateId);
        }
        if (callId) {
            clauses.push("provider_call_id = ?");
            params.push(callId);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit);
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, provider_call_id, event_type, provider_status, destination_type,
                        ended_reason, duration_seconds, assistant_id, template_id,
                        template_version, config_fingerprint, event_timestamp, received_at
                 FROM vapi_call_events ${where} ORDER BY received_at DESC, id DESC LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                },
            );
        });
    }

    async createCallTemplate(payload) {
        const {
            name,
            description = null,
            prompt = null,
            first_message,
            version = 1,
            business_id = null,
            voice_model = null,
            objective_tags = null,
            supports_payment = null,
            supports_digit_capture = null,
            requires_otp = 0,
            default_profile = null,
            expected_length = null,
            allow_terminator = 0,
            terminator_char = null,
            payment_enabled = 0,
            payment_connector = null,
            payment_amount = null,
            payment_currency = null,
            payment_description = null,
            payment_policy = null,
            agent_config = null,
            payment_start_message = null,
            payment_success_message = null,
            payment_failure_message = null,
            payment_retry_message = null,
            lifecycle_state = 'draft',
            submitted_for_review_at = null,
            reviewed_at = null,
            reviewed_by = null,
            review_note = null,
            live_at = null,
            live_by = null
        } = payload || {};
        const normalizedVersionParsed = Number(version);
        const normalizedVersion = Number.isFinite(normalizedVersionParsed) && normalizedVersionParsed > 0
            ? Math.max(1, Math.floor(normalizedVersionParsed))
            : 1;
        let normalizedObjectiveTags = null;
        if (objective_tags !== null && objective_tags !== undefined && objective_tags !== '') {
            if (Array.isArray(objective_tags)) {
                const cleaned = objective_tags
                    .map((entry) => String(entry || '').trim())
                    .filter(Boolean);
                normalizedObjectiveTags = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
            } else if (typeof objective_tags === 'string') {
                const trimmed = String(objective_tags).trim();
                if (trimmed.startsWith('[')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (Array.isArray(parsed)) {
                            const cleaned = parsed
                                .map((entry) => String(entry || '').trim())
                                .filter(Boolean);
                            normalizedObjectiveTags = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
                        }
                    } catch (_) {
                        normalizedObjectiveTags = null;
                    }
                } else {
                    const cleaned = trimmed
                        .split(',')
                        .map((entry) => String(entry || '').trim())
                        .filter(Boolean);
                    normalizedObjectiveTags = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
                }
            }
        }
        const normalizedSupportsPayment = supports_payment === null || supports_payment === undefined || supports_payment === ''
            ? null
            : (supports_payment ? 1 : 0);
        const normalizedSupportsDigitCapture = supports_digit_capture === null || supports_digit_capture === undefined || supports_digit_capture === ''
            ? null
            : (supports_digit_capture ? 1 : 0);
        const normalizedRequiresOtp = requires_otp ? 1 : 0;
        const normalizedAllowTerminator = allow_terminator ? 1 : 0;
        const normalizedExpectedLength =
            expected_length === null || expected_length === undefined || expected_length === ''
                ? null
                : Number(expected_length);
        const normalizedPaymentEnabled = payment_enabled ? 1 : 0;
        const paymentAmountParsed = Number(payment_amount);
        const normalizedPaymentAmount =
            Number.isFinite(paymentAmountParsed) && paymentAmountParsed > 0
                ? paymentAmountParsed.toFixed(2)
                : null;
        const normalizedPaymentCurrency = payment_currency
            ? String(payment_currency).trim().toUpperCase().slice(0, 3)
            : null;
        const normalizedPaymentConnector = payment_connector
            ? String(payment_connector).trim().slice(0, 120)
            : null;
        const normalizedPaymentDescription = payment_description
            ? String(payment_description).trim().slice(0, 240)
            : null;
        let normalizedPaymentPolicy = null;
        if (payment_policy !== null && payment_policy !== undefined && payment_policy !== '') {
            if (typeof payment_policy === 'string') {
                const trimmed = String(payment_policy).trim();
                normalizedPaymentPolicy = trimmed || null;
            } else {
                try {
                    normalizedPaymentPolicy = JSON.stringify(payment_policy);
                } catch (_) {
                    normalizedPaymentPolicy = null;
                }
            }
        }
        const normalizedPaymentStartMessage = payment_start_message
            ? String(payment_start_message).trim().slice(0, 240)
            : null;
        const normalizedPaymentSuccessMessage = payment_success_message
            ? String(payment_success_message).trim().slice(0, 240)
            : null;
        const normalizedPaymentFailureMessage = payment_failure_message
            ? String(payment_failure_message).trim().slice(0, 240)
            : null;
        const normalizedPaymentRetryMessage = payment_retry_message
            ? String(payment_retry_message).trim().slice(0, 240)
            : null;
        const normalizedAgentConfig = agent_config === null || agent_config === undefined || agent_config === ''
            ? null
            : JSON.stringify(agent_config);
        const normalizedLifecycleState = String(lifecycle_state || 'draft')
            .trim()
            .toLowerCase();
        const safeLifecycleState = ['draft', 'review', 'approved', 'live'].includes(normalizedLifecycleState)
            ? normalizedLifecycleState
            : 'draft';
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO call_templates (
                    name, description, prompt, first_message, version, business_id, voice_model,
                    objective_tags, supports_payment, supports_digit_capture,
                    requires_otp, default_profile, expected_length, allow_terminator, terminator_char,
                    payment_enabled, payment_connector, payment_amount, payment_currency, payment_description,
                    payment_policy, agent_config_json,
                    payment_start_message, payment_success_message, payment_failure_message, payment_retry_message,
                    lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `;
            this.db.run(
                sql,
                [
                    name,
                    description,
                    prompt,
                    first_message,
                    normalizedVersion,
                    business_id,
                    voice_model,
                    normalizedObjectiveTags,
                    normalizedSupportsPayment,
                    normalizedSupportsDigitCapture,
                    normalizedRequiresOtp,
                    default_profile,
                    Number.isFinite(normalizedExpectedLength) ? normalizedExpectedLength : null,
                    normalizedAllowTerminator,
                    terminator_char,
                    normalizedPaymentEnabled,
                    normalizedPaymentConnector,
                    normalizedPaymentAmount,
                    normalizedPaymentCurrency,
                    normalizedPaymentDescription,
                    normalizedPaymentPolicy,
                    normalizedAgentConfig,
                    normalizedPaymentStartMessage,
                    normalizedPaymentSuccessMessage,
                    normalizedPaymentFailureMessage,
                    normalizedPaymentRetryMessage,
                    safeLifecycleState,
                    submitted_for_review_at,
                    reviewed_at,
                    reviewed_by,
                    review_note,
                    live_at,
                    live_by
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    }

    async updateCallTemplate(id, payload, expectedVersion = null) {
        const fields = [];
        const values = [];
        const mapping = {
            name: 'name',
            description: 'description',
            prompt: 'prompt',
            first_message: 'first_message',
            business_id: 'business_id',
            voice_model: 'voice_model',
            objective_tags: 'objective_tags',
            supports_payment: 'supports_payment',
            supports_digit_capture: 'supports_digit_capture',
            requires_otp: 'requires_otp',
            default_profile: 'default_profile',
            expected_length: 'expected_length',
            allow_terminator: 'allow_terminator',
            terminator_char: 'terminator_char',
            payment_enabled: 'payment_enabled',
            payment_connector: 'payment_connector',
            payment_amount: 'payment_amount',
            payment_currency: 'payment_currency',
            payment_description: 'payment_description',
            payment_policy: 'payment_policy',
            agent_config: 'agent_config_json',
            payment_start_message: 'payment_start_message',
            payment_success_message: 'payment_success_message',
            payment_failure_message: 'payment_failure_message',
            payment_retry_message: 'payment_retry_message'
        };
        Object.entries(mapping).forEach(([key, column]) => {
            if (payload[key] !== undefined) {
                let value = payload[key];
                if (key === 'payment_enabled') {
                    value = value ? 1 : 0;
                } else if (key === 'supports_payment' || key === 'supports_digit_capture') {
                    value = value === null || value === undefined || value === '' ? null : (value ? 1 : 0);
                } else if (key === 'objective_tags') {
                    if (value === null || value === undefined || value === '') {
                        value = null;
                    } else if (Array.isArray(value)) {
                        const cleaned = value
                            .map((entry) => String(entry || '').trim())
                            .filter(Boolean);
                        value = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
                    } else if (typeof value === 'string') {
                        const trimmed = String(value).trim();
                        if (!trimmed) {
                            value = null;
                        } else if (trimmed.startsWith('[')) {
                            try {
                                const parsed = JSON.parse(trimmed);
                                if (Array.isArray(parsed)) {
                                    const cleaned = parsed
                                        .map((entry) => String(entry || '').trim())
                                        .filter(Boolean);
                                    value = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
                                } else {
                                    value = null;
                                }
                            } catch (_) {
                                value = null;
                            }
                        } else {
                            const cleaned = trimmed
                                .split(',')
                                .map((entry) => String(entry || '').trim())
                                .filter(Boolean);
                            value = cleaned.length ? JSON.stringify(Array.from(new Set(cleaned)).slice(0, 12)) : null;
                        }
                    } else {
                        value = null;
                    }
                } else if (key === 'payment_connector') {
                    value = value ? String(value).trim().slice(0, 120) : null;
                } else if (key === 'payment_amount') {
                    const parsed = Number(value);
                    value = Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : null;
                } else if (key === 'payment_currency') {
                    const normalized = String(value || '').trim().toUpperCase();
                    value = normalized ? normalized.slice(0, 3) : null;
                } else if (key === 'payment_description') {
                    value = value ? String(value).trim().slice(0, 240) : null;
                } else if (key === 'payment_policy') {
                    if (value === null || value === undefined || value === '') {
                        value = null;
                    } else if (typeof value === 'string') {
                        value = String(value).trim() || null;
                    } else {
                        try {
                            value = JSON.stringify(value);
                        } catch (_) {
                            value = null;
                        }
                    }
                } else if (key === 'agent_config') {
                    if (value === null || value === undefined || value === '') {
                        value = null;
                    } else {
                        try {
                            value = typeof value === 'string' ? value : JSON.stringify(value);
                        } catch (_) {
                            value = null;
                        }
                    }
                } else if (
                    key === 'payment_start_message'
                    || key === 'payment_success_message'
                    || key === 'payment_failure_message'
                    || key === 'payment_retry_message'
                ) {
                    value = value ? String(value).trim().slice(0, 240) : null;
                }
                fields.push(`${column} = ?`);
                values.push(value);
            }
        });
        if (!fields.length) {
            return 0;
        }
        fields.push('version = COALESCE(version, 1) + 1');
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        const hasExpectedVersion = Number.isSafeInteger(expectedVersion) && expectedVersion > 0;
        if (hasExpectedVersion) values.push(expectedVersion);
        return new Promise((resolve, reject) => {
            const sql = `UPDATE call_templates SET ${fields.join(', ')} WHERE id = ?${hasExpectedVersion ? ' AND COALESCE(version, 1) = ?' : ''}`;
            this.db.run(sql, values, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async deleteCallTemplate(id) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM call_templates WHERE id = ?', [id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async listCallTemplateVersions(templateId, limit = 20) {
        const safeLimit = Number.isFinite(Number(limit))
            ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
            : 20;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, template_id, version, snapshot, reason, created_by, created_at
                FROM call_template_versions
                WHERE template_id = ?
                ORDER BY version DESC
                LIMIT ?
            `;
            this.db.all(sql, [templateId, safeLimit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCallTemplateVersion(templateId, version) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, template_id, version, snapshot, reason, created_by, created_at
                FROM call_template_versions
                WHERE template_id = ? AND version = ?
                LIMIT 1
            `;
            this.db.get(sql, [templateId, version], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async listCallTemplatePromotionEvents(templateId, limit = 20) {
        const safeLimit = Number.isFinite(Number(limit))
            ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
            : 20;
        return new Promise((resolve, reject) => this.db.all(
            `SELECT event_id, template_id, template_version, actor_label, simulation_run_id,
                    simulation_score, config_fingerprint, previous_live_template_id,
                    previous_live_version, created_at
             FROM call_template_promotion_events
             WHERE template_id = ?
             ORDER BY event_id DESC
             LIMIT ?`,
            [templateId, safeLimit],
            (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async saveCallTemplateVersion(templateId, version, snapshot, options = {}) {
        const safeVersion = Number.isFinite(Number(version))
            ? Math.max(1, Math.floor(Number(version)))
            : 1;
        const reason = options.reason ? String(options.reason).slice(0, 120) : null;
        const createdBy = options.created_by ? String(options.created_by).slice(0, 120) : null;
        const serializedSnapshot = typeof snapshot === 'string'
            ? snapshot
            : JSON.stringify(snapshot || {});
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO call_template_versions (
                    template_id, version, snapshot, reason, created_by, created_at
                )
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(template_id, version) DO UPDATE SET
                    snapshot = excluded.snapshot,
                    reason = excluded.reason,
                    created_by = excluded.created_by,
                    created_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [templateId, safeVersion, serializedSnapshot, reason, createdBy],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                },
            );
        });
    }

    async getLatestCallAgentSimulationRun(templateId, templateVersion = null) {
        const normalizedTemplateId = Number(templateId);
        if (!Number.isSafeInteger(normalizedTemplateId) || normalizedTemplateId < 1) return null;
        const normalizedVersion = templateVersion == null ? null : Number(templateVersion);
        if (normalizedVersion !== null && (!Number.isSafeInteger(normalizedVersion) || normalizedVersion < 1)) return null;
        const versionClause = normalizedVersion === null ? '' : ' AND template_version = ?';
        const parameters = normalizedVersion === null ? [normalizedTemplateId] : [normalizedTemplateId, normalizedVersion];
        return new Promise((resolve, reject) => this.db.get(
            `SELECT run_id, template_id, template_version, created_by, idempotency_key, request_hash,
                    config_fingerprint, scenario_ids_json, results_json, score, passed_count, failed_count, created_at
             FROM call_agent_simulation_runs WHERE template_id = ?${versionClause} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            parameters, (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async recordCallAgentSimulationRun(input = {}) {
        const runId = String(input.run_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const createdBy = String(input.created_by || '').trim().slice(0, 120) || 'admin';
        const idempotencyKey = String(input.idempotency_key || '').trim();
        const requestHash = String(input.request_hash || '').trim().toLowerCase();
        const configFingerprint = String(input.config_fingerprint || '').trim().toLowerCase();
        const scenarioIds = Array.isArray(input.scenario_ids) ? input.scenario_ids : [];
        const resultsJson = JSON.stringify(input.results || {});
        const score = Number(input.score);
        const passedCount = Number(input.passed_count) || 0;
        const failedCount = Number(input.failed_count) || 0;
        const createdAt = String(input.created_at || new Date().toISOString());
        if (!/^simrun_[a-f0-9-]{36}$/.test(runId) || !Number.isSafeInteger(templateId) || templateId < 1 ||
            !Number.isSafeInteger(templateVersion) || templateVersion < 1 || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
            !/^[a-f0-9]{64}$/.test(requestHash) || !/^[a-f0-9]{64}$/.test(configFingerprint) ||
            scenarioIds.length < 1 || scenarioIds.length > 11 || !Number.isSafeInteger(score) || score < 0 || score > 100 ||
            !Number.isSafeInteger(passedCount) || passedCount < 0 || !Number.isSafeInteger(failedCount) || failedCount < 0 ||
            !Number.isFinite(Date.parse(createdAt)) || Buffer.byteLength(resultsJson, 'utf8') > 100000) {
            throw Object.assign(new Error('Call agent simulation run is invalid'), { code: 'call_agent_simulation_invalid' });
        }
        const loadExisting = () => new Promise((resolve, reject) => this.db.get(
            `SELECT run_id, template_id, template_version, created_by, request_hash, config_fingerprint,
                    results_json, score, passed_count, failed_count, created_at
             FROM call_agent_simulation_runs WHERE template_id = ? AND idempotency_key = ?`,
            [templateId, idempotencyKey], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        const serialize = (row, idempotentReplay, conflict = false) => {
            let results = {};
            try { results = JSON.parse(row.results_json || '{}'); } catch (_) {}
            return { run_id: row.run_id, template_id: Number(row.template_id), template_version: Number(row.template_version),
                created_by: row.created_by, config_fingerprint: row.config_fingerprint, results,
                score: Number(row.score) || 0, passed_count: Number(row.passed_count) || 0,
                failed_count: Number(row.failed_count) || 0, created_at: row.created_at,
                idempotent_replay: idempotentReplay, conflict };
        };
        const existing = await loadExisting();
        if (existing) return serialize(existing, existing.request_hash === requestHash, existing.request_hash !== requestHash);
        try {
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_agent_simulation_runs (
                    run_id, template_id, template_version, created_by, idempotency_key, request_hash,
                    config_fingerprint, scenario_ids_json, results_json, score, passed_count, failed_count, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [runId, templateId, templateVersion, createdBy, idempotencyKey, requestHash, configFingerprint,
                    JSON.stringify(scenarioIds), resultsJson, score, passedCount, failedCount, createdAt],
                (error) => error ? reject(error) : resolve(),
            ));
            return serialize({ run_id: runId, template_id: templateId, template_version: templateVersion,
                created_by: createdBy, config_fingerprint: configFingerprint, results_json: resultsJson,
                score, passed_count: passedCount, failed_count: failedCount, created_at: createdAt }, false);
        } catch (error) {
            if (!/unique|constraint/i.test(String(error?.message || ''))) throw error;
            const raced = await loadExisting();
            if (raced) return serialize(raced, raced.request_hash === requestHash, raced.request_hash !== requestHash);
            throw error;
        }
    }

    async listCallAgentSimulationRuns(templateId, limit = 10) {
        const normalizedTemplateId = Number(templateId);
        const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
        if (!Number.isSafeInteger(normalizedTemplateId) || normalizedTemplateId < 1) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT run_id, template_id, template_version, created_by, config_fingerprint,
                    results_json, score, passed_count, failed_count, created_at
             FROM call_agent_simulation_runs WHERE template_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            [normalizedTemplateId, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async getLatestVapiSimulationRun(templateId, templateVersion = null) {
        const id = Number(templateId);
        if (!Number.isSafeInteger(id) || id < 1) return null;
        const version = templateVersion == null ? null : Number(templateVersion);
        if (version !== null && (!Number.isSafeInteger(version) || version < 1)) return null;
        const whereVersion = version === null ? '' : ' AND template_version = ?';
        const params = version === null ? [id] : [id, version];
        return new Promise((resolve, reject) => this.db.get(
            `SELECT vapi_run_id AS run_id, template_id, template_version, mapping_id, assistant_id,
                    suite_id, idempotency_key, actor_id, summary_json, safety_status, created_at
             FROM vapi_simulation_runs WHERE template_id = ?${whereVersion} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            params, (error, row) => {
                if (error) return reject(error);
                if (!row) return resolve(null);
                let summary = {};
                try { summary = JSON.parse(row.summary_json || '{}'); } catch (_) {}
                resolve({ ...row, summary });
            },
        ));
    }

    async recordVapiSimulationRun(input = {}) {
        const runId = String(input.run_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const mappingId = Number(input.mapping_id);
        const assistantId = String(input.assistant_id || '').trim();
        const suiteId = String(input.suite_id || '').trim();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        const actorId = String(input.actor_id || 'admin').trim().slice(0, 120) || 'admin';
        const summaryJson = JSON.stringify(input.summary || {});
        const safety = String(input.safety || '').trim();
        if (!runId || runId.length > 200 || !Number.isSafeInteger(templateId) || templateId < 1 ||
            !Number.isSafeInteger(templateVersion) || templateVersion < 1 || !Number.isSafeInteger(mappingId) || mappingId < 1 ||
            !assistantId || assistantId.length > 200 || !suiteId || suiteId.length > 200 ||
            !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey) || !safety || safety.length > 100 ||
            Buffer.byteLength(summaryJson, 'utf8') > 10000) {
            throw Object.assign(new Error('Vapi simulation run record is invalid'), { code: 'vapi_simulation_record_invalid' });
        }
        const findByKey = () => new Promise((resolve, reject) => this.db.get(
            `SELECT vapi_run_id AS run_id, template_id, template_version, mapping_id, assistant_id,
                    suite_id, idempotency_key, actor_id, summary_json, safety_status, created_at
             FROM vapi_simulation_runs WHERE template_id = ? AND idempotency_key = ?`,
            [templateId, idempotencyKey], (error, row) => {
                if (error) return reject(error);
                if (!row) return resolve(null);
                let summary = {};
                try { summary = JSON.parse(row.summary_json || '{}'); } catch (_) {}
                resolve({ ...row, summary });
            },
        ));
        const existing = await findByKey();
        if (existing) return { ...existing, idempotent_replay: existing.run_id === runId, conflict: existing.run_id !== runId };
        try {
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO vapi_simulation_runs (
                    vapi_run_id, template_id, template_version, mapping_id, assistant_id, suite_id,
                    idempotency_key, actor_id, summary_json, safety_status
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [runId, templateId, templateVersion, mappingId, assistantId, suiteId, idempotencyKey, actorId, summaryJson, safety],
                (error) => error ? reject(error) : resolve(),
            ));
            return { run_id: runId, template_id: templateId, template_version: templateVersion,
                mapping_id: mappingId, assistant_id: assistantId, suite_id: suiteId,
                idempotency_key: idempotencyKey, actor_id: actorId, summary: input.summary || {}, safety_status: safety,
                idempotent_replay: false, conflict: false };
        } catch (error) {
            if (!/unique|constraint/i.test(String(error?.message || ''))) throw error;
            const raced = await findByKey();
            if (raced) return { ...raced, idempotent_replay: raced.run_id === runId, conflict: raced.run_id !== runId };
            throw error;
        }
    }

    async listVapiSimulationRuns(templateId, limit = 10, templateVersion = null) {
        const id = Number(templateId);
        const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 10)));
        if (!Number.isSafeInteger(id) || id < 1) return [];
        const version = templateVersion == null ? null : Number(templateVersion);
        if (version !== null && (!Number.isSafeInteger(version) || version < 1)) return [];
        const whereVersion = version === null ? '' : ' AND template_version = ?';
        const params = version === null ? [id, safeLimit] : [id, version, safeLimit];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT vapi_run_id AS run_id, template_id, template_version, mapping_id, suite_id,
                    actor_id, summary_json, safety_status, created_at
             FROM vapi_simulation_runs WHERE template_id = ?${whereVersion} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            params, (error, rows) => {
                if (error) return reject(error);
                resolve((rows || []).map((row) => {
                    let summary = {};
                    try { summary = JSON.parse(row.summary_json || '{}'); } catch (_) {}
                    return { ...row, summary };
                }));
            },
        ));
    }

    async updateVapiSimulationRunSummary(templateId, runId, summary = {}) {
        const id = Number(templateId);
        const remoteId = String(runId || '').trim();
        const json = JSON.stringify(summary || {});
        if (!Number.isSafeInteger(id) || id < 1 || !remoteId || remoteId.length > 200 || Buffer.byteLength(json, 'utf8') > 10000) {
            throw Object.assign(new Error('Vapi simulation summary update is invalid'), { code: 'vapi_simulation_record_invalid' });
        }
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE vapi_simulation_runs SET summary_json = ? WHERE template_id = ? AND vapi_run_id = ?`,
            [json, id, remoteId], function (error) {
                if (error) return reject(error);
                resolve(this.changes === 1);
            },
        ));
    }

    async setCallTemplateLifecycle(templateId, updates = {}) {
        const fields = [];
        const values = [];
        const mapping = {
            lifecycle_state: 'lifecycle_state',
            submitted_for_review_at: 'submitted_for_review_at',
            reviewed_at: 'reviewed_at',
            reviewed_by: 'reviewed_by',
            review_note: 'review_note',
            live_at: 'live_at',
            live_by: 'live_by',
        };
        Object.entries(mapping).forEach(([key, column]) => {
            if (!Object.prototype.hasOwnProperty.call(updates, key)) {
                return;
            }
            let value = updates[key];
            if (key === 'lifecycle_state') {
                const normalized = String(value || '').trim().toLowerCase();
                value = ['draft', 'review', 'approved', 'live'].includes(normalized)
                    ? normalized
                    : 'draft';
            } else if (key === 'review_note') {
                value = value === null || value === undefined ? null : String(value).slice(0, 500);
            } else {
                value = value === null || value === undefined ? null : String(value);
            }
            fields.push(`${column} = ?`);
            values.push(value);
        });
        if (!fields.length) {
            return 0;
        }
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(templateId);
        return new Promise((resolve, reject) => {
            const sql = `UPDATE call_templates SET ${fields.join(', ')} WHERE id = ?`;
            this.db.run(sql, values, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async promoteCallTemplateLive(templateId, actor = null, expectedVersion = null, audit = null) {
        const safeActor = actor === null || actor === undefined ? null : String(actor).slice(0, 120);
        const normalizedExpectedVersion = expectedVersion == null ? null : Number(expectedVersion);
        if (normalizedExpectedVersion !== null && (!Number.isSafeInteger(normalizedExpectedVersion) || normalizedExpectedVersion < 1)) return 0;
        const auditRunId = String(audit?.simulation_run_id || '').trim();
        const auditScore = Number(audit?.simulation_score);
        const auditFingerprint = String(audit?.config_fingerprint || '').trim().toLowerCase();
        if (!audit || normalizedExpectedVersion === null ||
            !/^simrun_[a-f0-9-]{36}$/.test(auditRunId) ||
            !Number.isSafeInteger(auditScore) || auditScore < 90 || auditScore > 100 ||
            !/^[a-f0-9]{64}$/.test(auditFingerprint)) {
            throw Object.assign(new Error('Promotion audit evidence is invalid'), { code: 'call_template_promotion_audit_invalid' });
        }
        return new Promise((resolve, reject) => {
            const dbConn = this.db;
            dbConn.serialize(() => {
                dbConn.run('BEGIN TRANSACTION');
                dbConn.get(
                    `SELECT id, version FROM call_templates WHERE lifecycle_state = 'live' AND id != ? ORDER BY id LIMIT 1`,
                    [templateId],
                    (previousErr, previousLive) => {
                        if (previousErr) {
                            dbConn.run('ROLLBACK', (rollbackErr) => reject(previousErr || rollbackErr));
                            return;
                        }
                        dbConn.run(
                            `UPDATE call_templates
                             SET lifecycle_state = 'approved', live_at = NULL, live_by = NULL,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE lifecycle_state = 'live' AND id != ?`,
                            [templateId],
                            (demoteErr) => {
                                if (demoteErr) {
                                    dbConn.run('ROLLBACK', (rollbackErr) => reject(demoteErr || rollbackErr));
                                    return;
                                }
                                dbConn.run(
                            `UPDATE call_templates
                             SET lifecycle_state = 'live',
                                 live_at = CURRENT_TIMESTAMP,
                                 live_by = ?,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?${normalizedExpectedVersion === null ? '' : ' AND version = ?'}`,
                            normalizedExpectedVersion === null
                                ? [safeActor, templateId]
                                : [safeActor, templateId, normalizedExpectedVersion],
                            function(promoteErr) {
                                if (promoteErr) {
                                    dbConn.run('ROLLBACK', (rollbackErr) => reject(promoteErr || rollbackErr));
                                    return;
                                }
                                if (this.changes === 0) {
                                    dbConn.run('ROLLBACK', (rollbackErr) => rollbackErr ? reject(rollbackErr) : resolve(0));
                                    return;
                                }
                                const promotedChanges = this.changes;
                                dbConn.run(
                                    `INSERT INTO call_template_promotion_events
                                     (template_id, template_version, actor_label, simulation_run_id,
                                      simulation_score, config_fingerprint, previous_live_template_id,
                                      previous_live_version, created_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                                    [templateId, normalizedExpectedVersion, safeActor || 'admin_token', auditRunId,
                                        auditScore, auditFingerprint, previousLive?.id || null,
                                        previousLive?.version || null],
                                    (auditErr) => {
                                        if (auditErr) {
                                            dbConn.run('ROLLBACK', (rollbackErr) => reject(auditErr || rollbackErr));
                                            return;
                                        }
                                        dbConn.run('COMMIT', (commitErr) => {
                                            if (commitErr) {
                                                dbConn.run('ROLLBACK', (rollbackErr) => reject(commitErr || rollbackErr));
                                            } else {
                                                resolve(promotedChanges);
                                            }
                                        });
                                    },
                                );
                            },
                        );
                    },
                );
                    },
                );
            });
        });
    }

    // Enhanced transcript with personality tracking (supports both table names)
    async addTranscript(transcriptData) {
        const { 
            call_sid, 
            speaker, 
            message, 
            interaction_count,
            personality_used = null,
            adaptation_data = null,
            confidence_score = null
        } = transcriptData;
        
        return new Promise((resolve, reject) => {
            // Insert into both tables for backward compatibility
            const insertIntoTable = (tableName) => {
                return new Promise((resolve, reject) => {
                    const stmt = this.db.prepare(`
                        INSERT INTO ${tableName} (
                            call_sid, speaker, message, interaction_count, 
                            personality_used, adaptation_data, confidence_score
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    stmt.run([
                        call_sid, 
                        speaker, 
                        message, 
                        interaction_count,
                        personality_used,
                        adaptation_data,
                        confidence_score
                    ], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this.lastID);
                        }
                    });
                    stmt.finalize();
                });
            };

            // Insert into both tables
            Promise.all([
                insertIntoTable('call_transcripts'),
                insertIntoTable('transcripts')
            ]).then((results) => {
                resolve(results[0]); // Return the first table's lastID
            }).catch(reject);
        });
    }

    async addCallDigitEvent(payload = {}) {
        const {
            call_sid,
            source = 'unknown',
            profile = 'generic',
            digits = null,
            len = digits ? String(digits).length : null,
            accepted = false,
            reason = null,
            metadata = null
        } = payload;

        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO call_digits (
                    call_sid, source, profile, digits, len, accepted, reason, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run([
                call_sid,
                source,
                profile,
                digits,
                len,
                accepted ? 1 : 0,
                reason,
                metadata ? JSON.stringify(metadata) : null
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async getCallDigits(call_sid) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM call_digits WHERE call_sid = ? ORDER BY created_at ASC, id ASC`,
                [call_sid],
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async getCallMemory(call_sid) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM gpt_call_memory WHERE call_sid = ?`,
                [call_sid],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async upsertCallMemory(call_sid, payload = {}) {
        const summary = typeof payload.summary === 'string' ? payload.summary : '';
        const summaryTurns = Number.isFinite(Number(payload.summary_turns))
            ? Number(payload.summary_turns)
            : 0;
        const metadata = payload.metadata && typeof payload.metadata === 'object'
            ? JSON.stringify(payload.metadata)
            : null;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gpt_call_memory (call_sid, summary, summary_turns, metadata, summary_updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(call_sid) DO UPDATE SET
                    summary = excluded.summary,
                    summary_turns = excluded.summary_turns,
                    metadata = excluded.metadata,
                    summary_updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(sql, [call_sid, summary, summaryTurns, metadata], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async listCallMemoryFacts(call_sid, limit = 20, maxAgeDays = 14) {
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const safeMaxAgeDays = Math.min(Math.max(Number(maxAgeDays) || 14, 1), 90);
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT id, call_sid, fact_key, fact_text, confidence, source, last_seen_at, created_at
                FROM gpt_memory_facts
                WHERE call_sid = ?
                  AND last_seen_at >= datetime('now', ?)
                ORDER BY confidence DESC, last_seen_at DESC, id DESC
                LIMIT ?
            `;
            this.db.all(sql, [call_sid, `-${safeMaxAgeDays} days`, safeLimit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async upsertCallMemoryFact(payload = {}) {
        const {
            call_sid,
            fact_key,
            fact_text,
            confidence = 0.5,
            source = 'derived'
        } = payload;
        if (!call_sid || !fact_key || !fact_text) {
            return 0;
        }
        const safeConfidence = Math.max(0, Math.min(1, Number(confidence) || 0.5));

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gpt_memory_facts (
                    call_sid, fact_key, fact_text, confidence, source, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(call_sid, fact_key) DO UPDATE SET
                    fact_text = excluded.fact_text,
                    confidence = excluded.confidence,
                    source = excluded.source,
                    last_seen_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [call_sid, fact_key, fact_text, safeConfidence, String(source || 'derived')],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async addGptToolAudit(payload = {}) {
        const {
            call_sid = null,
            trace_id = null,
            tool_name = null,
            idempotency_key = null,
            input_hash = null,
            request_payload = null,
            response_payload = null,
            status = 'unknown',
            error_message = null,
            duration_ms = null,
            metadata = null
        } = payload;
        if (!tool_name) {
            return 0;
        }

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gpt_tool_audit (
                    call_sid, trace_id, tool_name, idempotency_key, input_hash,
                    request_payload, response_payload, status, error_message, duration_ms, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            this.db.run(
                sql,
                [
                    call_sid,
                    trace_id,
                    tool_name,
                    idempotency_key,
                    input_hash,
                    request_payload ? JSON.stringify(request_payload) : null,
                    response_payload ? JSON.stringify(response_payload) : null,
                    String(status || 'unknown'),
                    error_message,
                    Number.isFinite(Number(duration_ms)) ? Number(duration_ms) : null,
                    metadata ? JSON.stringify(metadata) : null
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID || 0);
                    }
                }
            );
        });
    }

    async getGptToolAuditByIdempotency(idempotency_key) {
        if (!idempotency_key) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM gpt_tool_audit
                 WHERE idempotency_key = ? AND status IN ('ok', 'cached')
                 ORDER BY id DESC LIMIT 1`,
                [idempotency_key],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async reserveGptToolIdempotency(payload = {}) {
        const {
            idempotency_key,
            call_sid = null,
            trace_id = null,
            tool_name = null,
            input_hash = null,
        } = payload;
        if (!idempotency_key || !tool_name) {
            return { reserved: false };
        }
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gpt_tool_idempotency (
                    idempotency_key, call_sid, trace_id, tool_name, input_hash, status, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
                ON CONFLICT(idempotency_key) DO NOTHING
            `;
            this.db.run(
                sql,
                [idempotency_key, call_sid, trace_id, tool_name, input_hash],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ reserved: (this.changes || 0) > 0 });
                    }
                }
            );
        });
    }

    async getGptToolIdempotency(idempotency_key) {
        if (!idempotency_key) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT *
                FROM gpt_tool_idempotency
                WHERE idempotency_key = ?
                LIMIT 1
            `;
            this.db.get(sql, [idempotency_key], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async completeGptToolIdempotency(payload = {}) {
        const {
            idempotency_key,
            call_sid = null,
            trace_id = null,
            tool_name = null,
            input_hash = null,
            status = 'failed',
            response_payload = null,
            error_message = null,
        } = payload;
        if (!idempotency_key || !tool_name) return 0;
        const safeStatus = ['pending', 'ok', 'failed'].includes(String(status))
            ? String(status)
            : 'failed';
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO gpt_tool_idempotency (
                    idempotency_key, call_sid, trace_id, tool_name, input_hash,
                    status, response_payload, error_message, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    call_sid = COALESCE(excluded.call_sid, gpt_tool_idempotency.call_sid),
                    trace_id = COALESCE(excluded.trace_id, gpt_tool_idempotency.trace_id),
                    tool_name = COALESCE(excluded.tool_name, gpt_tool_idempotency.tool_name),
                    input_hash = COALESCE(excluded.input_hash, gpt_tool_idempotency.input_hash),
                    status = excluded.status,
                    response_payload = excluded.response_payload,
                    error_message = excluded.error_message,
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    idempotency_key,
                    call_sid,
                    trace_id,
                    tool_name,
                    input_hash,
                    safeStatus,
                    response_payload != null ? JSON.stringify(response_payload) : null,
                    error_message,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async upsertPaypalPaymentSession(payload = {}) {
        const externalId = String(payload.external_id || '').trim();
        const action = String(payload.action || '').trim();
        if (!externalId || !action) return 0;

        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO paypal_payment_sessions (
                    call_sid, action, external_id, status, amount, currency,
                    approval_url, idempotency_key, metadata, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(external_id) DO UPDATE SET
                    call_sid = COALESCE(excluded.call_sid, paypal_payment_sessions.call_sid),
                    action = excluded.action,
                    status = COALESCE(excluded.status, paypal_payment_sessions.status),
                    amount = COALESCE(excluded.amount, paypal_payment_sessions.amount),
                    currency = COALESCE(excluded.currency, paypal_payment_sessions.currency),
                    approval_url = COALESCE(excluded.approval_url, paypal_payment_sessions.approval_url),
                    idempotency_key = COALESCE(excluded.idempotency_key, paypal_payment_sessions.idempotency_key),
                    metadata = COALESCE(excluded.metadata, paypal_payment_sessions.metadata),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    payload.call_sid || null,
                    action,
                    externalId,
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    payload.approval_url || null,
                    payload.idempotency_key || null,
                    metadata,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async getPaypalPaymentSession(external_id) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT *
                 FROM paypal_payment_sessions
                 WHERE external_id = ?
                 LIMIT 1`,
                [externalId],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async listPaypalPaymentSessions(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const where = [];
        const params = [];
        if (externalId) {
            where.push('external_id = ?');
            params.push(externalId);
        }
        if (callSid) {
            where.push('call_sid = ?');
            params.push(callSid);
        }
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM paypal_payment_sessions
                 WHERE ${where.join(' OR ')}
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async updatePaypalPaymentSessionStatus(external_id, payload = {}) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return 0;
        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE paypal_payment_sessions
                 SET status = COALESCE(?, status),
                     amount = COALESCE(?, amount),
                     currency = COALESCE(?, currency),
                     metadata = COALESCE(?, metadata),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE external_id = ?`,
                [
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    metadata,
                    externalId,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async listPaypalPaymentEvents(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const eventIds = new Set();
        if (externalId) eventIds.add(externalId);
        if (callSid) {
            const sessions = await this.listPaypalPaymentSessions({
                call_sid: callSid,
                limit,
            });
            sessions.forEach((session) => {
                if (session?.external_id) eventIds.add(session.external_id);
            });
        }
        if (eventIds.size === 0) return [];

        const placeholders = Array.from(eventIds).map(() => '?').join(', ');
        const params = Array.from(eventIds);
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM paypal_payment_events
                 WHERE resource_id IN (${placeholders})
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async recordPaypalPaymentEvent(payload = {}) {
        const externalEventId = String(payload.external_event_id || '').trim();
        if (!externalEventId) return { inserted: false };
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO paypal_payment_events (
                    external_event_id, event_type, resource_id, status, payload
                )
                VALUES (?, ?, ?, ?, ?)
            `;
            this.db.run(
                sql,
                [
                    externalEventId,
                    payload.event_type || null,
                    payload.resource_id || null,
                    payload.status || null,
                    payload.payload ? JSON.stringify(payload.payload) : null,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ inserted: (this.changes || 0) > 0 });
                    }
                }
            );
        });
    }

    async upsertStripePaymentSession(payload = {}) {
        const externalId = String(payload.external_id || '').trim();
        const action = String(payload.action || '').trim();
        if (!externalId || !action) return 0;

        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO stripe_payment_sessions (
                    call_sid, action, external_id, status, amount, currency,
                    approval_url, idempotency_key, metadata, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(external_id) DO UPDATE SET
                    call_sid = COALESCE(excluded.call_sid, stripe_payment_sessions.call_sid),
                    action = excluded.action,
                    status = COALESCE(excluded.status, stripe_payment_sessions.status),
                    amount = COALESCE(excluded.amount, stripe_payment_sessions.amount),
                    currency = COALESCE(excluded.currency, stripe_payment_sessions.currency),
                    approval_url = COALESCE(excluded.approval_url, stripe_payment_sessions.approval_url),
                    idempotency_key = COALESCE(excluded.idempotency_key, stripe_payment_sessions.idempotency_key),
                    metadata = COALESCE(excluded.metadata, stripe_payment_sessions.metadata),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    payload.call_sid || null,
                    action,
                    externalId,
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    payload.approval_url || null,
                    payload.idempotency_key || null,
                    metadata,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async getStripePaymentSession(external_id) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT *
                 FROM stripe_payment_sessions
                 WHERE external_id = ?
                 LIMIT 1`,
                [externalId],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async listStripePaymentSessions(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const where = [];
        const params = [];
        if (externalId) {
            where.push('external_id = ?');
            params.push(externalId);
        }
        if (callSid) {
            where.push('call_sid = ?');
            params.push(callSid);
        }
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM stripe_payment_sessions
                 WHERE ${where.join(' OR ')}
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async updateStripePaymentSessionStatus(external_id, payload = {}) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return 0;
        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE stripe_payment_sessions
                 SET status = COALESCE(?, status),
                     amount = COALESCE(?, amount),
                     currency = COALESCE(?, currency),
                     metadata = COALESCE(?, metadata),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE external_id = ?`,
                [
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    metadata,
                    externalId,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async listStripePaymentEvents(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const eventIds = new Set();
        if (externalId) eventIds.add(externalId);
        if (callSid) {
            const sessions = await this.listStripePaymentSessions({
                call_sid: callSid,
                limit,
            });
            sessions.forEach((session) => {
                if (session?.external_id) eventIds.add(session.external_id);
            });
        }
        if (eventIds.size === 0) return [];

        const placeholders = Array.from(eventIds).map(() => '?').join(', ');
        const params = Array.from(eventIds);
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM stripe_payment_events
                 WHERE resource_id IN (${placeholders})
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async recordStripePaymentEvent(payload = {}) {
        const externalEventId = String(payload.external_event_id || '').trim();
        if (!externalEventId) return { inserted: false };
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO stripe_payment_events (
                    external_event_id, event_type, resource_id, status, payload
                )
                VALUES (?, ?, ?, ?, ?)
            `;
            this.db.run(
                sql,
                [
                    externalEventId,
                    payload.event_type || null,
                    payload.resource_id || null,
                    payload.status || null,
                    payload.payload ? JSON.stringify(payload.payload) : null,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ inserted: (this.changes || 0) > 0 });
                    }
                }
            );
        });
    }

    async upsertSquarePaymentSession(payload = {}) {
        const externalId = String(payload.external_id || '').trim();
        const action = String(payload.action || '').trim();
        if (!externalId || !action) return 0;

        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;

        const changes = await new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO square_payment_sessions (
                    call_sid, action, external_id, status, amount, currency,
                    approval_url, idempotency_key, metadata, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(external_id) DO UPDATE SET
                    call_sid = COALESCE(excluded.call_sid, square_payment_sessions.call_sid),
                    action = excluded.action,
                    status = COALESCE(excluded.status, square_payment_sessions.status),
                    amount = COALESCE(excluded.amount, square_payment_sessions.amount),
                    currency = COALESCE(excluded.currency, square_payment_sessions.currency),
                    approval_url = COALESCE(excluded.approval_url, square_payment_sessions.approval_url),
                    idempotency_key = COALESCE(excluded.idempotency_key, square_payment_sessions.idempotency_key),
                    metadata = COALESCE(excluded.metadata, square_payment_sessions.metadata),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    payload.call_sid || null,
                    action,
                    externalId,
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    payload.approval_url || null,
                    payload.idempotency_key || null,
                    metadata,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
        const links = collectSquarePaymentSessionLinks(externalId, payload);
        await this.upsertSquarePaymentSessionLinks(externalId, links);
        return changes;
    }

    async upsertSquarePaymentSessionLinks(session_external_id, links = []) {
        const sessionExternalId = String(session_external_id || '').trim();
        if (!sessionExternalId || !Array.isArray(links) || links.length === 0) return 0;
        const normalizedLinks = collectSquarePaymentSessionLinks(sessionExternalId, {
            related_links: links,
        });
        let totalChanges = 0;
        for (const link of normalizedLinks) {
            const changes = await new Promise((resolve, reject) => {
                this.db.run(
                    `INSERT INTO square_payment_session_links (
                        session_external_id, related_type, related_id, updated_at
                     )
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(related_type, related_id) DO UPDATE SET
                        session_external_id = excluded.session_external_id,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        sessionExternalId,
                        link.related_type,
                        link.related_id,
                    ],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this.changes || 0);
                        }
                    }
                );
            });
            totalChanges += changes;
        }
        return totalChanges;
    }

    async getSquarePaymentSession(external_id) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT *
                 FROM square_payment_sessions
                 WHERE external_id = ?
                 LIMIT 1`,
                [externalId],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async findSquarePaymentSessionByRelatedId(related_id) {
        const relatedId = String(related_id || '').trim();
        if (!relatedId) return null;
        const directSession = await this.getSquarePaymentSession(relatedId);
        if (directSession) return directSession;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT s.*
                 FROM square_payment_session_links l
                 JOIN square_payment_sessions s
                   ON s.external_id = l.session_external_id
                 WHERE l.related_id = ?
                 ORDER BY
                    l.updated_at DESC,
                    s.updated_at DESC,
                    s.id DESC
                 LIMIT 1`,
                [relatedId],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row || null);
                    }
                }
            );
        });
    }

    async listSquarePaymentSessions(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const where = [];
        const params = [];
        if (externalId) {
            where.push('external_id = ?');
            params.push(externalId);
        }
        if (callSid) {
            where.push('call_sid = ?');
            params.push(callSid);
        }
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM square_payment_sessions
                 WHERE ${where.join(' OR ')}
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async updateSquarePaymentSessionStatus(external_id, payload = {}) {
        const externalId = String(external_id || '').trim();
        if (!externalId) return 0;
        const metadata =
            payload.metadata && typeof payload.metadata === 'object'
                ? JSON.stringify(payload.metadata)
                : payload.metadata || null;
        const changes = await new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE square_payment_sessions
                 SET status = COALESCE(?, status),
                     amount = COALESCE(?, amount),
                     currency = COALESCE(?, currency),
                     metadata = COALESCE(?, metadata),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE external_id = ?`,
                [
                    payload.status || null,
                    payload.amount != null ? String(payload.amount) : null,
                    payload.currency || null,
                    metadata,
                    externalId,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
        if (changes > 0) {
            const links = collectSquarePaymentSessionLinks(externalId, payload);
            await this.upsertSquarePaymentSessionLinks(externalId, links);
        }
        return changes;
    }

    async listSquarePaymentEvents(filters = {}) {
        const externalId = String(filters.external_id || '').trim();
        const callSid = String(filters.call_sid || '').trim();
        const limit = Math.max(1, Math.min(25, Number(filters.limit) || 10));
        if (!externalId && !callSid) return [];

        const eventIds = new Set();
        if (externalId) eventIds.add(externalId);
        if (callSid) {
            const sessions = await this.listSquarePaymentSessions({
                call_sid: callSid,
                limit,
            });
            sessions.forEach((session) => {
                if (session?.external_id) eventIds.add(session.external_id);
            });
        }
        if (eventIds.size === 0) return [];

        const placeholders = Array.from(eventIds).map(() => '?').join(', ');
        const params = Array.from(eventIds);
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT *
                 FROM square_payment_events
                 WHERE resource_id IN (${placeholders})
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`,
                params,
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows || []);
                    }
                }
            );
        });
    }

    async recordSquarePaymentEvent(payload = {}) {
        const externalEventId = String(payload.external_event_id || '').trim();
        if (!externalEventId) return { inserted: false };
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO square_payment_events (
                    external_event_id, event_type, resource_id, status, payload
                )
                VALUES (?, ?, ?, ?, ?)
            `;
            this.db.run(
                sql,
                [
                    externalEventId,
                    payload.event_type || null,
                    payload.resource_id || null,
                    payload.status || null,
                    payload.payload ? JSON.stringify(payload.payload) : null,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ inserted: (this.changes || 0) > 0 });
                    }
                }
            );
        });
    }

    async recordCartesiaWebhookEvent(event = {}) {
        const fields = [event.webhook_request_id, event.call_id, event.agent_id, event.webhook_id,
            event.event_type, event.event_timestamp, event.payload_hash].map((value) => String(value || '').trim());
        if (fields.some((value) => !value) || !/^[a-f0-9]{64}$/.test(fields[6])) {
            throw Object.assign(new Error('Cartesia webhook event metadata is invalid'), { code: 'cartesia_webhook_event_invalid' });
        }
        const [requestId, callId, agentId, webhookId, eventType, timestamp, payloadHash] = fields;
        const database = this.db;
        return new Promise((resolve, reject) => {
            database.run("DELETE FROM cartesia_webhook_events WHERE received_at < datetime('now', '-30 days')", (cleanupError) => {
                if (cleanupError) return reject(cleanupError);
                database.run(
                    `INSERT OR IGNORE INTO cartesia_webhook_events
                    (webhook_request_id, call_id, agent_id, webhook_id, event_type, event_timestamp, payload_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [requestId, callId, agentId, webhookId, eventType, timestamp, payloadHash],
                    function(insertError) {
                        if (insertError) return reject(insertError);
                        if (this.changes > 0) return resolve({ inserted: true, duplicate: false });
                        database.get('SELECT payload_hash FROM cartesia_webhook_events WHERE webhook_request_id = ?', [requestId], (selectError, row) => {
                            if (selectError) return reject(selectError);
                            if (String(row?.payload_hash || '') !== payloadHash) {
                                return resolve({ inserted: false, duplicate: false, conflict: true });
                            }
                            return resolve({ inserted: false, duplicate: true });
                        });
                    },
                );
            });
        });
    }

    async listCartesiaWebhookEvents(options = {}) {
        const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 25)));
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT webhook_request_id, call_id, agent_id, webhook_id, event_type, event_timestamp, received_at
                 FROM cartesia_webhook_events WHERE received_at >= datetime('now', '-30 days')
                 ORDER BY received_at DESC LIMIT ?`,
                [limit],
                (error, rows) => error ? reject(error) : resolve(rows || []),
            );
        });
    }

    async summarizeCartesiaWebhookEvents() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT event_type, COUNT(*) AS event_count, MAX(received_at) AS latest_received_at
                 FROM cartesia_webhook_events
                 WHERE received_at >= datetime('now', '-30 days')
                 GROUP BY event_type`,
                [],
                (error, rows) => {
                    if (error) return reject(error);
                    const eventTypes = {};
                    let count = 0;
                    let latestReceivedAt = null;
                    for (const row of rows || []) {
                        const eventType = String(row.event_type || '').trim();
                        const eventCount = Math.max(0, Number(row.event_count) || 0);
                        if (eventType) eventTypes[eventType] = eventCount;
                        count += eventCount;
                        const receivedAt = String(row.latest_received_at || '');
                        if (receivedAt > String(latestReceivedAt || '')) latestReceivedAt = receivedAt;
                    }
                    resolve({ count, latestReceivedAt, eventTypes });
                },
            );
        });
    }

    async reserveProviderEventIdempotency(payload = {}) {
        const source = String(payload.source || '').trim();
        const payloadHash = String(payload.payload_hash || '').trim();
        const eventKey = String(payload.event_key || `${source}:${payloadHash}`).trim();
        if (!source || !payloadHash || !eventKey) {
            return { reserved: false };
        }
        const ttlMs = Number(payload.ttl_ms);
        const ttlSecondsRaw = Number.isFinite(ttlMs) && ttlMs > 0
            ? Math.ceil(ttlMs / 1000)
            : 300;
        const ttlSeconds = Math.max(1, Math.min(24 * 60 * 60, ttlSecondsRaw));

        return new Promise((resolve, reject) => {
            const cleanupSql = `
                DELETE FROM provider_event_idempotency
                WHERE expires_at <= CURRENT_TIMESTAMP
            `;
            const insertSql = `
                INSERT OR IGNORE INTO provider_event_idempotency (
                    event_key, source, payload_hash, expires_at
                )
                VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))
            `;

            this.db.run(cleanupSql, (cleanupErr) => {
                if (cleanupErr) {
                    reject(cleanupErr);
                    return;
                }
                this.db.run(
                    insertSql,
                    [eventKey, source, payloadHash, ttlSeconds],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({ reserved: (this.changes || 0) > 0 });
                        }
                    }
                );
            });
        });
    }

    async isProviderEventIdempotencyActive(payload = {}) {
        const source = String(payload.source || '').trim();
        const payloadHash = String(payload.payload_hash || '').trim();
        const eventKey = String(payload.event_key || '').trim();
        if (!eventKey && (!source || !payloadHash)) {
            return { active: false };
        }

        return new Promise((resolve, reject) => {
            const cleanupSql = `
                DELETE FROM provider_event_idempotency
                WHERE expires_at <= CURRENT_TIMESTAMP
            `;
            const byEventKeySql = `
                SELECT event_key
                FROM provider_event_idempotency
                WHERE event_key = ?
                  AND expires_at > CURRENT_TIMESTAMP
                LIMIT 1
            `;
            const bySourceHashSql = `
                SELECT event_key
                FROM provider_event_idempotency
                WHERE source = ?
                  AND payload_hash = ?
                  AND expires_at > CURRENT_TIMESTAMP
                LIMIT 1
            `;

            this.db.run(cleanupSql, (cleanupErr) => {
                if (cleanupErr) {
                    reject(cleanupErr);
                    return;
                }

                const sql = eventKey ? byEventKeySql : bySourceHashSql;
                const params = eventKey ? [eventKey] : [source, payloadHash];
                this.db.get(sql, params, (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ active: Boolean(row) });
                    }
                });
            });
        });
    }

    async pruneProviderEventIdempotency() {
        return new Promise((resolve, reject) => {
            const sql = `
                DELETE FROM provider_event_idempotency
                WHERE expires_at <= CURRENT_TIMESTAMP
            `;
            this.db.run(sql, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async recordCartesiaVoiceConsent(input = {}) {
        const consentId = String(input.consent_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const operation = String(input.operation || '').trim();
        const resourceName = String(input.resource_name || '').trim().slice(0, 80);
        if (!/^[a-f0-9]{32}$/.test(consentId) || !/^\d{1,20}$/.test(actorId) || !['instant_clone', 'pro_clone_dataset'].includes(operation) || !resourceName) {
            throw Object.assign(new Error('Cartesia voice consent record is invalid'), { code: 'cartesia_voice_governance_invalid', status: 400 });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO cartesia_voice_governance (consent_id, actor_id, operation, resource_name, status, active_operations, operation_token, operation_started_at)
             VALUES (?, ?, ?, ?, 'active', 1, ?, CURRENT_TIMESTAMP)`, [consentId, actorId, operation, resourceName, consentId],
            (error) => error ? reject(error) : resolve(),
        ));
        return { consentId };
    }

    async linkCartesiaVoiceGovernanceResource(input = {}) {
        const consentId = String(input.consent_id || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const resourceType = String(input.resource_type || '').trim();
        if (!/^[a-f0-9]{32}$/.test(consentId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(resourceId) || !['voice', 'dataset', 'fine_tune'].includes(resourceType)) {
            throw Object.assign(new Error('Cartesia voice resource record is invalid'), { code: 'cartesia_voice_governance_invalid', status: 400 });
        }
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET resource_id = ?, resource_type = ?, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND status = 'active'`, [resourceId, resourceType, consentId],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async finishCartesiaVoiceGovernanceCreation(consentId, operationToken = consentId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET active_operations = 0, operation_token = NULL, operation_started_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND status = 'active' AND active_operations > 0 AND operation_token = ?`, [String(consentId || ''), String(operationToken || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async beginCartesiaVoiceGovernanceOperation(consentId, datasetId, operationToken) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET active_operations = 1, operation_token = ?, operation_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND operation = 'pro_clone_dataset' AND resource_type = 'dataset' AND resource_id = ? AND status = 'active'
               AND (active_operations = 0 OR operation_started_at < datetime('now', '-15 minutes'))`,
            [String(operationToken || ''), String(consentId || ''), String(datasetId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async finishCartesiaVoiceGovernanceOperation(consentId, operationToken, result = {}) {
        const sets = ['active_operations = 0', 'operation_token = NULL', 'operation_started_at = NULL', 'updated_at = CURRENT_TIMESTAMP'];
        const values = [];
        if (result.sampleUploaded === true) sets.push('sample_count = sample_count + 1');
        if (result.fineTuneId) { sets.push('fine_tune_id = ?'); values.push(String(result.fineTuneId)); }
        values.push(String(consentId || ''), String(operationToken || ''));
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET ${sets.join(', ')} WHERE consent_id = ? AND active_operations > 0 AND operation_token = ?`, values,
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async claimCartesiaVoiceGovernanceResourceCleanup(consentId, resourceId, resourceType, operationToken) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET active_operations = 1, operation_token = ?, operation_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND resource_type = ? AND resource_id = ?
               AND status IN ('active', 'revoked', 'provider_failed')
               AND (active_operations = 0 OR operation_started_at < datetime('now', '-15 minutes'))`,
            [String(operationToken || ''), String(consentId || ''), String(resourceType || ''), String(resourceId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async claimCartesiaVoiceGovernanceCleanup(consentId, datasetId, operationToken) {
        return this.claimCartesiaVoiceGovernanceResourceCleanup(consentId, datasetId, 'dataset', operationToken);
    }

    async markCartesiaVoiceGovernanceFailure(consentId, resource = {}, operationToken = consentId) {
        const resourceId = String(resource.resource_id || '').trim();
        const resourceType = String(resource.resource_type || '').trim();
        const hasResource = /^[A-Za-z0-9._:-]{1,200}$/.test(resourceId) && ['voice', 'dataset'].includes(resourceType);
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET status = 'provider_failed',
                resource_id = COALESCE(?, resource_id), resource_type = COALESCE(?, resource_type),
                fine_tune_id = COALESCE(?, fine_tune_id), active_operations = 0, operation_token = NULL, operation_started_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND status IN ('active', 'provider_failed') AND operation_token = ?`,
            [hasResource ? resourceId : null, hasResource ? resourceType : null, /^[A-Za-z0-9._:-]{1,200}$/.test(String(resource.fine_tune_id || '')) ? String(resource.fine_tune_id) : null, String(consentId || ''), String(operationToken || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async listCartesiaVoiceGovernance(limit = 100) {
        const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT consent_id, actor_id, operation, resource_id, resource_type, resource_name, status, consented_at, updated_at, revoked_at, deleted_at
             FROM cartesia_voice_governance ORDER BY consented_at DESC LIMIT ?`, [bounded],
            (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async getCartesiaVoiceGovernance(consentId) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT consent_id, actor_id, operation, resource_id, resource_type, fine_tune_id, sample_count, resource_name, status, consented_at, updated_at, revoked_at, deleted_at
             FROM cartesia_voice_governance WHERE consent_id = ?`, [String(consentId || '')],
            (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async revokeCartesiaVoiceConsent(consentId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET status = 'revoked', active_operations = 0, operation_token = NULL, operation_started_at = NULL, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND status = 'active' AND (active_operations = 0 OR operation_started_at < datetime('now', '-15 minutes'))`, [String(consentId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async markCartesiaVoiceResourceDeleted(consentId, operationToken = '') {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET status = 'deleted', active_operations = 0, operation_token = NULL, operation_started_at = NULL, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND status IN ('active', 'revoked', 'provider_failed') AND (active_operations = 0 OR operation_token = ?)`, [String(consentId || ''), String(operationToken || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async recordCartesiaVoiceSampleUpload(consentId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET sample_count = sample_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND operation = 'pro_clone_dataset' AND resource_type = 'dataset' AND status = 'active'`, [String(consentId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async clearCartesiaFineTuneLink(consentId, fineTuneId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET fine_tune_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND fine_tune_id = ? AND status IN ('active', 'revoked', 'provider_failed')`,
            [String(consentId || ''), String(fineTuneId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async linkCartesiaFineTune(consentId, fineTuneId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_voice_governance SET fine_tune_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE consent_id = ? AND operation = 'pro_clone_dataset' AND resource_type = 'dataset' AND status = 'active'`,
            [String(fineTuneId || ''), String(consentId || '')],
            function(error) { if (error) reject(error); else resolve(this.changes === 1); },
        ));
    }

    async createCartesiaCampaignDraft(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const createdBy = String(input.created_by || '').trim();
        const requestKey = String(input.request_key || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(createdBy) || !/^[A-Za-z0-9._:-]{8,180}$/.test(requestKey) || !/^[a-f0-9]{64}$/.test(requestHash) ||
            !/^[A-Za-z0-9._:-]{1,200}$/.test(String(input.agent_id || '')) || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(input.from_number_id || '')) ||
            !Number.isSafeInteger(Number(input.target_concurrency_limit)) || Number(input.target_concurrency_limit) < 1 || Number(input.target_concurrency_limit) > 10 ||
            !Number.isSafeInteger(Number(input.encryption_key_version)) || Number(input.encryption_key_version) < 1 || recipients.length < 1 || recipients.length > 25) {
            throw Object.assign(new Error('Cartesia campaign draft is invalid'), { code: 'cartesia_campaign_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const existing = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM cartesia_campaigns WHERE business_id = ? AND request_key = ?', [businessId, requestKey],
                (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing) {
                const saved = await this.getCartesiaCampaign(existing.campaign_id, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...saved, idempotentReplay: true };
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO cartesia_campaigns (campaign_id, business_id, created_by, request_key, request_hash, campaign_name,
                    agent_id, from_number_id, target_concurrency_limit, scheduled_at, status, recipient_count, ready_count,
                    blocked_count, encryption_key_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
                [campaignId, businessId, createdBy, requestKey, requestHash, String(input.name || '').slice(0, 120),
                    String(input.agent_id), String(input.from_number_id), Number(input.target_concurrency_limit), input.scheduled_at || null,
                    recipients.length, recipients.filter((row) => row.readiness === 'ready').length,
                    recipients.filter((row) => row.readiness !== 'ready').length, Number(input.encryption_key_version)],
                (error) => error ? reject(error) : resolve(),
            ));
            for (const row of recipients) {
                await new Promise((resolve, reject) => this.db.run(
                    `INSERT INTO cartesia_campaign_recipients (campaign_id, position, encrypted_destination, encrypted_dynamic_variables, destination_masked, readiness, reason_code)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [campaignId, Number(row.position), String(row.encrypted_destination), row.encrypted_dynamic_variables || null, String(row.destination_masked),
                        row.readiness === 'ready' ? 'ready' : 'blocked', String(row.reason_code || 'policy_storage_unavailable')],
                    (error) => error ? reject(error) : resolve(),
                ));
            }
            const saved = await this.getCartesiaCampaign(campaignId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async getCartesiaCampaign(campaignId, businessId) {
        const id = String(campaignId || '').trim();
        const business = String(businessId || '').trim();
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(id) || !/^[A-Za-z0-9._:-]{1,120}$/.test(business)) return null;
        const campaign = await new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM cartesia_campaigns WHERE campaign_id = ? AND business_id = ?', [id, business],
            (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (!campaign) return null;
        const recipients = await new Promise((resolve, reject) => this.db.all(
            'SELECT * FROM cartesia_campaign_recipients WHERE campaign_id = ? ORDER BY position', [id],
            (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        return { campaign, recipients };
    }

    async getCartesiaCallReviewRules(businessId) {
        const business = String(businessId || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(business)) throw Object.assign(new Error('Cartesia business scope is invalid'), { code: 'cartesia_review_rules_invalid' });
        const row = await new Promise((resolve, reject) => this.db.get(
            'SELECT review_failed_calls, review_tool_calls, review_missing_summary, updated_at FROM cartesia_call_review_rules WHERE business_id = ?',
            [business], (error, value) => error ? reject(error) : resolve(value || null),
        ));
        return row ? {
            review_failed_calls: row.review_failed_calls === 1,
            review_tool_calls: row.review_tool_calls === 1,
            review_missing_summary: row.review_missing_summary === 1,
            updated_at: row.updated_at || null,
        } : { review_failed_calls: true, review_tool_calls: false, review_missing_summary: false, updated_at: null };
    }

    async saveCartesiaCallReviewRules(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.updated_by || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) || typeof input.review_failed_calls !== 'boolean' ||
            typeof input.review_tool_calls !== 'boolean' || typeof input.review_missing_summary !== 'boolean') {
            throw Object.assign(new Error('Cartesia call review rules are invalid'), { code: 'cartesia_review_rules_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO cartesia_call_review_rules (business_id, review_failed_calls, review_tool_calls, review_missing_summary, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id) DO UPDATE SET review_failed_calls = excluded.review_failed_calls,
                review_tool_calls = excluded.review_tool_calls, review_missing_summary = excluded.review_missing_summary,
                updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [businessId, input.review_failed_calls ? 1 : 0, input.review_tool_calls ? 1 : 0, input.review_missing_summary ? 1 : 0, actorId],
            (error) => error ? reject(error) : resolve(),
        ));
        return this.getCartesiaCallReviewRules(businessId);
    }

    async getCartesiaCallBusinessScope(providerCallId) {
        const callId = String(providerCallId || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(callId)) return null;
        const rows = await new Promise((resolve, reject) => this.db.all(
            `SELECT business_id FROM outbound_call_idempotency WHERE provider = 'cartesia' AND call_sid = ? AND status = 'completed' AND business_id IS NOT NULL
             UNION SELECT c.business_id FROM cartesia_campaign_recipients r JOIN cartesia_campaigns c ON c.campaign_id = r.campaign_id WHERE r.provider_call_id = ?`,
            [callId, callId], (error, values) => error ? reject(error) : resolve(values || []),
        ));
        const businesses = [...new Set(rows.map((row) => String(row.business_id || '')).filter(Boolean))];
        return businesses.length === 1 ? businesses[0] : null;
    }

    async listDueCartesiaCampaigns(input = {}) {
        const nowIso = String(input.now_iso || new Date().toISOString());
        const limit = Math.max(1, Math.min(50, Number(input.limit) || 10));
        if (!Number.isFinite(Date.parse(nowIso))) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT campaign_id, business_id, approved_by, scheduled_at
             FROM cartesia_campaigns
             WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
             ORDER BY scheduled_at, created_at LIMIT ?`,
            [nowIso, limit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async syncCartesiaCampaignBatch(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const batchId = String(input.provider_batch_id || '').trim();
        const status = String(input.provider_status || '').trim().slice(0, 40);
        const retryCount = Math.max(0, Math.min(100, Number(input.provider_retry_count) || 0));
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[A-Za-z0-9._:-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9_-]{1,40}$/.test(status) || recipients.length > 25 ||
            recipients.some((row) => !Number.isSafeInteger(Number(row.position)) || Number(row.position) < 0)) return false;
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const campaign = await new Promise((resolve, reject) => this.db.get(
                'SELECT status, provider_batch_id FROM cartesia_campaigns WHERE campaign_id = ? AND business_id = ?', [campaignId, businessId],
                (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!campaign || (campaign.provider_batch_id && campaign.provider_batch_id !== batchId)) {
                await new Promise((resolve, reject) => this.db.run('ROLLBACK', (error) => error ? reject(error) : resolve()));
                return false;
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE cartesia_campaigns SET status = CASE WHEN status IN ('unknown','submitting') THEN 'submitted' ELSE status END,
                provider_batch_id = ?, provider_status = ?, provider_retry_count = ?, error_code = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE campaign_id = ? AND business_id = ?`, [batchId, status, retryCount, campaignId, businessId],
                (error) => error ? reject(error) : resolve(),
            ));
            for (const row of recipients) {
                const providerRecipientId = /^[A-Za-z0-9._:-]{1,200}$/.test(String(row.provider_recipient_id || '')) ? String(row.provider_recipient_id) : null;
                const providerCallId = /^[A-Za-z0-9._:-]{1,200}$/.test(String(row.provider_call_id || '')) ? String(row.provider_call_id) : null;
                const providerStatus = /^[A-Za-z0-9_-]{1,40}$/.test(String(row.provider_status || '')) ? String(row.provider_status) : null;
                const endReason = /^[A-Za-z0-9_-]{1,80}$/.test(String(row.provider_end_reason || '')) ? String(row.provider_end_reason) : null;
                await new Promise((resolve, reject) => this.db.run(
                    `UPDATE cartesia_campaign_recipients SET provider_recipient_id = COALESCE(?, provider_recipient_id),
                        provider_call_id = COALESCE(?, provider_call_id), provider_status = ?, provider_end_reason = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE campaign_id = ? AND position = ?`,
                    [providerRecipientId, providerCallId, providerStatus, endReason, campaignId, Number(row.position)],
                    function (error) { error ? reject(error) : resolve(this.changes === 1); },
                ));
            }
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return true;
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async claimCartesiaCampaignRetry(input = {}) {
        const campaignId = String(input.campaign_id || '');
        const retryNumber = Number(input.retry_number);
        const businessId = String(input.business_id || '');
        const positions = Array.isArray(input.recipient_positions) ? input.recipient_positions.map(Number) : [];
        const usageDate = String(input.usage_date || '');
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{4}-\d{2}-\d{2}$/.test(usageDate) ||
            !Number.isSafeInteger(retryNumber) || retryNumber < 0 || retryNumber > 100 || !/^\d{1,20}$/.test(String(input.actor_id || '')) ||
            positions.length < 1 || positions.length > 25 || positions.some((position) => !Number.isSafeInteger(position) || position < 0) || new Set(positions).size !== positions.length) return false;
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        try {
            await previous;
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const campaign = await new Promise((resolve, reject) => this.db.get(
                'SELECT status, recipient_count FROM cartesia_campaigns WHERE campaign_id = ? AND business_id = ?', [campaignId, businessId],
                (error, row) => error ? reject(error) : resolve(row || null),
            ));
            const policy = await new Promise((resolve, reject) => this.db.get(
                'SELECT max_calls_per_day, emergency_stop, quiet_hours_start, quiet_hours_end, timezone FROM call_e_business_safety_policies WHERE business_id = ?', [businessId],
                (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!campaign || !['submitted', 'unknown'].includes(String(campaign.status)) || !policy || Number(policy.emergency_stop) === 1 || Number(policy.max_calls_per_day) < 1) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: !campaign ? 'campaign_not_found' : !policy ? 'safety_policy_required' : Number(policy.emergency_stop) === 1 ? 'emergency_stop' : 'daily_limit_disabled' };
            }
            const now = new Date(input.now_iso || Date.now());
            let parts;
            try { if (!Number.isFinite(now.getTime())) throw new Error(); parts = new Intl.DateTimeFormat('en-CA', { timeZone: String(policy.timezone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).reduce((out, p) => (out[p.type] = p.value, out), {}); }
            catch { await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve())); return { claimed: false, reason: 'safety_policy_invalid' }; }
            const localDate = `${parts.year}-${parts.month}-${parts.day}`;
            if (localDate !== usageDate) { await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve())); return { claimed: false, reason: 'safety_policy_changed' }; }
            const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
            if (validTime(policy.quiet_hours_start) && validTime(policy.quiet_hours_end)) {
                const minute = Number(parts.hour) * 60 + Number(parts.minute);
                const start = Number(policy.quiet_hours_start.slice(0, 2)) * 60 + Number(policy.quiet_hours_start.slice(3));
                const end = Number(policy.quiet_hours_end.slice(0, 2)) * 60 + Number(policy.quiet_hours_end.slice(3));
                if (start < end ? minute >= start && minute < end : minute >= start || minute < end) {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve())); return { claimed: false, reason: 'quiet_hours_active' };
                }
            }
            const used = await new Promise((resolve, reject) => this.db.get(
                `SELECT (SELECT COUNT(*) FROM call_e_business_dispatch_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved') +
                        (SELECT COUNT(*) FROM cartesia_campaign_daily_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved') +
                        (SELECT COUNT(*) FROM cartesia_campaign_retry_daily_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved') AS used`,
                [businessId, usageDate, businessId, usageDate, businessId, usageDate], (error, row) => error ? reject(error) : resolve(Number(row?.used) || 0),
            ));
            if (used + positions.length > Number(policy.max_calls_per_day)) { await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve())); return { claimed: false, reason: 'daily_limit_reached' }; }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO cartesia_campaign_retry_attempts (campaign_id, retry_number, status, candidate_count, actor_id) VALUES (?, ?, 'submitting', ?, ?)`,
                [campaignId, retryNumber, positions.length, String(input.actor_id)], (error) => error ? reject(error) : resolve(),
            ));
            for (const position of positions) await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO cartesia_campaign_retry_daily_reservations (campaign_id, retry_number, business_id, recipient_position, usage_date, status) VALUES (?, ?, ?, ?, ?, 'reserved')`,
                [campaignId, retryNumber, businessId, position, usageDate], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { claimed: true, usage_date: usageDate };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            if (String(error?.code || '').includes('SQLITE_CONSTRAINT')) return { claimed: false, reason: 'retry_already_attempted' };
            throw error;
        } finally { release(); }
    }

    async finishCartesiaCampaignRetry(campaignId, retryNumber, status) {
        if (!['accepted', 'unknown', 'rejected'].includes(String(status))) return false;
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_campaign_retry_attempts SET status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND retry_number = ? AND status = 'submitting'`, [status, campaignId, retryNumber],
            (error) => {
                if (error) return reject(error);
                if (status !== 'rejected') return resolve(true);
                this.db.run(`UPDATE cartesia_campaign_retry_daily_reservations SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND retry_number = ? AND status = 'reserved'`,
                    [campaignId, retryNumber], (releaseError) => releaseError ? reject(releaseError) : resolve(true));
            },
        ));
    }

    async getCartesiaCampaignRetryAttempts(campaignId) {
        const id = String(campaignId || '');
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(id)) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT a.retry_number, a.status, r.recipient_position
             FROM cartesia_campaign_retry_attempts a
             LEFT JOIN cartesia_campaign_retry_daily_reservations r
               ON r.campaign_id = a.campaign_id AND r.retry_number = a.retry_number
             WHERE a.campaign_id = ? ORDER BY a.retry_number, r.recipient_position`,
            [id], (error, rows) => {
                if (error) return reject(error);
                const attempts = new Map();
                for (const row of rows || []) {
                    if (!attempts.has(Number(row.retry_number))) attempts.set(Number(row.retry_number), { retry_number: Number(row.retry_number), status: row.status, recipient_positions: [] });
                    if (row.recipient_position !== null && row.recipient_position !== undefined) attempts.get(Number(row.retry_number)).recipient_positions.push(Number(row.recipient_position));
                }
                resolve([...attempts.values()]);
            },
        ));
    }

    async resolveCartesiaCampaignRetry(campaignId, retryNumber) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_campaign_retry_attempts SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND retry_number = ? AND status IN ('submitting', 'unknown')`, [campaignId, retryNumber],
            function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
    }

    async transitionCartesiaCampaign(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const expected = Array.isArray(input.expected_status) ? input.expected_status : [String(input.expected_status || '')];
        const status = String(input.status || '').trim();
        if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !['draft', 'approved', 'submitting', 'submitted', 'unknown', 'blocked'].includes(status) ||
            expected.some((value) => !['draft', 'approved', 'submitting', 'submitted', 'unknown', 'blocked'].includes(value))) return false;
        const placeholders = expected.map(() => '?').join(',');
        const values = [status, input.approved_by || null, input.provider_batch_id || null, input.provider_status || null,
            input.error_code || null, campaignId, businessId, ...expected];
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_campaigns SET status = ?, approved_by = COALESCE(?, approved_by), provider_batch_id = COALESCE(?, provider_batch_id),
                provider_status = COALESCE(?, provider_status), error_code = ?, updated_at = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND business_id = ? AND status IN (${placeholders})`,
            values, function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
    }

    async claimCartesiaCampaignSubmission(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const usageDate = String(input.usage_date || '').trim();
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const campaign = await new Promise((resolve, reject) => this.db.get(
                'SELECT status, request_hash, recipient_count, ready_count FROM cartesia_campaigns WHERE campaign_id = ? AND business_id = ?',
                [campaignId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!campaign || campaign.status !== 'approved' || campaign.request_hash !== requestHash || Number(campaign.ready_count) !== Number(campaign.recipient_count)) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: 'campaign_not_approvable' };
            }
            const policy = await new Promise((resolve, reject) => this.db.get(
                'SELECT max_calls_per_day, emergency_stop, quiet_hours_start, quiet_hours_end, timezone FROM call_e_business_safety_policies WHERE business_id = ?',
                [businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!policy || Number(policy.emergency_stop) === 1 || Number(policy.max_calls_per_day) < 1) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: !policy ? 'safety_policy_required' : Number(policy.emergency_stop) === 1 ? 'emergency_stop' : 'daily_limit_disabled' };
            }
            const dispatchTime = new Date(input.scheduled_at || input.now_iso || Date.now());
            let localParts;
            try {
                if (!Number.isFinite(dispatchTime.getTime())) throw new Error('invalid time');
                localParts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: String(policy.timezone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
                }).formatToParts(dispatchTime).reduce((parts, part) => (parts[part.type] = part.value, parts), {});
            } catch (_) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: 'safety_policy_invalid' };
            }
            const localDate = `${localParts.year}-${localParts.month}-${localParts.day}`;
            if (usageDate !== localDate) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: 'safety_policy_changed' };
            }
            const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
            if (timePattern.test(String(policy.quiet_hours_start || '')) && timePattern.test(String(policy.quiet_hours_end || ''))) {
                const minute = Number(localParts.hour) * 60 + Number(localParts.minute);
                const start = Number(policy.quiet_hours_start.slice(0, 2)) * 60 + Number(policy.quiet_hours_start.slice(3));
                const end = Number(policy.quiet_hours_end.slice(0, 2)) * 60 + Number(policy.quiet_hours_end.slice(3));
                const quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end;
                if (quiet) {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { claimed: false, reason: 'quiet_hours_active' };
                }
            }
            const used = await new Promise((resolve, reject) => this.db.get(
                `SELECT (SELECT COUNT(*) FROM call_e_business_dispatch_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved') +
                        (SELECT COUNT(*) FROM cartesia_campaign_daily_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved') AS used`,
                [businessId, usageDate, businessId, usageDate], (error, row) => error ? reject(error) : resolve(Number(row?.used) || 0),
            ));
            const count = Number(campaign.recipient_count);
            if (used + count > Number(policy.max_calls_per_day)) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: 'daily_limit_reached', remaining: Math.max(0, Number(policy.max_calls_per_day) - used) };
            }
            const recipients = await new Promise((resolve, reject) => this.db.all(
                'SELECT position FROM cartesia_campaign_recipients WHERE campaign_id = ? AND readiness = \'ready\' ORDER BY position',
                [campaignId], (error, rows) => error ? reject(error) : resolve(rows || []),
            ));
            if (recipients.length !== count) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { claimed: false, reason: 'recipient_state_invalid' };
            }
            for (const recipient of recipients) {
                await new Promise((resolve, reject) => this.db.run(
                    `INSERT INTO cartesia_campaign_daily_reservations (campaign_id, business_id, recipient_position, usage_date, status)
                     VALUES (?, ?, ?, ?, 'reserved')`, [campaignId, businessId, Number(recipient.position), usageDate],
                    (error) => error ? reject(error) : resolve(),
                ));
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE cartesia_campaigns SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
                 WHERE campaign_id = ? AND business_id = ? AND status = 'approved'`, [campaignId, businessId],
                (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { claimed: true, reserved: count, usage_date: usageDate };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async releaseCartesiaCampaignDailyReservations(campaignId) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE cartesia_campaign_daily_reservations SET status = 'released', released_at = CURRENT_TIMESTAMP
             WHERE campaign_id = ? AND status = 'reserved'`, [String(campaignId || '')],
            function (error) { error ? reject(error) : resolve(this.changes || 0); },
        ));
    }

    async reserveOutboundCallIdempotency(payload = {}) {
        const idempotencyKey = String(payload.idempotency_key || '').trim();
        const provider = String(payload.provider || '').trim().toLowerCase();
        const requestHash = String(payload.request_hash || '').trim() || null;
        if (!idempotencyKey || !provider) {
            return { reserved: false };
        }
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO outbound_call_idempotency (
                    idempotency_key, provider, business_id, request_hash, status, updated_at
                )
                VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
            `;
            this.db.run(sql, [idempotencyKey, provider, String(payload.business_id || '').trim() || null, requestHash], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ reserved: (this.changes || 0) > 0 });
                }
            });
        });
    }

    async reserveCallEOutboundCall(payload = {}) {
        const idempotencyKey = String(payload.idempotency_key || "").trim();
        const requestHash = String(payload.request_hash || "").trim();
        const localCallId = String(payload.local_call_id || "").trim();
        if (!idempotencyKey || !/^[a-f0-9]{64}$/i.test(requestHash) || !/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
            throw new Error("CALL-E call reservation is invalid");
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO outbound_call_idempotency (
                    idempotency_key, provider, request_hash, status, response_payload, updated_at
                ) VALUES (?, 'call_e', ?, 'pending', ?, CURRENT_TIMESTAMP)`,
                [idempotencyKey, requestHash, JSON.stringify({ localCallId })],
                function (err) {
                    if (err) return reject(err);
                    resolve({ reserved: (this.changes || 0) > 0 });
                },
            );
        });
    }

    async reserveCallEPilotDispatch(payload = {}) {
        const reservationKey = String(payload.reservation_key || "").trim();
        if (!/^voicednut:call-e:[A-Za-z0-9._:-]{8,180}$/.test(reservationKey)) {
            throw new Error("CALL-E pilot reservation key is invalid");
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO call_e_pilot_dispatch_guard (
                    singleton_id, reservation_key, state, updated_at
                ) VALUES (1, ?, 'reserved', CURRENT_TIMESTAMP)`,
                [reservationKey],
                (insertError) => {
                    if (insertError) return reject(insertError);
                    this.db.get(
                        `SELECT reservation_key, state FROM call_e_pilot_dispatch_guard WHERE singleton_id = 1`,
                        [],
                        (selectError, row) => {
                            if (selectError) return reject(selectError);
                            if (!row) return resolve({ reserved: false, reason: "pilot_guard_unavailable" });
                            if (row.reservation_key !== reservationKey) {
                                return resolve({ reserved: false, reason: "pilot_cap_reached" });
                            }
                            resolve({ reserved: true, replay: true, state: row.state });
                        },
                    );
                },
            );
        });
    }

    async consumeCallEPilotDispatch(payload = {}) {
        const reservationKey = String(payload.reservation_key || "").trim();
        if (!/^voicednut:call-e:[A-Za-z0-9._:-]{8,180}$/.test(reservationKey)) return false;
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE call_e_pilot_dispatch_guard
                 SET state = 'consumed', updated_at = CURRENT_TIMESTAMP
                 WHERE singleton_id = 1 AND reservation_key = ? AND state IN ('reserved', 'consumed')`,
                [reservationKey],
                function (error) {
                    if (error) return reject(error);
                    resolve((this.changes || 0) > 0);
                },
            );
        });
    }

    async releaseCallEPilotDispatch(payload = {}) {
        const reservationKey = String(payload.reservation_key || "").trim();
        if (!/^voicednut:call-e:[A-Za-z0-9._:-]{8,180}$/.test(reservationKey)) return false;
        return new Promise((resolve, reject) => {
            this.db.run(
                `DELETE FROM call_e_pilot_dispatch_guard
                 WHERE singleton_id = 1 AND reservation_key = ? AND state = 'reserved'`,
                [reservationKey],
                function (error) {
                    if (error) return reject(error);
                    resolve((this.changes || 0) > 0);
                },
            );
        });
    }

    async getCallEPilotDispatchState() {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT state, created_at, updated_at FROM call_e_pilot_dispatch_guard WHERE singleton_id = 1`,
                [],
                (error, row) => {
                    if (error) return reject(error);
                    resolve(row ? { ...row } : null);
                },
            );
        });
    }

    async hasCallTemplateBusinessId(businessId) {
        const id = String(businessId || "").trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) return false;
        return new Promise((resolve, reject) => {
            this.db.get("SELECT 1 AS present FROM call_templates WHERE business_id = ? LIMIT 1", [id], (error, row) => {
                if (error) return reject(error);
                resolve(Boolean(row));
            });
        });
    }

    async grantCallEBusinessOperator(input = {}) {
        const businessId = String(input.business_id || "").trim();
        const telegramId = String(input.telegram_id || "").trim();
        const role = String(input.role || "").trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(telegramId) ||
            !["policy_manager", "call_operator"].includes(role)) {
            throw new Error("CALL-E business operator input is invalid");
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO call_e_business_operator_events (business_id, telegram_id, event_type, role)
                 VALUES (?, ?, 'access_granted', ?)`,
                [businessId, telegramId, role],
                function (error) {
                    if (error) return reject(error);
                    resolve({ saved: this.changes > 0 });
                },
            );
        });
    }

    async revokeCallEBusinessOperator(input = {}) {
        const businessId = String(input.business_id || "").trim();
        const telegramId = String(input.telegram_id || "").trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(telegramId)) return false;
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO call_e_business_operator_events (business_id, telegram_id, event_type, role)
                 VALUES (?, ?, 'access_revoked', NULL)`,
                [businessId, telegramId],
                function (error) {
                    if (error) return reject(error);
                    resolve(this.changes > 0);
                },
            );
        });
    }

    async getCallEBusinessOperator(businessId, telegramId) {
        const normalizedBusinessId = String(businessId || "").trim();
        const normalizedTelegramId = String(telegramId || "").trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId) || !/^\d{1,20}$/.test(normalizedTelegramId)) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT event_type, role FROM call_e_business_operator_events
                 WHERE business_id = ? AND telegram_id = ? ORDER BY id DESC LIMIT 1`,
                [normalizedBusinessId, normalizedTelegramId],
                (error, row) => {
                    if (error) return reject(error);
                    resolve(row?.event_type === "access_granted" ? { role: row.role } : null);
                },
            );
        });
    }

    async createBusinessIntegrationConnection(input = {}) {
        const values = [
            input.connection_id,
            input.business_id,
            input.provider,
            input.secret_reference,
            input.created_by || 'admin_token',
            input.created_by || 'admin_token',
        ];
        const changed = await new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO business_integration_connections (
                    connection_id, business_id, provider, secret_reference, status,
                    created_by, updated_by, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                values,
                function (error) { error ? reject(error) : resolve(this.changes === 1); },
            );
        });
        const row = await new Promise((resolve, reject) => {
            this.db.get(
                `SELECT connection_id, business_id, provider, secret_reference, status,
                        created_by, updated_by, created_at, updated_at, revoked_by, revoked_at
                 FROM business_integration_connections WHERE secret_reference = ?`,
                [input.secret_reference],
                (error, result) => error ? reject(error) : resolve(result || null),
            );
        });
        return { row, created: changed };
    }

    async listBusinessIntegrationConnections(businessId, status) {
        const where = ['business_id = ?'];
        const params = [businessId];
        if (status) { where.push('status = ?'); params.push(status); }
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT connection_id, business_id, provider, status, created_by,
                        updated_by, created_at, updated_at, revoked_by, revoked_at
                 FROM business_integration_connections WHERE ${where.join(' AND ')}
                 ORDER BY created_at DESC, connection_id ASC`,
                params,
                (error, rows) => error ? reject(error) : resolve(rows || []),
            );
        });
    }

    async getBusinessIntegrationConnection(businessId, connectionId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT connection_id, business_id, provider, secret_reference, status,
                        created_by, updated_by, created_at, updated_at, revoked_by, revoked_at
                 FROM business_integration_connections WHERE business_id = ? AND connection_id = ?`,
                [businessId, connectionId],
                (error, row) => error ? reject(error) : resolve(row || null),
            );
        });
    }

    async revokeBusinessIntegrationConnection(businessId, connectionId, actor = 'admin_token') {
        await new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE business_integration_connections
                 SET status = 'revoked', revoked_by = ?, revoked_at = CURRENT_TIMESTAMP,
                     updated_by = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE business_id = ? AND connection_id = ? AND status = 'active'`,
                [actor, actor, businessId, connectionId],
                (error) => error ? reject(error) : resolve(),
            );
        });
        return this.getBusinessIntegrationConnection(businessId, connectionId);
    }

    async recordCallEOperatorConfirmation(input = {}) {
        const confirmationKey = String(input.confirmation_key || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const businessId = String(input.business_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const fingerprint = String(input.preview_fingerprint || '').trim();
        const telegramId = String(input.recorded_by_telegram_id || '').trim();
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(confirmationKey) || !/^[a-f0-9]{64}$/.test(requestHash) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !Number.isSafeInteger(templateId) || templateId <= 0 ||
            !Number.isSafeInteger(templateVersion) || templateVersion <= 0 || !/^[a-f0-9]{64}$/.test(fingerprint) ||
            !/^\d{1,20}$/.test(telegramId)) {
            throw new Error('CALL-E operator confirmation persistence input is invalid');
        }
        const database = this.db;
        return new Promise((resolve, reject) => {
            database.run(
                `INSERT OR IGNORE INTO call_e_operator_confirmation_events (
                    confirmation_key, request_hash, business_id, template_id, template_version,
                    preview_fingerprint, recorded_by_telegram_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [confirmationKey, requestHash, businessId, templateId, templateVersion, fingerprint, telegramId],
                function (error) {
                    if (error) return reject(error);
                    if (this.changes > 0) return resolve({ recorded: true, replay: false, conflict: false });
                    database.get(
                        'SELECT request_hash FROM call_e_operator_confirmation_events WHERE confirmation_key = ?',
                        [confirmationKey],
                        (lookupError, row) => {
                            if (lookupError) return reject(lookupError);
                            resolve({ recorded: false, replay: row?.request_hash === requestHash, conflict: row?.request_hash !== requestHash });
                        },
                    );
                },
            );
        });
    }

    async hasCallEOperatorConfirmation(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const fingerprint = String(input.preview_fingerprint || '').trim().toLowerCase();
        const telegramId = String(input.recorded_by_telegram_id || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !Number.isSafeInteger(templateId) || templateId <= 0 ||
            !Number.isSafeInteger(templateVersion) || templateVersion <= 0 || !/^[a-f0-9]{64}$/.test(fingerprint) ||
            !/^\d{1,20}$/.test(telegramId)) return false;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT 1 AS confirmed FROM call_e_operator_confirmation_events
                 WHERE business_id = ? AND template_id = ? AND template_version = ?
                   AND preview_fingerprint = ? AND recorded_by_telegram_id = ? LIMIT 1`,
                [businessId, templateId, templateVersion, fingerprint, telegramId],
                (error, row) => error ? reject(error) : resolve(Boolean(row)),
            );
        });
    }

    async insertCallEContactPolicyEvent(event = {}) {
        const eventKey = String(event.eventKey || "").trim();
        const requestHash = String(event.requestHash || "").trim();
        const businessId = String(event.businessId || "").trim();
        const destination = String(event.destination || "").trim();
        const eventType = String(event.eventType || "").trim();
        const source = String(event.source || "").trim();
        const evidenceReference = event.evidenceReference == null ? null : String(event.evidenceReference).trim();
        const occurredAt = String(event.occurredAt || "").trim();
        const expiresAt = event.expiresAt == null ? null : String(event.expiresAt).trim();
        const recordedBy = event.recordedByTelegramId == null ? null : String(event.recordedByTelegramId).trim();
        const allowedSources = eventType === "consent_granted"
            ? ["web_form", "written", "verbal", "other"]
            : ["recipient_request", "operator_report", "provider_report", "other"];
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(eventKey) || !/^[a-f0-9]{64}$/i.test(requestHash) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\+[1-9]\d{7,14}$/.test(destination) ||
            !["consent_granted", "opted_out"].includes(eventType) || !allowedSources.includes(source) ||
            !Number.isFinite(Date.parse(occurredAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt) ||
            (eventType === "consent_granted" && !/^[A-Za-z0-9._:-]{8,180}$/.test(evidenceReference || "")) ||
            (eventType === "opted_out" && evidenceReference !== null) ||
            (recordedBy !== null && !/^\d{1,20}$/.test(recordedBy)) ||
            (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(expiresAt)))) {
            throw new Error("CALL-E contact policy event persistence input is invalid");
        }
        const database = this.db;
        return new Promise((resolve, reject) => {
            database.run(
                `INSERT OR IGNORE INTO call_e_contact_policy_events (
                    event_key, request_hash, business_id, destination, event_type,
                    source, evidence_reference, occurred_at, expires_at, recorded_by_telegram_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [eventKey, requestHash, businessId, destination, eventType,
                    source, evidenceReference, occurredAt, expiresAt, recordedBy],
                function (insertError) {
                    if (insertError) return reject(insertError);
                    if (this.changes > 0) return resolve({ inserted: true, replay: false, conflict: false });
                    database.get(
                        `SELECT request_hash FROM call_e_contact_policy_events WHERE event_key = ?`,
                        [eventKey],
                        (lookupError, row) => {
                            if (lookupError) return reject(lookupError);
                            if (!row) return resolve({ inserted: false, replay: false, conflict: true });
                            const sameRequest = row.request_hash === requestHash;
                            resolve({ inserted: false, replay: sameRequest, conflict: !sameRequest });
                        },
                    );
                },
            );
        });
    }

    async listCallEContactPolicyEvents(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const destination = String(input.destination || '').trim();
        const limit = Math.max(1, Math.min(25, Math.floor(Number(input.limit) || 10)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\+[1-9]\d{7,14}$/.test(destination)) {
            throw Object.assign(new Error('CALL-E contact policy scope is invalid'), { code: 'call_e_contact_policy_invalid' });
        }
        return new Promise((resolve, reject) => this.db.all(
            `SELECT event_type, source, occurred_at, expires_at, created_at
             FROM call_e_contact_policy_events WHERE business_id = ? AND destination = ?
             ORDER BY occurred_at DESC, id DESC LIMIT ?`,
            [businessId, destination, limit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async getCallEContactPolicyEligibility(input = {}) {
        const businessId = String(input.business_id || "").trim();
        const destination = String(input.destination || "").trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\+[1-9]\d{7,14}$/.test(destination)) {
            return { eligible: false, reason: "scope_or_destination_invalid" };
        }
        const eligibilityAt = input.at ? new Date(input.at) : new Date();
        if (!Number.isFinite(eligibilityAt.getTime())) return { eligible: false, reason: "policy_storage_unavailable" };
        const eligibilityAtIso = eligibilityAt.toISOString();
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT
                    EXISTS(
                        SELECT 1 FROM call_e_contact_policy_events
                        WHERE business_id = ? AND destination = ? AND event_type = 'opted_out'
                    ) AS opted_out,
                    (SELECT occurred_at FROM call_e_contact_policy_events
                     WHERE business_id = ? AND destination = ? AND event_type = 'consent_granted'
                     ORDER BY occurred_at DESC, id DESC LIMIT 1) AS latest_consent_at,
                    (SELECT expires_at FROM call_e_contact_policy_events
                     WHERE business_id = ? AND destination = ? AND event_type = 'consent_granted'
                     ORDER BY occurred_at DESC, id DESC LIMIT 1) AS latest_consent_expiry,
                    EXISTS(
                        SELECT 1 FROM call_e_contact_policy_events
                        WHERE business_id = ? AND destination = ? AND event_type = 'consent_granted'
                    ) AS has_consent,
                    COALESCE((SELECT contact_cooldown_hours FROM call_e_business_safety_policies WHERE business_id = ?), 0) AS cooldown_hours,
                    (EXISTS(
                        SELECT 1 FROM call_e_contact_dispatch_history
                        WHERE business_id = ? AND destination_hash = ? AND status IN ('reserved', 'accepted')
                          AND datetime(attempted_at) >= datetime(?, '-' ||
                            (SELECT contact_cooldown_hours FROM call_e_business_safety_policies WHERE business_id = ?) || ' hours')
                    ) OR EXISTS(
                        SELECT 1 FROM outbound_contact_dispatch_history
                        WHERE business_id = ? AND destination_hash = ? AND status IN ('reserved', 'accepted')
                          AND datetime(attempted_at) >= datetime(?, '-' ||
                            (SELECT contact_cooldown_hours FROM call_e_business_safety_policies WHERE business_id = ?) || ' hours')
                    )) AS cooldown_active`,
                [businessId, destination, businessId, destination, businessId, destination, businessId, destination,
                    businessId, businessId, String(input.destination_hash || ''), eligibilityAtIso, businessId,
                    businessId, String(input.destination_hash || ''), eligibilityAtIso, businessId],
                (error, row) => {
                    if (error) return reject(error);
                    if (Number(row?.opted_out) === 1) return resolve({ eligible: false, reason: "opted_out" });
                    if (Number(row?.has_consent) !== 1) return resolve({ eligible: false, reason: "consent_missing" });
                    if (Date.parse(row.latest_consent_at) > eligibilityAt.getTime()) return resolve({ eligible: false, reason: "consent_not_effective" });
                    if (row.latest_consent_expiry && Date.parse(row.latest_consent_expiry) <= eligibilityAt.getTime()) {
                        return resolve({ eligible: false, reason: "consent_expired" });
                    }
                    if (Number(row.cooldown_hours) > 0 && (!/^[a-f0-9]{64}$/.test(String(input.destination_hash || '')) || Number(row.cooldown_active) === 1)) {
                        return resolve({ eligible: false, reason: Number(row.cooldown_active) === 1 ? 'cooldown_active' : 'policy_storage_unavailable' });
                    }
                    resolve({ eligible: true, reason: null });
                },
            );
        });
    }

    async createCallECampaignReviewDraft(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const schemaFingerprint = String(input.schema_fingerprint || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const createdBy = String(input.created_by || '').trim();
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!/^campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !Number.isSafeInteger(templateId) || templateId < 1 || !Number.isSafeInteger(templateVersion) || templateVersion < 1 ||
            !/^[a-f0-9]{64}$/.test(schemaFingerprint) || !/^[a-f0-9]{64}$/.test(requestHash) ||
            !/^\d{1,20}$/.test(createdBy) || recipients.length < 1 || recipients.length > 25) {
            throw Object.assign(new Error('CALL-E campaign review draft is invalid'), { code: 'call_e_campaign_invalid' });
        }
        for (const [index, recipient] of recipients.entries()) {
            if (Number(recipient?.position) !== index || !/^\+?[•]{4,14}\d{4}$/.test(String(recipient?.phone_masked || '')) ||
                !['ready', 'blocked'].includes(recipient?.status) ||
                !['compatible', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired',
                    'consent_not_effective', 'opted_out', 'policy_storage_unavailable', 'template_incompatible', 'preview_failed'].includes(recipient?.reason_code)) {
                throw Object.assign(new Error('CALL-E campaign review recipient is invalid'), { code: 'call_e_campaign_invalid' });
            }
            if ((recipient.status === 'ready') !== (recipient.reason_code === 'compatible')) {
                throw Object.assign(new Error('CALL-E campaign review recipient state is inconsistent'), { code: 'call_e_campaign_invalid' });
            }
        }
        const readyCount = recipients.filter((recipient) => recipient.status === 'ready').length;
        const blockedCount = recipients.length - readyCount;
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const existing = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_campaign_reviews WHERE campaign_id = ? AND business_id = ?',
                [campaignId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing) {
                if (existing.request_hash !== requestHash || existing.created_by !== createdBy) {
                    throw Object.assign(new Error('Campaign idempotency key was reused for different input'), { code: 'call_e_campaign_idempotency_conflict' });
                }
                const savedRecipients = await new Promise((resolve, reject) => this.db.all(
                    'SELECT position, destination_masked, readiness AS status, reason_code FROM call_e_campaign_review_recipients WHERE campaign_id = ? ORDER BY position',
                    [campaignId], (error, rows) => error ? reject(error) : resolve(rows || []),
                ));
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { campaign: existing, recipients: savedRecipients, idempotentReplay: true };
            }
            const counts = await new Promise((resolve, reject) => this.db.get(
                "SELECT COUNT(*) AS count FROM call_e_campaign_reviews WHERE business_id = ? AND status = 'draft'",
                [businessId], (error, row) => error ? reject(error) : resolve(row || { count: 0 }),
            ));
            if (Number(counts.count) >= 10) {
                throw Object.assign(new Error('This business already has the maximum number of pending campaign reviews'), { code: 'call_e_campaign_review_cap_reached' });
            }
            const now = new Date().toISOString();
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_campaign_reviews (
                    campaign_id, business_id, template_id, template_version, schema_fingerprint, request_hash,
                    created_by, status, recipient_count, ready_count, blocked_count, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
                [campaignId, businessId, templateId, templateVersion, schemaFingerprint, requestHash,
                    createdBy, recipients.length, readyCount, blockedCount, now],
                (error) => error ? reject(error) : resolve(),
            ));
            for (const recipient of recipients) {
                await new Promise((resolve, reject) => this.db.run(
                    `INSERT INTO call_e_campaign_review_recipients (
                        campaign_id, position, destination_masked, readiness, reason_code
                    ) VALUES (?, ?, ?, ?, ?)`,
                    [campaignId, recipient.position, recipient.phone_masked, recipient.status, recipient.reason_code],
                    (error) => error ? reject(error) : resolve(),
                ));
            }
            const saved = await this.getCallECampaignReviewForBusiness(campaignId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async listCallECampaignReviewsForBusiness(businessId, options = {}) {
        const normalizedBusinessId = String(businessId || '').trim();
        const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
        const offset = Math.max(0, Math.min(5000, Math.floor(Number(options.offset) || 0)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return [];
        const status = ['draft', 'approved', 'rejected'].includes(options.status) ? options.status : null;
        return new Promise((resolve, reject) => this.db.all(
            `SELECT * FROM call_e_campaign_reviews WHERE business_id = ? AND (? IS NULL OR status = ?)
             ORDER BY created_at DESC, campaign_id DESC LIMIT ? OFFSET ?`,
            [normalizedBusinessId, status, status, limit, offset], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async getCallECampaignReviewForBusiness(campaignId, businessId) {
        const normalizedCampaignId = String(campaignId || '').trim();
        const normalizedBusinessId = String(businessId || '').trim();
        if (!/^campaign_[a-f0-9]{64}$/.test(normalizedCampaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return null;
        const campaign = await new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM call_e_campaign_reviews WHERE campaign_id = ? AND business_id = ?',
            [normalizedCampaignId, normalizedBusinessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (!campaign) return null;
        const recipients = await new Promise((resolve, reject) => this.db.all(
            'SELECT position, destination_masked, readiness AS status, reason_code FROM call_e_campaign_review_recipients WHERE campaign_id = ? ORDER BY position',
            [normalizedCampaignId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        const reviewHistory = await new Promise((resolve, reject) => this.db.all(
            `SELECT reviewed_by, decision, request_hash, created_at FROM call_e_approval_decisions
             WHERE entity_type = 'campaign' AND entity_id = ? AND business_id = ? ORDER BY decision_id`,
            [normalizedCampaignId, normalizedBusinessId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        return { campaign, recipients, reviewHistory };
    }

    async reviewCallECampaignForBusiness(input = {}) {
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const reviewer = String(input.reviewed_by || '').trim();
        const decision = String(input.decision || '').trim();
        if (!/^campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(reviewer) || !['approve', 'reject'].includes(decision)) {
            throw Object.assign(new Error('CALL-E campaign review decision is invalid'), { code: 'call_e_campaign_invalid' });
        }
        const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const campaign = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_campaign_reviews WHERE campaign_id = ? AND business_id = ?',
                [campaignId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!campaign) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            const savedDecision = await new Promise((resolve, reject) => this.db.get(
                `SELECT reviewed_by, decision, request_hash FROM call_e_approval_decisions
                 WHERE entity_type = 'campaign' AND entity_id = ? AND business_id = ?`,
                [campaignId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (savedDecision) {
                if (savedDecision.reviewed_by !== reviewer || savedDecision.decision !== decision || savedDecision.request_hash !== campaign.request_hash) {
                    throw Object.assign(new Error('Campaign review is already final'), { code: 'call_e_campaign_review_final' });
                }
                const replay = await this.getCallECampaignReviewForBusiness(campaignId, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...replay, idempotentReplay: true };
            }
            if (campaign.status !== 'draft') {
                if (campaign.status === nextStatus && campaign.reviewed_by === reviewer) {
                    await new Promise((resolve, reject) => this.db.run(
                        `INSERT OR IGNORE INTO call_e_approval_decisions
                         (entity_type, entity_id, business_id, reviewed_by, decision, request_hash, created_at)
                         VALUES ('campaign', ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
                        [campaignId, businessId, reviewer, decision, campaign.request_hash, campaign.reviewed_at],
                        (error) => error ? reject(error) : resolve(),
                    ));
                    const replay = await this.getCallECampaignReviewForBusiness(campaignId, businessId);
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { ...replay, idempotentReplay: true };
                }
                throw Object.assign(new Error('Campaign review is already final'), { code: 'call_e_campaign_review_final' });
            }
            if (campaign.created_by === reviewer) {
                throw Object.assign(new Error('A different business operator must review this campaign'), { code: 'call_e_campaign_four_eyes_required' });
            }
            if (decision === 'approve' && Number(campaign.ready_count) !== Number(campaign.recipient_count)) {
                throw Object.assign(new Error('Campaign cannot be approved while any destination is blocked'), { code: 'call_e_campaign_blocked_recipients' });
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_reviews SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
                 WHERE campaign_id = ? AND business_id = ? AND status = 'draft'`,
                [nextStatus, reviewer, campaignId, businessId], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_approval_decisions
                 (entity_type, entity_id, business_id, reviewed_by, decision, request_hash)
                 VALUES ('campaign', ?, ?, ?, ?, ?)`,
                [campaignId, businessId, reviewer, decision, campaign.request_hash],
                (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignReviewForBusiness(campaignId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async createCallECampaignExecutionRehearsal(input = {}) {
        const rehearsalId = String(input.rehearsal_id || '').trim();
        const campaignId = String(input.campaign_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const startedBy = String(input.started_by || '').trim();
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!/^rehearsal_[a-f0-9]{64}$/.test(rehearsalId) || !/^campaign_[a-f0-9]{64}$/.test(campaignId) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^[a-f0-9]{64}$/.test(requestHash) ||
            !/^\d{1,20}$/.test(startedBy) || recipients.length < 1 || recipients.length > 25 ||
            recipients.some((row, index) => Number(row?.position) !== index ||
                !['simulated_ready', 'blocked'].includes(row?.state) ||
                !['compatible', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired',
                    'consent_not_effective', 'opted_out', 'policy_storage_unavailable', 'template_incompatible', 'preview_failed'].includes(row?.reason_code) ||
                ((row.state === 'simulated_ready') !== (row.reason_code === 'compatible')))) {
            throw Object.assign(new Error('CALL-E execution rehearsal is invalid'), { code: 'call_e_campaign_rehearsal_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
        await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
        const existing = await new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM call_e_campaign_execution_rehearsals WHERE rehearsal_id = ? OR (campaign_id = ? AND request_hash = ?)',
            [rehearsalId, campaignId, requestHash], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (existing) {
            if (existing.request_hash !== requestHash || existing.started_by !== startedBy) {
                throw Object.assign(new Error('Rehearsal idempotency key conflicts with an existing request'), { code: 'call_e_campaign_rehearsal_conflict' });
            }
            const rows = await new Promise((resolve, reject) => this.db.all(
                'SELECT position, state, reason_code FROM call_e_campaign_execution_rehearsal_rows WHERE rehearsal_id = ? ORDER BY position',
                [existing.rehearsal_id], (error, result) => error ? reject(error) : resolve(result || []),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { rehearsal: existing, recipients: rows, idempotentReplay: true };
        }
        const readyCount = recipients.filter((row) => row.state === 'simulated_ready').length;
        const blockedCount = recipients.length - readyCount;
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_campaign_execution_rehearsals (
                rehearsal_id, campaign_id, business_id, request_hash, started_by, status,
                recipient_count, ready_count, blocked_count
            ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
            [rehearsalId, campaignId, businessId, requestHash, startedBy, recipients.length, readyCount, blockedCount],
            (error) => error ? reject(error) : resolve(),
        ));
        for (const row of recipients) {
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_campaign_execution_rehearsal_rows (rehearsal_id, position, state, reason_code)
                 VALUES (?, ?, ?, ?)`,
                [rehearsalId, row.position, row.state, row.reason_code],
                (error) => error ? reject(error) : resolve(),
            ));
        }
        const rehearsal = await new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM call_e_campaign_execution_rehearsals WHERE rehearsal_id = ?',
            [rehearsalId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
        return { rehearsal, recipients, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async listCallECampaignExecutionRehearsalsForBusiness(businessId, limit = 20) {
        const scope = String(businessId || '').trim();
        const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(scope)) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT r.rehearsal_id, r.campaign_id, r.status, r.recipient_count, r.ready_count, r.blocked_count, r.created_at
             FROM call_e_campaign_execution_rehearsals r
             JOIN call_e_campaign_reviews c ON c.campaign_id = r.campaign_id
             WHERE r.business_id = ? AND c.status = 'approved'
             AND r.rehearsal_id = (
               SELECT latest.rehearsal_id FROM call_e_campaign_execution_rehearsals latest
               WHERE latest.campaign_id = r.campaign_id AND latest.business_id = r.business_id
               ORDER BY latest.created_at DESC, latest.rehearsal_id DESC LIMIT 1
             )
             ORDER BY r.created_at DESC LIMIT ?`,
            [scope, boundedLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async getCallEGoalRunRequestByIdempotency(businessId, idempotencyHash) {
        return new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM call_e_goal_run_requests WHERE business_id = ? AND idempotency_hash = ?',
            [businessId, idempotencyHash], (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async createCallEGoalRunRequest(input = {}) {
        const requestId = String(input.goal_run_request_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const idempotencyHash = String(input.idempotency_hash || '').trim();
        const status = String(input.status || '').trim();
        const expiresAt = String(input.sensitive_data_expires_at || new Date(Date.now() + 90 * 86400000).toISOString());
        if (!/^goalrun_[a-f0-9-]{36}$/i.test(requestId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[a-f0-9]{64}$/i.test(requestHash) || !/^[a-f0-9]{64}$/i.test(idempotencyHash) || status !== 'pending_approval' ||
            !String(input.encrypted_payload || '').trim() || !String(input.result_schema_json || '').trim() || !Number.isFinite(Date.parse(expiresAt))) {
            throw Object.assign(new Error('CALL-E Goal Run request is invalid'), { code: 'call_e_goal_run_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const existing = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_goal_run_requests WHERE business_id = ? AND idempotency_hash = ?',
                [businessId, idempotencyHash], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...existing, idempotentReplay: true };
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_goal_run_requests (
                    goal_run_request_id, business_id, goal_id, goal_title, published_run_spec_id,
                    published_run_spec_version, destination_masked, encrypted_payload, encryption_key_version,
                    request_hash, idempotency_hash, result_schema_json, status, created_by, sensitive_data_expires_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
                [requestId, businessId, input.goal_id, input.goal_title, input.published_run_spec_id,
                    input.published_run_spec_version, input.destination_masked, input.encrypted_payload,
                    input.encryption_key_version, requestHash, idempotencyHash, input.result_schema_json, input.created_by, expiresAt],
                (error) => error ? reject(error) : resolve(),
            ));
            const row = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_goal_run_requests WHERE goal_run_request_id = ?', [requestId],
                (error, result) => error ? reject(error) : resolve(result || null),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...row, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async getCallEGoalRunRequest(requestId, businessId) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT * FROM call_e_goal_run_requests WHERE goal_run_request_id = ? AND business_id = ?`,
            [requestId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async listCallEGoalRunRequests(businessId, options = {}) {
        const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
        const allowed = new Set(['pending_approval', 'approved', 'rejected', 'submitting', 'recovery_required', 'running', 'completed', 'failed', 'canceled', 'needs_review']);
        const status = allowed.has(String(options.status || '')) ? String(options.status) : null;
        return new Promise((resolve, reject) => this.db.all(
            `SELECT * FROM call_e_goal_run_requests WHERE business_id = ? AND (? IS NULL OR status = ?)
             ORDER BY created_at DESC, goal_run_request_id DESC LIMIT ?`,
            [businessId, status, status, limit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async reviewCallEGoalRunRequest(input = {}) {
        const requestId = String(input.goal_run_request_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const reviewer = String(input.reviewed_by || '').trim();
        const decision = String(input.decision || '').trim();
        if (!/^goalrun_[a-f0-9-]{36}$/i.test(requestId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(reviewer) || !['approve', 'reject'].includes(decision)) {
            throw Object.assign(new Error('CALL-E Goal Run review decision is invalid'), { code: 'call_e_goal_run_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const row = await new Promise((resolve, reject) => this.db.get(
                `SELECT * FROM call_e_goal_run_requests WHERE goal_run_request_id = ? AND business_id = ?`,
                [requestId, businessId], (error, result) => error ? reject(error) : resolve(result || null),
            ));
            if (!row || row.status !== 'pending_approval' || row.created_by === reviewer) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_goal_run_reviews (goal_run_request_id, business_id, reviewed_by, decision, request_hash)
                 VALUES (?, ?, ?, ?, ?)`, [requestId, businessId, reviewer, decision, row.request_hash],
                (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_goal_run_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE goal_run_request_id = ? AND status = 'pending_approval'`,
                [decision === 'approve' ? 'approved' : 'rejected', reviewer, requestId],
                (error) => error ? reject(error) : resolve(),
            ));
            const saved = await new Promise((resolve, reject) => this.db.get(
                `SELECT * FROM call_e_goal_run_requests WHERE goal_run_request_id = ? AND business_id = ?`,
                [requestId, businessId], (error, result) => error ? reject(error) : resolve(result || null),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return saved;
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async markCallEGoalRunSubmitting(requestId, businessId) {
        await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_goal_run_requests SET status = 'submitting', error_code = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE goal_run_request_id = ? AND business_id = ? AND provider_goal_run_id IS NULL
               AND status IN ('approved', 'submitting', 'recovery_required')`,
            [requestId, businessId], (error) => error ? reject(error) : resolve(),
        ));
        return this.getCallEGoalRunRequest(requestId, businessId);
    }

    async saveCallEGoalRunProviderState(input = {}) {
        const statuses = new Set(['submitting', 'recovery_required', 'running', 'completed', 'failed', 'canceled', 'needs_review']);
        const status = String(input.status || 'needs_review');
        const providerId = String(input.provider_goal_run_id || '').trim() || null;
        if (!statuses.has(status) || (providerId && (providerId.length > 255 || /[\u0000-\u001f\u007f]/.test(providerId)))) {
            throw Object.assign(new Error('CALL-E Goal Run provider state is invalid'), { code: 'call_e_goal_run_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_goal_run_requests SET status = ?, provider_goal_run_id = COALESCE(?, provider_goal_run_id),
                execution_status = ?, call_outcome = ?, result_status = ?, error_code = ?,
                encrypted_result = COALESCE(?, encrypted_result), updated_at = CURRENT_TIMESTAMP
             WHERE goal_run_request_id = ? AND business_id = ?`,
            [status, providerId, input.execution_status || null, input.call_outcome || null, input.result_status || null,
                input.error_code || null, input.encrypted_result || null, input.goal_run_request_id, input.business_id],
            (error) => error ? reject(error) : resolve(),
        ));
        return this.getCallEGoalRunRequest(input.goal_run_request_id, input.business_id);
    }

    async getCallEGoalRunReview(requestId, businessId) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT reviewed_by, decision, request_hash, created_at FROM call_e_goal_run_reviews
             WHERE goal_run_request_id = ? AND business_id = ?`,
            [requestId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async createCallECampaignMission(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const campaignId = String(input.campaign_id || '').trim();
        const templateId = Number(input.template_id);
        const templateVersion = Number(input.template_version);
        const resultSchemaJson = String(input.result_schema_json || '');
        const createdBy = String(input.created_by || '').trim();
        const requestHash = String(input.request_hash || '').trim().toLowerCase();
        const encryptionKeyVersion = Number(input.encryption_key_version ?? 1);
        const sensitiveDataExpiresAt = String(input.sensitive_data_expires_at || new Date(Date.now() + 90 * 86400000).toISOString());
        const scheduledAt = input.scheduled_at == null ? null : String(input.scheduled_at);
        const budgetLimitMinor = input.budget_limit_minor == null ? null : Number(input.budget_limit_minor);
        const perCallCostCeilingMinor = input.per_call_cost_ceiling_minor == null ? null : Number(input.per_call_cost_ceiling_minor);
        const budgetCurrency = input.budget_currency == null ? null : String(input.budget_currency).trim().toUpperCase();
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^campaign_[a-f0-9]{64}$/.test(campaignId) || !Number.isSafeInteger(templateId) || templateId < 1 ||
            !Number.isSafeInteger(templateVersion) || templateVersion < 1 || !resultSchemaJson ||
            Buffer.byteLength(resultSchemaJson, 'utf8') > 16000 || !/^\d{1,20}$/.test(createdBy) ||
            !/^[a-f0-9]{64}$/.test(requestHash) || !Number.isSafeInteger(encryptionKeyVersion) || encryptionKeyVersion < 1 || !Number.isFinite(Date.parse(sensitiveDataExpiresAt)) ||
            (scheduledAt !== null && (!Number.isFinite(Date.parse(scheduledAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt))) ||
            ((budgetLimitMinor === null) !== (perCallCostCeilingMinor === null)) ||
            ((budgetLimitMinor === null) !== (budgetCurrency === null)) || (budgetCurrency !== null && !/^[A-Z]{3}$/.test(budgetCurrency)) ||
            (budgetLimitMinor !== null && (!Number.isSafeInteger(budgetLimitMinor) || budgetLimitMinor < 1 || budgetLimitMinor > 1000000000 ||
                !Number.isSafeInteger(perCallCostCeilingMinor) || perCallCostCeilingMinor < 1 || perCallCostCeilingMinor > budgetLimitMinor)) ||
            recipients.length < 1 || recipients.length > 25) {
            throw Object.assign(new Error('CALL-E mission input is invalid'), { code: 'call_e_mission_invalid' });
        }
        let resultSchema;
        try { resultSchema = JSON.parse(resultSchemaJson); } catch (_) { resultSchema = null; }
        if (!resultSchema || typeof resultSchema !== 'object' || Array.isArray(resultSchema)) {
            throw Object.assign(new Error('CALL-E mission result schema is invalid'), { code: 'call_e_mission_invalid' });
        }
        const recipientIdempotencyKeys = new Set();
        for (const [index, recipient] of recipients.entries()) {
            const encryptedDestination = String(recipient?.encrypted_destination || '');
            const masked = String(recipient?.destination_masked || '');
            const idempotencyKey = String(recipient?.idempotency_key || '').trim();
            if (Number(recipient?.position) !== index || !encryptedDestination || encryptedDestination.length > 4096 ||
                /^\+[1-9]\d{7,14}$/.test(encryptedDestination) || !/^\+?[•]{4,14}\d{4}$/.test(masked) ||
                !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
                recipientIdempotencyKeys.has(idempotencyKey) ||
                (recipient.status !== undefined && recipient.status !== 'queued')) {
                throw Object.assign(new Error('CALL-E mission recipient is invalid'), { code: 'call_e_mission_invalid' });
            }
            recipientIdempotencyKeys.add(idempotencyKey);
        }

        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const existing = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_campaign_missions WHERE mission_id = ?',
                [missionId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing) {
                if (existing.business_id !== businessId || existing.request_hash !== requestHash || existing.created_by !== createdBy ||
                    existing.campaign_id !== campaignId || Number(existing.template_id) !== templateId ||
                    Number(existing.template_version) !== templateVersion || existing.result_schema_json !== resultSchemaJson ||
                    Number(existing.recipient_count) !== recipients.length || (existing.scheduled_at || null) !== scheduledAt ||
                    (existing.budget_limit_minor == null ? null : Number(existing.budget_limit_minor)) !== budgetLimitMinor ||
                    (existing.per_call_cost_ceiling_minor == null ? null : Number(existing.per_call_cost_ceiling_minor)) !== perCallCostCeilingMinor ||
                    (existing.budget_currency || null) !== budgetCurrency) {
                    throw Object.assign(new Error('Mission idempotency key conflicts with an existing request'), { code: 'call_e_mission_idempotency_conflict' });
                }
                const savedRecipients = await new Promise((resolve, reject) => this.db.all(
                    'SELECT mission_id, position, encrypted_destination, destination_masked, idempotency_key, status, local_call_id, error_code, updated_at FROM call_e_campaign_mission_recipients WHERE mission_id = ? ORDER BY position',
                    [missionId], (error, rows) => error ? reject(error) : resolve(rows || []),
                ));
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { mission: existing, recipients: savedRecipients, idempotentReplay: true };
            }
            const campaign = await new Promise((resolve, reject) => this.db.get(
                `SELECT campaign_id, business_id, template_id, template_version, status, ready_count, recipient_count
                 FROM call_e_campaign_reviews WHERE campaign_id = ? AND business_id = ?`,
                [campaignId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!campaign || campaign.status !== 'approved' || Number(campaign.ready_count) !== Number(campaign.recipient_count) ||
                Number(campaign.template_id) !== templateId || Number(campaign.template_version) !== templateVersion ||
                Number(campaign.recipient_count) !== recipients.length) {
                throw Object.assign(new Error('Mission requires the matching approved campaign and recipient set'), { code: 'call_e_mission_campaign_not_approved' });
            }
            const now = new Date().toISOString();
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_campaign_missions (
                    mission_id, business_id, campaign_id, template_id, template_version, result_schema_json, created_by,
                    request_hash, status, recipient_count, encryption_key_version, created_at, updated_at, sensitive_data_expires_at,
                    scheduled_at, budget_limit_minor, per_call_cost_ceiling_minor, budget_currency
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [missionId, businessId, campaignId, templateId, templateVersion, resultSchemaJson, createdBy, requestHash,
                    recipients.length, encryptionKeyVersion, now, now, sensitiveDataExpiresAt, scheduledAt, budgetLimitMinor, perCallCostCeilingMinor, budgetCurrency],
                (error) => error ? reject(error) : resolve(),
            ));
            for (const recipient of recipients) {
                await new Promise((resolve, reject) => this.db.run(
                    `INSERT INTO call_e_campaign_mission_recipients (
                        mission_id, position, encrypted_destination, destination_masked, idempotency_key, status
                    ) VALUES (?, ?, ?, ?, ?, 'queued')`,
                    [missionId, recipient.position, String(recipient.encrypted_destination), String(recipient.destination_masked), String(recipient.idempotency_key)],
                    (error) => error ? reject(error) : resolve(),
                ));
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                 VALUES (?, ?, ?, ?, 'mission_created', 'pending_approval')`,
                [businessId, missionId, `mission_created:${missionId}`, createdBy], (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async getCallECampaignMissionForBusiness(missionId, businessId) {
        const normalizedId = String(missionId || '').trim();
        const normalizedBusinessId = String(businessId || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(normalizedId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return null;
        const mission = await new Promise((resolve, reject) => this.db.get(
            'SELECT * FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
            [normalizedId, normalizedBusinessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (!mission) return null;
        const recipients = await new Promise((resolve, reject) => this.db.all(
            'SELECT mission_id, position, encrypted_destination, destination_masked, idempotency_key, status, local_call_id, error_code, updated_at FROM call_e_campaign_mission_recipients WHERE mission_id = ? ORDER BY position',
            [normalizedId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        const budgetReserved = await new Promise((resolve, reject) => this.db.get(
            `SELECT COALESCE(SUM(reserved_minor), 0) AS reserved_minor FROM call_e_mission_budget_reservations WHERE mission_id = ? AND status = 'reserved'`,
            [normalizedId], (error, row) => error ? reject(error) : resolve(Number(row?.reserved_minor) || 0),
        ));
        const resolutions = await new Promise((resolve, reject) => this.db.all(
            'SELECT resolved_by, decision, created_at FROM call_e_campaign_mission_resolutions WHERE mission_id = ? AND business_id = ? ORDER BY created_at, idempotency_key',
            [normalizedId, normalizedBusinessId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        const reviewHistory = await new Promise((resolve, reject) => this.db.all(
            `SELECT reviewed_by, decision, request_hash, created_at FROM call_e_approval_decisions
             WHERE entity_type = 'mission' AND entity_id = ? AND business_id = ?
             UNION ALL
             SELECT reviewed_by, decision, request_hash, created_at FROM call_e_mission_secondary_approvals
             WHERE mission_id = ? AND business_id = ? ORDER BY created_at`,
            [normalizedId, normalizedBusinessId, normalizedId, normalizedBusinessId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        const activity = await new Promise((resolve, reject) => this.db.all(
            `SELECT event_id, actor_id, event_type, recipient_position, state, error_code, created_at
             FROM call_e_mission_activity WHERE business_id = ? AND mission_id = ? ORDER BY event_id DESC LIMIT 200`,
            [normalizedBusinessId, normalizedId], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        return { mission: { ...mission, budget_reserved_minor: budgetReserved }, recipients, resolutions, reviewHistory, activity };
    }

    async getCallECampaignMission(missionId, businessId) {
        const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
        return saved ? { ...saved.mission, recipients: saved.recipients, reviewHistory: saved.reviewHistory, activity: saved.activity } : null;
    }

    async listCallECampaignMissionsForBusiness(businessId, limit = 20) {
        const normalizedBusinessId = String(businessId || '').trim();
        const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT m.mission_id, m.business_id, m.campaign_id, m.request_hash, m.status, m.recipient_count,
                    m.scheduled_at, m.budget_limit_minor, m.per_call_cost_ceiling_minor, m.budget_currency,
                    (SELECT COALESCE(SUM(b.reserved_minor), 0) FROM call_e_mission_budget_reservations b WHERE b.mission_id = m.mission_id AND b.status = 'reserved') AS budget_reserved_minor,
                    m.created_by, m.reviewed_by, m.created_at, m.updated_at,
                    SUM(CASE WHEN r.status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
                    SUM(CASE WHEN r.status IN ('in_progress', 'accepted') THEN 1 ELSE 0 END) AS active_count,
                    SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                    SUM(CASE WHEN r.status IN ('failed', 'blocked', 'needs_review', 'canceled') THEN 1 ELSE 0 END) AS attention_count
             FROM call_e_campaign_missions m
             JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
             WHERE m.business_id = ?
             GROUP BY m.mission_id
             ORDER BY m.created_at DESC, m.mission_id DESC LIMIT ?`,
            [normalizedBusinessId, boundedLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async listCallEMissionRecoveryInbox(businessId, limit = 50, staleBefore = new Date(Date.now() - 15 * 60000).toISOString()) {
        const normalizedBusinessId = String(businessId || '').trim();
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT m.mission_id, m.status AS mission_status, m.updated_at AS mission_updated_at,
                    r.position, r.status AS recipient_status, r.local_call_id, r.error_code, r.updated_at AS recipient_updated_at,
                    r.destination_masked
             FROM call_e_campaign_missions m JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
             WHERE m.business_id = ? AND (
               r.status IN ('needs_review', 'failed', 'blocked') OR
               (r.status IN ('accepted', 'in_progress') AND datetime(r.updated_at) <= datetime(?))
             )
             ORDER BY CASE WHEN r.status IN ('accepted', 'in_progress') THEN 0 ELSE 1 END,
                      r.updated_at ASC, m.mission_id, r.position LIMIT ?`,
            [normalizedBusinessId, staleBefore, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async listDueCallECampaignMissions(nowIso = new Date().toISOString(), limit = 25) {
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT mission_id, business_id, COALESCE(reviewed_by, created_by) AS actor_id, scheduled_at
             FROM call_e_campaign_missions
             WHERE status IN ('approved', 'running') AND scheduled_at IS NOT NULL AND scheduled_at <= ?
             ORDER BY scheduled_at, mission_id LIMIT ?`,
            [nowIso, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async listDueCallEMissionEscalations(nowIso = new Date().toISOString(), limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT m.mission_id, m.business_id, m.created_by, m.created_at, p.review_sla_minutes, p.review_repeat_minutes,
                    e.escalation_count, e.deadline_at, e.next_escalation_at
             FROM call_e_campaign_missions m
             JOIN call_e_business_mission_policies p ON p.business_id = m.business_id
             LEFT JOIN call_e_mission_escalations e ON e.mission_id = m.mission_id
             WHERE m.status = 'pending_approval' AND p.review_sla_minutes > 0
               AND (e.mission_id IS NULL OR e.next_escalation_at IS NOT NULL)
               AND datetime(COALESCE(e.next_escalation_at, datetime(m.created_at, '+' || p.review_sla_minutes || ' minutes'))) <= datetime(?)
             ORDER BY COALESCE(e.next_escalation_at, datetime(m.created_at, '+' || p.review_sla_minutes || ' minutes')), m.mission_id LIMIT ?`,
            [nowIso, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async recordCallEMissionEscalation(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) return false;
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        const run = (sql, params = []) => new Promise((resolve, reject) => this.db.run(sql, params, function (error) {
            if (error) return reject(error);
            resolve({ changes: this.changes || 0 });
        }));
        let transactionStarted = false;
        try {
            await run('BEGIN IMMEDIATE');
            transactionStarted = true;
            const mission = await new Promise((resolve, reject) => this.db.get(
                `SELECT m.created_at, p.review_sla_minutes, p.review_repeat_minutes FROM call_e_campaign_missions m
                 JOIN call_e_business_mission_policies p ON p.business_id = m.business_id
                 WHERE m.mission_id = ? AND m.business_id = ? AND m.status = 'pending_approval'`,
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission || Number(mission.review_sla_minutes) <= 0) {
                await run('COMMIT');
                transactionStarted = false;
                return false;
            }
            const prior = await new Promise((resolve, reject) => this.db.get(
                'SELECT escalation_count, deadline_at, next_escalation_at FROM call_e_mission_escalations WHERE mission_id = ? AND business_id = ?',
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (prior && !prior.next_escalation_at) {
                await run('COMMIT'); transactionStarted = false; return false;
            }
            if (prior && Date.parse(prior.next_escalation_at) > Date.parse(String(input.now_iso || new Date().toISOString()))) {
                await run('COMMIT'); transactionStarted = false; return false;
            }
            const count = Number(prior?.escalation_count || 0) + 1;
            const repeatMinutes = Number(mission.review_repeat_minutes) || 0;
            const missionCreatedAt = String(mission.created_at || '');
            const parsedCreatedAt = Date.parse(missionCreatedAt) || Date.parse(`${missionCreatedAt.replace(' ', 'T')}Z`);
            if (!prior && !Number.isFinite(parsedCreatedAt)) throw new Error('Mission creation timestamp is invalid');
            const deadline = prior?.deadline_at || new Date(parsedCreatedAt + Number(mission.review_sla_minutes) * 60000).toISOString();
            const cycleAt = Date.parse(String(input.now_iso || new Date().toISOString()));
            const nextEscalationAt = repeatMinutes > 0 && Number.isFinite(cycleAt) ? new Date(cycleAt + repeatMinutes * 60000).toISOString() : null;
            if (!prior) await run(`INSERT INTO call_e_mission_escalations (mission_id, business_id, deadline_at, next_escalation_at, escalation_count)
                VALUES (?, ?, ?, ?, 1)`, [missionId, businessId, deadline, nextEscalationAt]);
            else await run(`UPDATE call_e_mission_escalations SET next_escalation_at = ?, escalation_count = escalation_count + 1
                WHERE mission_id = ? AND business_id = ?`, [nextEscalationAt, missionId, businessId]);
            await run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, event_type, state)
                 VALUES (?, ?, ?, 'mission_advanced', 'review_escalated')`,
                [businessId, missionId, `review-escalated:${missionId}:${count}`],
            );
            if (prior) await run(`INSERT INTO call_e_mission_escalation_actions (business_id, mission_id, action, actor_id, idempotency_key)
                VALUES (?, ?, 'repeat_escalated', 'system', ?)`, [businessId, missionId, `repeat-escalation:${missionId}:${count}`]);
            await run('COMMIT');
            transactionStarted = false;
            return true;
        } catch (error) {
            if (transactionStarted) {
                try { await run('ROLLBACK'); } catch (_) { /* Preserve the original transaction failure. */ }
            }
            throw error;
        } finally {
            release();
        }
    }

    async recordCallEMissionEscalationAction(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const action = String(input.action || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const assignedTo = input.assigned_to == null ? null : String(input.assigned_to).trim();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        const deadlineAt = input.deadline_at == null ? null : String(input.deadline_at).trim();
        const requestHash = String(input.request_hash || '').trim().toLowerCase();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) ||
            !['reassigned', 'deadline_extended'].includes(action) || !/^\d{1,20}$/.test(actorId) ||
            (action === 'reassigned' && (!assignedTo || !/^\d{1,20}$/.test(assignedTo))) ||
            (action === 'deadline_extended' && (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(deadlineAt))) ||
            !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) || (requestHash && !/^[a-f0-9]{64}$/.test(requestHash))) {
            throw Object.assign(new Error('CALL-E escalation action is invalid'), { code: 'call_e_mission_escalation_action_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        const run = (sql, params = []) => new Promise((resolve, reject) => this.db.run(sql, params, function (error) {
            if (error) return reject(error); resolve({ changes: this.changes || 0 });
        }));
        const get = (sql, params = []) => new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
        let transactionStarted = false;
        try {
            await run('BEGIN IMMEDIATE'); transactionStarted = true;
            const prior = await get('SELECT business_id, mission_id, action, actor_id, assigned_to, deadline_at, request_hash FROM call_e_mission_escalation_actions WHERE idempotency_key = ?', [idempotencyKey]);
            if (prior) {
                const same = prior.business_id === businessId && prior.mission_id === missionId && prior.action === action &&
                    prior.actor_id === actorId && (prior.assigned_to || null) === assignedTo &&
                    (requestHash ? prior.request_hash === requestHash : (prior.deadline_at || null) === deadlineAt);
                await run('COMMIT'); transactionStarted = false;
                return { recorded: false, idempotent_replay: same, conflict: !same, deadline_at: prior.deadline_at || null };
            }
            const mission = await get(`SELECT status FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?`, [missionId, businessId]);
            if (!mission || mission.status !== 'pending_approval') {
                await run('COMMIT'); transactionStarted = false; return { not_pending: true };
            }
            const escalation = await get('SELECT deadline_at FROM call_e_mission_escalations WHERE mission_id = ? AND business_id = ?', [missionId, businessId]);
            if (!escalation) { await run('COMMIT'); transactionStarted = false; return { not_escalated: true }; }
            await run(`INSERT INTO call_e_mission_escalation_actions (business_id, mission_id, action, actor_id, assigned_to, deadline_at, request_hash, idempotency_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [businessId, missionId, action, actorId, assignedTo, deadlineAt, requestHash || null, idempotencyKey]);
            if (action === 'deadline_extended') {
                await run('UPDATE call_e_mission_escalations SET deadline_at = ?, next_escalation_at = ? WHERE mission_id = ? AND business_id = ?',
                    [deadlineAt, deadlineAt, missionId, businessId]);
            }
            if (action === 'reassigned') {
                await run(`INSERT INTO call_e_mission_review_actions (business_id, mission_id, action, actor_id, assigned_to, idempotency_key)
                    VALUES (?, ?, 'assigned', ?, ?, ?)`, [businessId, missionId, actorId, assignedTo, `escalation-assignment:${idempotencyKey}`]);
            }
            await run(`INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                VALUES (?, ?, ?, ?, 'mission_advanced', ?)`, [businessId, missionId, `escalation-action:${idempotencyKey}`, actorId, action]);
            await run('COMMIT'); transactionStarted = false;
            return { recorded: true, idempotent_replay: false, deadline_at: action === 'deadline_extended' ? deadlineAt : escalation.deadline_at };
        } catch (error) {
            if (transactionStarted) { try { await run('ROLLBACK'); } catch (_) { /* Preserve original error. */ } }
            throw error;
        } finally { release(); }
    }

    async listCallEMissionReviewInbox(businessId, limit = 50) {
        const normalizedBusinessId = String(businessId || '').trim();
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) return [];
        return new Promise((resolve, reject) => this.db.all(
            `SELECT m.mission_id, m.business_id, m.created_by, m.created_at, m.recipient_count,
                    e.escalated_at, e.deadline_at, e.escalation_count, latest.action AS latest_review_action,
                    latest.actor_id AS latest_review_actor, COALESCE(owner.assigned_to, latest.assigned_to) AS assigned_to,
                    latest.created_at AS review_action_at
             FROM call_e_campaign_missions m
             LEFT JOIN call_e_mission_escalations e ON e.mission_id = m.mission_id
             LEFT JOIN call_e_mission_review_actions latest ON latest.action_id = (
                 SELECT MAX(a.action_id) FROM call_e_mission_review_actions a WHERE a.mission_id = m.mission_id AND a.business_id = m.business_id
             )
             LEFT JOIN call_e_mission_review_actions owner ON owner.action_id = (
                 SELECT MAX(a.action_id) FROM call_e_mission_review_actions a
                 WHERE a.mission_id = m.mission_id AND a.business_id = m.business_id AND a.action = 'assigned'
             )
             WHERE m.business_id = ? AND m.status = 'pending_approval'
             ORDER BY CASE WHEN e.mission_id IS NULL THEN 1 ELSE 0 END, e.escalated_at, m.created_at LIMIT ?`,
            [normalizedBusinessId, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async recordCallEMissionReviewAction(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const action = String(input.action || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const assignedTo = input.assigned_to == null ? null : String(input.assigned_to).trim();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) ||
            !['assigned', 'acknowledged'].includes(action) || !/^\d{1,20}$/.test(actorId) ||
            (assignedTo !== null && !/^\d{1,20}$/.test(assignedTo)) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
            (action === 'assigned' && !assignedTo) || (action === 'acknowledged' && assignedTo !== actorId)) {
            throw Object.assign(new Error('CALL-E mission review action is invalid'), { code: 'call_e_mission_review_action_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        const run = (sql, params = []) => new Promise((resolve, reject) => this.db.run(sql, params, function (error) {
            if (error) return reject(error);
            resolve({ changes: this.changes || 0 });
        }));
        const get = (sql, params = []) => new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
        let transactionStarted = false;
        try {
            await run('BEGIN IMMEDIATE');
            transactionStarted = true;
            const replay = await get('SELECT business_id, mission_id, action, actor_id, assigned_to FROM call_e_mission_review_actions WHERE idempotency_key = ?', [idempotencyKey]);
            if (replay) {
                const matches = replay.business_id === businessId && replay.mission_id === missionId && replay.action === action &&
                    replay.actor_id === actorId && (replay.assigned_to || null) === assignedTo;
                await run('COMMIT');
                transactionStarted = false;
                return { recorded: false, idempotent_replay: matches, conflict: !matches };
            }
            const mission = await get('SELECT status FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?', [missionId, businessId]);
            if (!mission || mission.status !== 'pending_approval') {
                await run('COMMIT');
                transactionStarted = false;
                return { recorded: false, not_pending: true };
            }
            if (action === 'acknowledged') {
                const latest = await get(`SELECT assigned_to FROM call_e_mission_review_actions
                    WHERE business_id = ? AND mission_id = ? AND action = 'assigned' ORDER BY action_id DESC LIMIT 1`, [businessId, missionId]);
                if (!latest || latest.assigned_to !== actorId) {
                    await run('COMMIT');
                    transactionStarted = false;
                    return { recorded: false, assignment_required: true };
                }
            }
            await run(`INSERT INTO call_e_mission_review_actions (business_id, mission_id, action, actor_id, assigned_to, idempotency_key)
                VALUES (?, ?, ?, ?, ?, ?)`, [businessId, missionId, action, actorId, assignedTo, idempotencyKey]);
            await run(`INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                VALUES (?, ?, ?, ?, 'mission_advanced', ?)`, [businessId, missionId, `review-action:${idempotencyKey}`, actorId,
                action === 'assigned' ? 'review_assigned' : 'review_acknowledged']);
            await run('COMMIT');
            transactionStarted = false;
            return { recorded: true, idempotent_replay: false, conflict: false };
        } catch (error) {
            if (transactionStarted) {
                try { await run('ROLLBACK'); } catch (_) { /* Preserve original transaction failure. */ }
            }
            throw error;
        } finally { release(); }
    }

    async reserveCallECampaignMissionBudget(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const position = Number(input.recipient_position);
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !Number.isSafeInteger(position) || position < 0) throw new Error('CALL-E mission budget reservation scope is invalid');
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const mission = await new Promise((resolve, reject) => this.db.get(
                'SELECT budget_limit_minor, per_call_cost_ceiling_minor FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission || mission.budget_limit_minor == null || mission.per_call_cost_ceiling_minor == null) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: 'budget_not_configured' };
            }
            const existing = await new Promise((resolve, reject) => this.db.get(
                `SELECT status FROM call_e_mission_budget_reservations WHERE mission_id = ? AND recipient_position = ?`,
                [missionId, position], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing?.status === 'reserved') {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: true, idempotent_replay: true };
            }
            const reserved = await new Promise((resolve, reject) => this.db.get(
                `SELECT COALESCE(SUM(reserved_minor), 0) AS reserved_minor FROM call_e_mission_budget_reservations
                 WHERE mission_id = ? AND status = 'reserved'`,
                [missionId], (error, row) => error ? reject(error) : resolve(Number(row?.reserved_minor) || 0),
            ));
            const amount = Number(mission.per_call_cost_ceiling_minor);
            if (reserved + amount > Number(mission.budget_limit_minor)) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: 'budget_exhausted', reserved_minor: reserved };
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_mission_budget_reservations (mission_id, recipient_position, reserved_minor, status, created_at, released_at)
                 VALUES (?, ?, ?, 'reserved', CURRENT_TIMESTAMP, NULL)
                 ON CONFLICT(mission_id, recipient_position) DO UPDATE SET reserved_minor = excluded.reserved_minor,
                   status = 'reserved', created_at = CURRENT_TIMESTAMP, released_at = NULL`,
                [missionId, position, amount], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { allowed: true, reserved_minor: reserved + amount, budget_limit_minor: Number(mission.budget_limit_minor) };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async updateCallECampaignMissionBudgetReservation(input = {}) {
        const status = input.status === 'released' ? 'released' : 'reserved';
        await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_budget_reservations SET status = ?, released_at = CASE WHEN ? = 'released' THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE mission_id = ? AND recipient_position = ?`,
            [status, status, String(input.mission_id || ''), Number(input.recipient_position)], (error) => error ? reject(error) : resolve(),
        ));
    }

    async recordCallEMissionUsageRecord(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const position = Number(input.recipient_position);
        const provider = String(input.provider || '').trim().toLowerCase();
        const providerCallId = String(input.provider_call_id || '').trim();
        const amountMinor = Number(input.amount_minor);
        const currency = String(input.currency || '').trim().toUpperCase();
        const duration = input.billed_duration_seconds == null ? null : Number(input.billed_duration_seconds);
        const sourceType = String(input.source_type || '').trim();
        const sourceReference = String(input.source_reference || '').trim();
        const recordedBy = String(input.recorded_by || '').trim();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        const requestHash = String(input.request_hash || '').trim().toLowerCase();
        const occurredAt = String(input.occurred_at || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) ||
            !Number.isSafeInteger(position) || position < 0 || position > 24 || !['twilio', 'plivo', 'vonage', 'other'].includes(provider) ||
            !/^[A-Za-z0-9._:-]{1,180}$/.test(providerCallId) || !Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > 1000000000000 ||
            !/^[A-Z]{3}$/.test(currency) || (duration !== null && (!Number.isSafeInteger(duration) || duration < 0 || duration > 86400)) ||
            !['provider_cdr', 'invoice', 'operator_estimate'].includes(sourceType) || !/^[A-Za-z0-9._:-]{8,180}$/.test(sourceReference) ||
            !/^\d{1,20}$/.test(recordedBy) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) || !/^[a-f0-9]{64}$/.test(requestHash) ||
            !Number.isFinite(Date.parse(occurredAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)) {
            throw Object.assign(new Error('CALL-E mission usage record is invalid'), { code: 'call_e_mission_usage_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        const run = (sql, params = []) => new Promise((resolve, reject) => this.db.run(sql, params, function (error) {
            if (error) return reject(error);
            resolve({ changes: this.changes || 0 });
        }));
        const get = (sql, params = []) => new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
        let transactionStarted = false;
        try {
            await run('BEGIN IMMEDIATE');
            transactionStarted = true;
            const prior = await get('SELECT request_hash FROM call_e_mission_usage_records WHERE business_id = ? AND idempotency_key = ?', [businessId, idempotencyKey]);
            if (prior) {
                await run('COMMIT');
                transactionStarted = false;
                return { recorded: false, idempotent_replay: prior.request_hash === requestHash, conflict: prior.request_hash !== requestHash };
            }
            const mission = await get(`SELECT budget_limit_minor, budget_currency FROM call_e_campaign_missions
                WHERE mission_id = ? AND business_id = ?`, [missionId, businessId]);
            if (!mission) {
                await run('COMMIT'); transactionStarted = false;
                return { recorded: false, not_found: true };
            }
            await run(`INSERT INTO call_e_mission_usage_records (
                business_id, mission_id, recipient_position, provider, provider_call_id, amount_minor, currency,
                billed_duration_seconds, source_type, source_reference, recorded_by, idempotency_key, request_hash, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                businessId, missionId, position, provider, providerCallId, amountMinor, currency, duration,
                sourceType, sourceReference, recordedBy, idempotencyKey, requestHash, new Date(Date.parse(occurredAt)).toISOString(),
            ]);
            const totals = await get(`SELECT COALESCE(SUM(amount_minor), 0) AS actual_minor, COUNT(*) AS record_count
                FROM call_e_mission_usage_records WHERE business_id = ? AND mission_id = ? AND currency = ?`, [businessId, missionId, currency]);
            const exceedsBudget = mission.budget_currency === currency && mission.budget_limit_minor != null &&
                Number(totals?.actual_minor) > Number(mission.budget_limit_minor);
            if (exceedsBudget) {
                await run(`INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                    VALUES (?, ?, ?, ?, 'mission_advanced', 'budget_exceeded')`, [businessId, missionId,
                    `usage-budget-exceeded:${missionId}:${currency}`, recordedBy]);
            }
            await run('COMMIT'); transactionStarted = false;
            return { recorded: true, idempotent_replay: false, currency, actual_minor: Number(totals?.actual_minor) || 0,
                record_count: Number(totals?.record_count) || 0, budget_limit_minor: mission.budget_currency === currency ? Number(mission.budget_limit_minor) || null : null,
                budget_exceeded: exceedsBudget, budget_currency: mission.budget_currency || null };
        } catch (error) {
            if (transactionStarted) { try { await run('ROLLBACK'); } catch (_) { /* Preserve original transaction failure. */ } }
            if (String(error?.message || '').includes('UNIQUE constraint failed: call_e_mission_usage_records.business_id, call_e_mission_usage_records.provider, call_e_mission_usage_records.provider_call_id')) {
                return { recorded: false, conflict: true };
            }
            throw error;
        } finally { release(); }
    }

    async getCallEMissionUsageReport(businessId, missionId) {
        const normalizedBusinessId = String(businessId || '').trim();
        const normalizedMissionId = String(missionId || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId) || !/^mission_[a-f0-9]{64}$/.test(normalizedMissionId)) return null;
        const mission = await new Promise((resolve, reject) => this.db.get(
            `SELECT budget_limit_minor, per_call_cost_ceiling_minor, budget_currency FROM call_e_campaign_missions
             WHERE business_id = ? AND mission_id = ?`, [normalizedBusinessId, normalizedMissionId],
            (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (!mission) return null;
        const [reservations, totalsRows, usage] = await Promise.all([
            new Promise((resolve, reject) => this.db.get(`SELECT COALESCE(SUM(reserved_minor), 0) AS reserved_minor
                FROM call_e_mission_budget_reservations WHERE mission_id = ? AND status = 'reserved'`, [normalizedMissionId],
            (error, row) => error ? reject(error) : resolve(Number(row?.reserved_minor) || 0))),
            new Promise((resolve, reject) => this.db.all(`SELECT currency, COALESCE(SUM(amount_minor), 0) AS amount_minor
                FROM call_e_mission_usage_records WHERE business_id = ? AND mission_id = ? GROUP BY currency`,
            [normalizedBusinessId, normalizedMissionId], (error, rows) => error ? reject(error) : resolve(rows || []))),
            new Promise((resolve, reject) => this.db.all(`SELECT provider, amount_minor, currency, billed_duration_seconds, source_type, occurred_at
                FROM call_e_mission_usage_records WHERE business_id = ? AND mission_id = ? ORDER BY usage_id DESC LIMIT 100`,
            [normalizedBusinessId, normalizedMissionId], (error, rows) => error ? reject(error) : resolve(rows || []))),
        ]);
        const totals = {};
        for (const row of totalsRows) totals[row.currency] = Number(row.amount_minor) || 0;
        return { budget_limit_minor: mission.budget_limit_minor == null ? null : Number(mission.budget_limit_minor),
            per_call_cost_ceiling_minor: mission.per_call_cost_ceiling_minor == null ? null : Number(mission.per_call_cost_ceiling_minor),
            budget_currency: mission.budget_currency || null, reserved_minor: reservations, actual_by_currency: totals,
            budget_exceeded: Boolean(mission.budget_currency && mission.budget_limit_minor != null &&
                (totals[mission.budget_currency] || 0) > Number(mission.budget_limit_minor)),
            records: usage.map((row) => ({ provider: row.provider, amount_minor: Number(row.amount_minor), currency: row.currency,
                billed_duration_seconds: row.billed_duration_seconds == null ? null : Number(row.billed_duration_seconds),
                source_type: row.source_type, occurred_at: row.occurred_at })) };
    }

    async stageCallEMissionCdrImport(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const actorId = String(input.created_by || '').trim();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        const requestHash = String(input.request_hash || '').trim().toLowerCase();
        const records = Array.isArray(input.records) ? input.records : [];
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) ||
            !/^\d{1,20}$/.test(actorId) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
            !/^[a-f0-9]{64}$/.test(requestHash) || records.length < 1 || records.length > 100) {
            throw Object.assign(new Error('CALL-E CDR import is invalid'), { code: 'call_e_cdr_import_invalid' });
        }
        const mission = await new Promise((resolve, reject) => this.db.get(
            'SELECT budget_limit_minor, budget_currency FROM call_e_campaign_missions WHERE business_id = ? AND mission_id = ?',
            [businessId, missionId], (error, row) => error ? reject(error) : resolve(row || null)));
        if (!mission) return { not_found: true };
        const existingImport = await new Promise((resolve, reject) => this.db.get(
            'SELECT import_id, request_hash FROM call_e_mission_cdr_imports WHERE business_id = ? AND idempotency_key = ?',
            [businessId, idempotencyKey], (error, row) => error ? reject(error) : resolve(row || null)));
        if (existingImport) {
            if (existingImport.request_hash !== requestHash) return { conflict: true };
            return { ...(await this.getCallEMissionCdrImport(businessId, existingImport.import_id)), idempotent_replay: true };
        }
        const normalizedRecords = records.map((record) => ({ ...record }));
        const seen = new Set();
        const previewRecords = [];
        const newTotals = {};
        for (const record of normalizedRecords) {
            const key = `${record.provider}:${record.provider_call_id}`;
            const intraBatchDuplicate = seen.has(key);
            seen.add(key);
            const existing = await new Promise((resolve, reject) => this.db.get(
                'SELECT usage_id FROM call_e_mission_usage_records WHERE business_id = ? AND provider = ? AND provider_call_id = ?',
                [businessId, record.provider, record.provider_call_id], (error, row) => error ? reject(error) : resolve(row || null)));
            const duplicate = Boolean(intraBatchDuplicate || existing);
            previewRecords.push({ recipient_position: Number(record.recipient_position), provider: record.provider,
                duplicate, duplicate_reason: intraBatchDuplicate ? 'duplicate_in_import' : existing ? 'already_imported' : null,
                amount_minor: Number(record.amount_minor), currency: record.currency });
            if (!duplicate) newTotals[record.currency] = (newTotals[record.currency] || 0) + Number(record.amount_minor);
        }
        const report = await this.getCallEMissionUsageReport(businessId, missionId);
        const projectedByCurrency = { ...(report?.actual_by_currency || {}) };
        for (const [currency, amount] of Object.entries(newTotals)) projectedByCurrency[currency] = (projectedByCurrency[currency] || 0) + amount;
        const preview = { record_count: normalizedRecords.length, duplicate_count: previewRecords.filter((row) => row.duplicate).length,
            new_record_count: previewRecords.filter((row) => !row.duplicate).length, new_totals_by_currency: newTotals,
            projected_actual_by_currency: projectedByCurrency,
            budget_exceeded: Boolean(mission.budget_currency && mission.budget_limit_minor != null &&
                Number(projectedByCurrency[mission.budget_currency] || 0) > Number(mission.budget_limit_minor)),
            records: previewRecords };
        const importId = `cdrimp_${crypto.randomUUID()}`;
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_mission_cdr_imports (import_id, business_id, mission_id, created_by, idempotency_key, request_hash, records_json, preview_json, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged')`,
            [importId, businessId, missionId, actorId, idempotencyKey, requestHash, JSON.stringify(normalizedRecords), JSON.stringify(preview)],
            (error) => error ? reject(error) : resolve()));
        return { import_id: importId, status: 'staged', preview, idempotent_replay: false };
    }

    async getCallEMissionCdrImport(businessId, importId) {
        const row = await new Promise((resolve, reject) => this.db.get(
            `SELECT import_id, business_id, mission_id, created_by, status, records_json, preview_json, created_at, committed_at
             FROM call_e_mission_cdr_imports WHERE business_id = ? AND import_id = ?`,
            [String(businessId || ''), String(importId || '')], (error, result) => error ? reject(error) : resolve(result || null)));
        if (!row) return null;
        let records = []; let preview = {};
        try { records = JSON.parse(row.records_json || '[]'); } catch (_) {}
        try { preview = JSON.parse(row.preview_json || '{}'); } catch (_) {}
        return { import_id: row.import_id, business_id: row.business_id, mission_id: row.mission_id,
            created_by: row.created_by, status: row.status, records, preview, created_at: row.created_at, committed_at: row.committed_at };
    }

    async markCallEMissionCdrImportCommitted(businessId, importId, actorId) {
        const result = await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_cdr_imports SET status = 'committed', committed_at = COALESCE(committed_at, CURRENT_TIMESTAMP)
             WHERE business_id = ? AND import_id = ? AND created_by = ?`,
            [String(businessId || ''), String(importId || ''), String(actorId || '')],
            function (error) { error ? reject(error) : resolve(this.changes || 0); }));
        return result;
    }

    async reserveCallEContactCooldown(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const destinationHash = String(input.destination_hash || '').toLowerCase();
        const missionId = String(input.mission_id || '').trim();
        const position = Number(input.recipient_position);
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^[a-f0-9]{64}$/.test(destinationHash) ||
            !/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0) {
            throw new Error('CALL-E contact cooldown reservation scope is invalid');
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const policy = await new Promise((resolve, reject) => this.db.get(
                'SELECT contact_cooldown_hours FROM call_e_business_safety_policies WHERE business_id = ?',
                [businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            const prior = await new Promise((resolve, reject) => this.db.get(
                `SELECT status FROM call_e_contact_dispatch_history WHERE mission_id = ? AND recipient_position = ?`,
                [missionId, position], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (prior && prior.status !== 'released') {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: true, idempotent_replay: true };
            }
            const cooldownHours = Number(policy?.contact_cooldown_hours) || 0;
            if (cooldownHours > 0) {
                const recent = await new Promise((resolve, reject) => this.db.get(
                    `SELECT 1 AS found FROM call_e_contact_dispatch_history
                     WHERE business_id = ? AND destination_hash = ? AND status IN ('reserved', 'accepted')
                       AND NOT (mission_id = ? AND recipient_position = ?)
                       AND datetime(attempted_at) >= datetime('now', '-' || ? || ' hours') LIMIT 1`,
                    [businessId, destinationHash, missionId, position, cooldownHours], (error, row) => error ? reject(error) : resolve(Boolean(row)),
                ));
                if (recent) {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { allowed: false, reason: 'cooldown_active' };
                }
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_contact_dispatch_history (business_id, destination_hash, mission_id, recipient_position, status, attempted_at)
                 VALUES (?, ?, ?, ?, 'reserved', CURRENT_TIMESTAMP)
                 ON CONFLICT(mission_id, recipient_position) DO UPDATE SET business_id = excluded.business_id,
                   destination_hash = excluded.destination_hash, status = 'reserved', attempted_at = CURRENT_TIMESTAMP`,
                [businessId, destinationHash, missionId, position], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { allowed: true, cooldown_hours: cooldownHours };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async updateCallEContactCooldownReservation(input = {}) {
        const status = ['accepted', 'released'].includes(input.status) ? input.status : 'reserved';
        await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_contact_dispatch_history SET status = ? WHERE mission_id = ? AND recipient_position = ?`,
            [status, String(input.mission_id || ''), Number(input.recipient_position)], (error) => error ? reject(error) : resolve(),
        ));
    }

    async reserveOutboundContactDispatch(input = {}) {
        const reservationKey = String(input.reservation_key || '').trim();
        const businessId = String(input.business_id || '').trim();
        const destinationHash = String(input.destination_hash || '').toLowerCase();
        const provider = String(input.provider || '').trim().toLowerCase();
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(reservationKey) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[a-f0-9]{64}$/.test(destinationHash) || !['twilio', 'plivo', 'vonage', 'vapi', 'call_e', 'cartesia'].includes(provider)) {
            throw Object.assign(new Error('Outbound contact dispatch reservation is invalid'), { code: 'outbound_contact_policy_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const policy = await new Promise((resolve, reject) => this.db.get(
                'SELECT contact_cooldown_hours FROM call_e_business_safety_policies WHERE business_id = ?',
                [businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!policy) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: 'safety_policy_required' };
            }
            const prior = await new Promise((resolve, reject) => this.db.get(
                'SELECT business_id, destination_hash, status FROM outbound_contact_dispatch_history WHERE reservation_key = ?',
                [reservationKey], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (prior) {
                const sameRequest = prior.business_id === businessId && prior.destination_hash === destinationHash;
                if (!sameRequest) {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { allowed: false, reason: 'idempotency_conflict' };
                }
                if (prior.status !== 'released') {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { allowed: true, idempotent_replay: true };
                }
            }
            const cooldownHours = Number(policy.contact_cooldown_hours) || 0;
            if (cooldownHours > 0) {
                const recent = await new Promise((resolve, reject) => this.db.get(
                    `SELECT 1 AS found FROM (
                        SELECT business_id, destination_hash, status, attempted_at FROM call_e_contact_dispatch_history
                        UNION ALL
                        SELECT business_id, destination_hash, status, attempted_at FROM outbound_contact_dispatch_history
                     )
                     WHERE business_id = ? AND destination_hash = ? AND status IN ('reserved', 'accepted')
                       AND datetime(attempted_at) >= datetime('now', '-' || ? || ' hours') LIMIT 1`,
                    [businessId, destinationHash, cooldownHours], (error, row) => error ? reject(error) : resolve(Boolean(row)),
                ));
                if (recent) {
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { allowed: false, reason: 'cooldown_active' };
                }
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO outbound_contact_dispatch_history (reservation_key, business_id, destination_hash, provider, status, attempted_at, updated_at)
                 VALUES (?, ?, ?, ?, 'reserved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT(reservation_key) DO UPDATE SET provider = excluded.provider, status = 'reserved',
                   attempted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
                [reservationKey, businessId, destinationHash, provider], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { allowed: true, idempotent_replay: false, cooldown_hours: cooldownHours };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async updateOutboundContactDispatch(input = {}) {
        const reservationKey = String(input.reservation_key || '').trim();
        const status = String(input.status || '').trim().toLowerCase();
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(reservationKey) || !['accepted', 'released'].includes(status)) return false;
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE outbound_contact_dispatch_history SET status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE reservation_key = ? AND status = 'reserved'`,
            [status, reservationKey], function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
    }

    async reviewCallECampaignMission(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const reviewer = String(input.reviewed_by || '').trim();
        const decision = String(input.decision || '').trim().toLowerCase();
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(reviewer) || !['approve', 'reject'].includes(decision)) {
            throw Object.assign(new Error('CALL-E mission review decision is invalid'), { code: 'call_e_mission_invalid' });
        }
        const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const mission = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            const savedDecision = await new Promise((resolve, reject) => this.db.get(
                `SELECT reviewed_by, decision, request_hash FROM call_e_approval_decisions
                 WHERE entity_type = 'mission' AND entity_id = ? AND business_id = ?`,
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            const policy = await new Promise((resolve, reject) => this.db.get(
                'SELECT secondary_approval_threshold FROM call_e_business_mission_policies WHERE business_id = ?',
                [businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            const needsSecondary = Number(mission.recipient_count) >= Number(policy?.secondary_approval_threshold || 26);
            const secondaryDecision = needsSecondary ? await new Promise((resolve, reject) => this.db.get(
                'SELECT reviewed_by, decision, request_hash FROM call_e_mission_secondary_approvals WHERE mission_id = ? AND business_id = ?',
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            )) : null;
            if (savedDecision) {
                if (!needsSecondary && savedDecision.decision === 'approve' && mission.status === 'pending_approval' && savedDecision.reviewed_by === reviewer) {
                    await new Promise((resolve, reject) => this.db.run(
                        `UPDATE call_e_campaign_missions SET status = 'approved', updated_at = CURRENT_TIMESTAMP
                         WHERE mission_id = ? AND business_id = ? AND status = 'pending_approval'`,
                        [missionId, businessId], (error) => error ? reject(error) : resolve(),
                    ));
                    await new Promise((resolve, reject) => this.db.run(
                        `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                         VALUES (?, ?, ?, ?, 'approval_recorded', 'approved')`,
                        [businessId, missionId, `approval-policy-finalize:${missionId}`, reviewer], (error) => error ? reject(error) : resolve(),
                    ));
                    const finalized = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { ...finalized, idempotentReplay: false, awaitingSecondaryApproval: false };
                }
                if (needsSecondary && savedDecision.decision === 'approve' && !secondaryDecision) {
                    if (savedDecision.request_hash !== mission.request_hash) {
                        throw Object.assign(new Error('Mission approval fingerprint changed'), { code: 'call_e_mission_review_final' });
                    }
                    if (savedDecision.reviewed_by === reviewer) {
                        const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                        await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                        return { ...replay, idempotentReplay: true, awaitingSecondaryApproval: true };
                    }
                    if (decision !== 'approve' || String(mission.created_by) === reviewer) {
                        throw Object.assign(new Error('A separate policy manager must provide the second approval'), { code: 'call_e_mission_second_approval_required' });
                    }
                    await new Promise((resolve, reject) => this.db.run(
                        `INSERT INTO call_e_mission_secondary_approvals (mission_id, business_id, reviewed_by, decision, request_hash)
                         VALUES (?, ?, ?, 'approve', ?)`,
                        [missionId, businessId, reviewer, mission.request_hash], (error) => error ? reject(error) : resolve(),
                    ));
                    await new Promise((resolve, reject) => this.db.run(
                        `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                         VALUES (?, ?, ?, ?, 'approval_recorded', 'approved')`,
                        [businessId, missionId, `approval-secondary:${missionId}:${reviewer}`, reviewer], (error) => error ? reject(error) : resolve(),
                    ));
                    await new Promise((resolve, reject) => this.db.run(
                        `UPDATE call_e_campaign_missions SET status = 'approved', updated_at = CURRENT_TIMESTAMP
                         WHERE mission_id = ? AND business_id = ? AND status = 'pending_approval'`,
                        [missionId, businessId], (error) => error ? reject(error) : resolve(),
                    ));
                    const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { ...replay, idempotentReplay: false, awaitingSecondaryApproval: false };
                }
                if (secondaryDecision && secondaryDecision.reviewed_by === reviewer && secondaryDecision.decision === decision && savedDecision.decision === 'approve') {
                    const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { ...replay, idempotentReplay: true, awaitingSecondaryApproval: false };
                }
                if (savedDecision.reviewed_by !== reviewer || savedDecision.decision !== decision || savedDecision.request_hash !== mission.request_hash) {
                    throw Object.assign(new Error('Mission approval is already final'), { code: 'call_e_mission_review_final' });
                }
                const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...replay, idempotentReplay: true };
            }
            if (mission.status !== 'pending_approval') {
                const priorDecision = mission.status === 'rejected' ? 'reject' : 'approve';
                if (mission.reviewed_by === reviewer && priorDecision === decision) {
                    await new Promise((resolve, reject) => this.db.run(
                        `INSERT OR IGNORE INTO call_e_approval_decisions
                         (entity_type, entity_id, business_id, reviewed_by, decision, request_hash, created_at)
                         VALUES ('mission', ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
                        [missionId, businessId, reviewer, decision, mission.request_hash, mission.reviewed_at],
                        (error) => error ? reject(error) : resolve(),
                    ));
                    const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                    await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                    return { ...replay, idempotentReplay: true };
                }
                throw Object.assign(new Error('Mission approval is already final'), { code: 'call_e_mission_review_final' });
            }
            if (String(mission.created_by) === reviewer) {
                throw Object.assign(new Error('A different operator must review this mission'), { code: 'call_e_mission_four_eyes_required' });
            }
            const initialStatus = decision === 'approve' && needsSecondary ? 'pending_approval' : nextStatus;
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_missions SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND business_id = ? AND status = 'pending_approval'`,
                [initialStatus, reviewer, missionId, businessId], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_approval_decisions
                 (entity_type, entity_id, business_id, reviewed_by, decision, request_hash)
                 VALUES ('mission', ?, ?, ?, ?, ?)`,
                [missionId, businessId, reviewer, decision, mission.request_hash],
                (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                 VALUES (?, ?, ?, ?, 'approval_recorded', ?)`,
                [businessId, missionId, `approval-primary:${missionId}:${reviewer}`, reviewer, initialStatus], (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false, awaitingSecondaryApproval: initialStatus === 'pending_approval' && decision === 'approve' && needsSecondary };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async resolveCallECampaignMission(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const reviewer = String(input.resolved_by || '').trim();
        const decision = String(input.decision || '').trim().toLowerCase();
        const idempotencyKey = String(input.idempotency_key || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(reviewer) || !['continue', 'cancel'].includes(decision) ||
            !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
            throw Object.assign(new Error('CALL-E mission resolution is invalid'), { code: 'call_e_mission_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const mission = await new Promise((resolve, reject) => this.db.get(
                'SELECT * FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            const replay = await new Promise((resolve, reject) => this.db.get(
                `SELECT decision, resolved_by FROM call_e_campaign_mission_resolutions
                 WHERE mission_id = ? AND business_id = ? AND idempotency_key = ?`,
                [missionId, businessId, idempotencyKey], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (replay) {
                if (replay.decision !== decision || replay.resolved_by !== reviewer) {
                    throw Object.assign(new Error('Mission resolution key conflicts with an existing decision'), { code: 'call_e_mission_idempotency_conflict' });
                }
                const savedReplay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...savedReplay, idempotentReplay: true };
            }
            if (mission.status !== 'needs_review' || String(mission.created_by) === reviewer ||
                (mission.reviewed_by && String(mission.reviewed_by) === reviewer)) {
                throw Object.assign(new Error('A different policy manager must resolve a paused mission'), { code: 'call_e_mission_four_eyes_required' });
            }
            const active = await new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS count FROM call_e_campaign_mission_recipients
                 WHERE mission_id = ? AND status IN ('in_progress', 'accepted')`,
                [missionId], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
            ));
            if (active > 0) throw Object.assign(new Error('An active CALL-E recipient must be reconciled before mission resolution'), { code: 'call_e_mission_active_recipient' });
            const queued = await new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS count FROM call_e_campaign_mission_recipients WHERE mission_id = ? AND status = 'queued'`,
                [missionId], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
            ));
            if (decision === 'continue' && queued === 0) {
                throw Object.assign(new Error('No queued recipients remain to continue'), { code: 'call_e_mission_no_queued_recipients' });
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_campaign_mission_resolutions
                 (mission_id, idempotency_key, business_id, resolved_by, decision)
                 VALUES (?, ?, ?, ?, ?)`,
                [missionId, idempotencyKey, businessId, reviewer, decision], (error) => error ? reject(error) : resolve(),
            ));
            const nextStatus = decision === 'continue' ? 'running' : 'canceled';
            if (decision === 'cancel') {
                await new Promise((resolve, reject) => this.db.run(
                    `UPDATE call_e_campaign_mission_recipients SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
                     WHERE mission_id = ? AND status = 'queued'`,
                    [missionId], (error) => error ? reject(error) : resolve(),
                ));
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_missions SET status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND business_id = ? AND status = 'needs_review'`,
                [nextStatus, missionId, businessId], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, state)
                 VALUES (?, ?, ?, ?, 'mission_resolved', ?)`,
                [businessId, missionId, `resolution:${missionId}:${idempotencyKey}`, reviewer, nextStatus], (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async validateCallECampaignMissionRecipientDispatch(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const requestHash = String(input.request_hash || '').trim();
        const position = Number(input.position);
        const idempotencyKey = String(input.idempotency_key || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[a-f0-9]{64}$/.test(requestHash) || !Number.isSafeInteger(position) || position < 0 ||
            !/^voicednut:call-e:[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) return false;
        const row = await new Promise((resolve, reject) => this.db.get(
            `SELECT m.request_hash, m.status AS mission_status, r.status AS recipient_status, r.idempotency_key,
                    COALESCE(p.emergency_stop, 1) AS emergency_stop,
                    COALESCE(w.paused, 0) AS worker_paused,
                    COALESCE(d.status, '') AS reservation_status
             FROM call_e_campaign_missions m JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
             LEFT JOIN call_e_business_safety_policies p ON p.business_id = m.business_id
             LEFT JOIN call_e_mission_worker_controls w ON w.mission_id = m.mission_id AND w.business_id = m.business_id
             LEFT JOIN call_e_business_dispatch_reservations d ON d.mission_id = r.mission_id AND d.recipient_position = r.position AND d.business_id = m.business_id
             WHERE m.mission_id = ? AND m.business_id = ? AND r.position = ?`,
            [missionId, businessId, position], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        if (!row || row.request_hash !== requestHash || !['approved', 'running'].includes(row.mission_status) ||
            row.recipient_status !== 'in_progress' || row.idempotency_key !== idempotencyKey || Number(row.emergency_stop) === 1 || row.reservation_status !== 'reserved' ||
            (input.worker_managed === true && Number(row.worker_paused) === 1)) return false;
        const otherActive = await new Promise((resolve, reject) => this.db.get(
            `SELECT 1 AS active FROM call_e_campaign_mission_recipients
             WHERE mission_id = ? AND status = 'accepted' LIMIT 1`,
            [missionId], (error, result) => error ? reject(error) : resolve(Boolean(result)),
        ));
        return !otherActive;
    }

    async acquireCallECampaignMissionWorkerLease(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const workerId = String(input.worker_id || '').trim();
        const leaseToken = String(input.lease_token || '').trim();
        const leaseMs = Math.max(1000, Math.min(300000, Number(input.lease_ms) || 60000));
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(workerId) || !/^[A-Za-z0-9_-]{16,128}$/.test(leaseToken)) {
            throw Object.assign(new Error('CALL-E mission worker lease input is invalid'), { code: 'call_e_mission_worker_lease_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const mission = await new Promise((resolve, reject) => this.db.get(
                `SELECT status FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?`,
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission || !['approved', 'running'].includes(String(mission.status))) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return false;
            }
            const existing = await new Promise((resolve, reject) => this.db.get(
                `SELECT lease_expires_at > CURRENT_TIMESTAMP AS active
                 FROM call_e_campaign_mission_worker_leases WHERE mission_id = ? AND business_id = ?`,
                [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (existing && Number(existing.active) === 1) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return false;
            }
            const modifier = `+${Math.ceil(leaseMs / 1000)} seconds`;
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_campaign_mission_worker_leases (
                    mission_id, business_id, lease_owner, lease_token, lease_expires_at,
                    last_state, last_error_code, updated_at
                 ) VALUES (?, ?, ?, ?, datetime('now', ?), 'leased', NULL, CURRENT_TIMESTAMP)
                 ON CONFLICT(mission_id) DO UPDATE SET
                    business_id = excluded.business_id,
                    lease_owner = excluded.lease_owner,
                    lease_token = excluded.lease_token,
                    lease_expires_at = excluded.lease_expires_at,
                    last_state = 'leased',
                    last_error_code = NULL,
                    updated_at = CURRENT_TIMESTAMP`,
                [missionId, businessId, workerId, leaseToken, modifier],
                (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return true;
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async releaseCallECampaignMissionWorkerLease(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const leaseToken = String(input.lease_token || '').trim();
        const stateValues = new Set(['call_accepted', 'waiting_for_call', 'waiting_for_result', 'recovery_required', 'needs_review', 'completed', 'canceled', 'error']);
        const state = stateValues.has(String(input.state || '').trim()) ? String(input.state).trim() : 'error';
        const rawErrorCode = String(input.error_code || '').trim().toLowerCase();
        const errorCode = /^[a-z][a-z0-9_]{0,79}$/.test(rawErrorCode) ? rawErrorCode : null;
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(String(input.worker_id || '').trim()) || !/^[A-Za-z0-9_-]{16,128}$/.test(leaseToken)) {
            throw Object.assign(new Error('CALL-E mission worker lease input is invalid'), { code: 'call_e_mission_worker_lease_invalid' });
        }
        const result = await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_campaign_mission_worker_leases
             SET lease_owner = NULL, lease_token = NULL, lease_expires_at = CURRENT_TIMESTAMP,
                 last_state = ?, last_error_code = ?, updated_at = CURRENT_TIMESTAMP
             WHERE mission_id = ? AND business_id = ? AND lease_owner = ? AND lease_token = ?`,
            [state, errorCode, missionId, businessId, String(input.worker_id).trim(), leaseToken],
            function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
        return result;
    }

    async getCallECampaignMissionWorkerLeaseStatus(missionId, businessId) {
        const normalizedId = String(missionId || '').trim();
        const normalizedBusinessId = String(businessId || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(normalizedId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) {
            throw Object.assign(new Error('CALL-E mission worker lease scope is invalid'), { code: 'call_e_mission_worker_lease_invalid' });
        }
        const row = await new Promise((resolve, reject) => this.db.get(
            `SELECT business_id, lease_owner, lease_expires_at,
                    CASE WHEN lease_expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS active,
                    last_state, last_error_code, updated_at
             FROM call_e_campaign_mission_worker_leases
             WHERE mission_id = ? AND business_id = ?`,
            [normalizedId, normalizedBusinessId], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        return row ? {
            business_id: row.business_id,
            lease_owner: row.lease_owner || null,
            lease_expires_at: row.lease_expires_at || null,
            active: Number(row.active) === 1,
            last_state: row.last_state,
            last_error_code: row.last_error_code || null,
            updated_at: row.updated_at || null,
        } : null;
    }

    async renewCallECampaignMissionWorkerLease(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const workerId = String(input.worker_id || '').trim();
        const leaseToken = String(input.lease_token || '').trim();
        const leaseMs = Math.max(1000, Math.min(300000, Number(input.lease_ms) || 60000));
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^[A-Za-z0-9._:-]{1,120}$/.test(workerId) || !/^[A-Za-z0-9_-]{16,128}$/.test(leaseToken)) return false;
        const modifier = `+${Math.ceil(leaseMs / 1000)} seconds`;
        const renewed = await new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_campaign_mission_worker_leases SET lease_expires_at = datetime('now', ?),
                last_state = 'leased', updated_at = CURRENT_TIMESTAMP
             WHERE mission_id = ? AND business_id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > CURRENT_TIMESTAMP`,
            [modifier, missionId, businessId, workerId, leaseToken], function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
        return renewed;
    }

    async getCallECampaignMissionWorkerControl(missionId, businessId) {
        const row = await new Promise((resolve, reject) => this.db.get(
            `SELECT paused, updated_by, updated_at FROM call_e_mission_worker_controls WHERE mission_id = ? AND business_id = ?`,
            [missionId, businessId], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        return row ? { paused: Number(row.paused) === 1, updated_by: row.updated_by || null, updated_at: row.updated_at || null } : { paused: false, updated_by: null, updated_at: null };
    }

    async setCallECampaignMissionWorkerControl(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const paused = input.paused === true;
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId)) {
            throw Object.assign(new Error('CALL-E worker control scope is invalid'), { code: 'call_e_mission_worker_control_invalid' });
        }
        const mission = await new Promise((resolve, reject) => this.db.get(
            `SELECT 1 AS found FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?`,
            [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        if (!mission) return null;
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_mission_worker_controls (business_id, mission_id, paused, updated_by, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id, mission_id) DO UPDATE SET paused = excluded.paused, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [businessId, missionId, paused ? 1 : 0, actorId], (error) => error ? reject(error) : resolve(),
        ));
        await this.insertCallEOperationsAudit({ business_id: businessId, actor_id: actorId, action: paused ? 'worker_paused' : 'worker_resumed', mission_id: missionId });
        return this.getCallECampaignMissionWorkerControl(missionId, businessId);
    }

    async getCallEBusinessSafetyPolicy(businessId) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT business_id, max_calls_per_day, quiet_hours_start, quiet_hours_end, timezone, emergency_stop, contact_cooldown_hours, updated_by, updated_at
             FROM call_e_business_safety_policies WHERE business_id = ?`,
            [businessId], (error, row) => error ? reject(error) : resolve(row ? { ...row, emergency_stop: Number(row.emergency_stop) === 1 } : null),
        ));
    }

    async setCallEBusinessSafetyPolicy(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const maxCalls = Number(input.max_calls_per_day);
        const timezone = String(input.timezone || '').trim();
        const start = input.quiet_hours_start == null ? null : String(input.quiet_hours_start);
        const end = input.quiet_hours_end == null ? null : String(input.quiet_hours_end);
        const contactCooldownHours = Number(input.contact_cooldown_hours ?? 0);
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) || !Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 1000 ||
            !Number.isSafeInteger(contactCooldownHours) || contactCooldownHours < 0 || contactCooldownHours > 8760 ||
            !timezone || timezone.length > 100 || (start !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) || (end !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) ||
            ((start === null) !== (end === null)) || typeof input.emergency_stop !== 'boolean') {
            throw Object.assign(new Error('CALL-E safety policy is invalid'), { code: 'call_e_safety_policy_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_business_safety_policies (business_id, max_calls_per_day, quiet_hours_start, quiet_hours_end, timezone, emergency_stop, contact_cooldown_hours, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id) DO UPDATE SET max_calls_per_day = excluded.max_calls_per_day,
                quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end,
                timezone = excluded.timezone, emergency_stop = excluded.emergency_stop,
                contact_cooldown_hours = excluded.contact_cooldown_hours,
                updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [businessId, maxCalls, start, end, timezone, input.emergency_stop ? 1 : 0, contactCooldownHours, actorId], (error) => error ? reject(error) : resolve(),
        ));
        await this.insertCallEOperationsAudit({ business_id: businessId, actor_id: actorId, action: 'safety_policy_updated', metadata: {
            max_calls_per_day: maxCalls, quiet_hours_start: start, quiet_hours_end: end, timezone, emergency_stop: input.emergency_stop,
            contact_cooldown_hours: contactCooldownHours,
        } });
        return this.getCallEBusinessSafetyPolicy(businessId);
    }

    async reserveCallEBusinessDispatch(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const position = Number(input.recipient_position);
        const usageDate = String(input.usage_date || '').trim();
        const workerManaged = input.worker_managed === true;
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) {
            throw Object.assign(new Error('CALL-E daily dispatch reservation is invalid'), { code: 'call_e_safety_reservation_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const policy = await new Promise((resolve, reject) => this.db.get(
                `SELECT max_calls_per_day, emergency_stop FROM call_e_business_safety_policies WHERE business_id = ?`,
                [businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!policy || Number(policy.emergency_stop) === 1 || Number(policy.max_calls_per_day) < 1) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: !policy ? 'safety_policy_required' : Number(policy.emergency_stop) === 1 ? 'emergency_stop' : 'daily_limit_disabled', calls_remaining: 0 };
            }
            const recipient = await new Promise((resolve, reject) => this.db.get(
                `SELECT m.status AS mission_status, r.status AS recipient_status, COALESCE(w.paused, 0) AS worker_paused
                 FROM call_e_campaign_missions m JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
                 LEFT JOIN call_e_mission_worker_controls w ON w.mission_id = m.mission_id AND w.business_id = m.business_id
                 WHERE m.mission_id = ? AND m.business_id = ? AND r.position = ?`,
                [missionId, businessId, position], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!recipient || !['approved', 'running'].includes(recipient.mission_status) || recipient.recipient_status !== 'in_progress' || (workerManaged && Number(recipient.worker_paused) === 1)) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: workerManaged && Number(recipient?.worker_paused) === 1 ? 'mission_worker_paused' : 'mission_not_dispatchable', calls_remaining: 0 };
            }
            const prior = await new Promise((resolve, reject) => this.db.get(
                `SELECT usage_date, status FROM call_e_business_dispatch_reservations WHERE mission_id = ? AND recipient_position = ? AND business_id = ?`,
                [missionId, position, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (prior?.status === 'reserved') {
                const remaining = await new Promise((resolve, reject) => this.db.get(
                    `SELECT MAX(0, ? - COUNT(*)) AS remaining FROM call_e_business_dispatch_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved'`,
                    [Number(policy.max_calls_per_day), businessId, usageDate], (error, row) => error ? reject(error) : resolve(Number(row?.remaining) || 0),
                ));
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: true, reason: null, calls_remaining: remaining, idempotent: true };
            }
            const usage = await new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS used FROM call_e_business_dispatch_reservations WHERE business_id = ? AND usage_date = ? AND status = 'reserved'`,
                [businessId, usageDate], (error, row) => error ? reject(error) : resolve(Number(row?.used) || 0),
            ));
            if (usage >= Number(policy.max_calls_per_day)) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { allowed: false, reason: 'daily_limit_reached', calls_remaining: 0 };
            }
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_business_dispatch_reservations (business_id, mission_id, recipient_position, usage_date, status, created_at, released_at)
                 VALUES (?, ?, ?, ?, 'reserved', CURRENT_TIMESTAMP, NULL)
                 ON CONFLICT(mission_id, recipient_position) DO UPDATE SET usage_date = excluded.usage_date, status = 'reserved', created_at = CURRENT_TIMESTAMP, released_at = NULL`,
                [businessId, missionId, position, usageDate], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { allowed: true, reason: null, calls_remaining: Math.max(0, Number(policy.max_calls_per_day) - usage - 1), idempotent: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async releaseCallEBusinessDispatch(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const position = Number(input.recipient_position);
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !Number.isSafeInteger(position) || position < 0) return false;
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_business_dispatch_reservations SET status = 'released', released_at = CURRENT_TIMESTAMP
             WHERE mission_id = ? AND business_id = ? AND recipient_position = ? AND status = 'reserved'`,
            [missionId, businessId, position], function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
    }

    async releaseCallECampaignMissionRecipientClaim(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const position = Number(input.position);
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !Number.isSafeInteger(position) || position < 0) return false;
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_campaign_mission_recipients SET status = 'queued', error_code = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE mission_id = ? AND position = ? AND status = 'in_progress' AND local_call_id IS NULL`,
            [missionId, position], function (error) { error ? reject(error) : resolve(this.changes === 1); },
        ));
    }

    async getCallEBusinessDispatchUsage(businessId, usageDate) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT COUNT(*) AS used FROM call_e_business_dispatch_reservations
             WHERE business_id = ? AND usage_date = ? AND status = 'reserved'`,
            [businessId, usageDate], (error, row) => error ? reject(error) : resolve({ used: Number(row?.used) || 0 }),
        ));
    }

    async insertCallEOperationsAudit(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const missionId = input.mission_id == null ? null : String(input.mission_id).trim();
        const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? JSON.stringify(input.metadata) : '{}';
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
            !['safety_policy_updated', 'worker_paused', 'worker_resumed', 'sensitive_data_purged'].includes(action) || metadata.length > 4000 ||
            (missionId && !/^mission_[a-f0-9]{64}$/.test(missionId))) throw new Error('CALL-E operations audit input is invalid');
        return new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_operations_audit (business_id, actor_id, action, mission_id, metadata_json) VALUES (?, ?, ?, ?, ?)`,
            [businessId, actorId, action, missionId, metadata], function (error) { error ? reject(error) : resolve(this.lastID); },
        ));
    }

    async listCallEOperationsAudit(businessId, limit = 50) {
        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT business_id, actor_id, action, mission_id, metadata_json, created_at
             FROM call_e_operations_audit WHERE business_id = ? ORDER BY audit_id DESC LIMIT ?`,
            [businessId, safeLimit], (error, rows) => error ? reject(error) : resolve((rows || []).map((row) => {
                let metadata = {};
                try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { metadata = {}; }
                return { business_id: row.business_id, actor_id: row.actor_id, action: row.action, mission_id: row.mission_id || null, metadata, created_at: row.created_at };
            })),
        ));
    }

    async getCallESensitiveRetentionPreview(businessId, cutoff = new Date().toISOString()) {
        const [goals, missions] = await Promise.all([
            new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS count FROM call_e_goal_run_requests WHERE business_id = ? AND sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL`,
                [businessId, cutoff], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
            )),
            new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS count FROM call_e_campaign_missions WHERE business_id = ? AND sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL`,
                [businessId, cutoff], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
            )),
        ]);
        return { expired_goal_runs: goals, expired_missions: missions, cutoff };
    }

    async listCallESensitiveRetentionScopes(cutoff = new Date().toISOString(), limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
        const scopes = await new Promise((resolve, reject) => this.db.all(
            `SELECT business_id FROM call_e_goal_run_requests WHERE sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL
             UNION SELECT business_id FROM call_e_campaign_missions WHERE sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL
             ORDER BY business_id LIMIT ?`,
            [cutoff, cutoff, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
        return scopes.map((row) => String(row.business_id || '')).filter((value) => /^[A-Za-z0-9._:-]{1,120}$/.test(value));
    }

    async purgeCallESensitiveData(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const cutoff = String(input.cutoff || new Date().toISOString());
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) || !Number.isFinite(Date.parse(cutoff))) throw new Error('CALL-E retention scope is invalid');
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const preview = await this.getCallESensitiveRetentionPreview(businessId, cutoff);
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_goal_run_requests SET encrypted_payload = '', encrypted_result = NULL, result_schema_json = '',
                    sensitive_data_purged_at = CURRENT_TIMESTAMP,
                    status = CASE WHEN status IN ('pending_approval', 'approved', 'submitting', 'recovery_required', 'running') THEN 'needs_review' ELSE status END,
                    error_code = CASE WHEN status IN ('pending_approval', 'approved', 'submitting', 'recovery_required', 'running') THEN 'sensitive_data_retention_expired' ELSE error_code END,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE business_id = ? AND sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL`,
                [businessId, cutoff], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_mission_recipients SET encrypted_destination = '',
                    status = CASE WHEN status IN ('queued', 'in_progress') THEN 'needs_review' ELSE status END,
                    error_code = CASE WHEN status IN ('queued', 'in_progress') THEN 'sensitive_data_retention_expired' ELSE error_code END,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id IN (SELECT mission_id FROM call_e_campaign_missions WHERE business_id = ? AND sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL)`,
                [businessId, cutoff], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_missions SET sensitive_data_purged_at = CURRENT_TIMESTAMP,
                    status = CASE WHEN status IN ('pending_approval', 'approved', 'running', 'paused') THEN 'needs_review' ELSE status END,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE business_id = ? AND sensitive_data_expires_at <= datetime(?) AND sensitive_data_purged_at IS NULL`,
                [businessId, cutoff], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT INTO call_e_operations_audit (business_id, actor_id, action, metadata_json)
                 VALUES (?, ?, 'sensitive_data_purged', ?)`,
                [businessId, actorId, JSON.stringify(preview)], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return preview;
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally { release(); }
    }

    async claimNextCallECampaignMissionRecipient(missionId, businessId) {
        const normalizedId = String(missionId || '').trim();
        const normalizedBusinessId = String(businessId || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(normalizedId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId)) {
            throw Object.assign(new Error('CALL-E mission scope is invalid'), { code: 'call_e_mission_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const mission = await new Promise((resolve, reject) => this.db.get(
                'SELECT status FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
                [normalizedId, normalizedBusinessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!mission) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            if (!['approved', 'running'].includes(mission.status)) {
                throw Object.assign(new Error('Mission is not approved for execution'), { code: 'call_e_mission_not_approved' });
            }
            const accepted = await new Promise((resolve, reject) => this.db.get(
                `SELECT position FROM call_e_campaign_mission_recipients WHERE mission_id = ? AND status = 'accepted' ORDER BY position LIMIT 1`,
                [normalizedId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (accepted) {
                const saved = await this.getCallECampaignMissionForBusiness(normalizedId, normalizedBusinessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return saved ? { mission: saved.mission, recipient: null, recovery: false, waitingForAccepted: true } : null;
            }
            let recipient = await new Promise((resolve, reject) => this.db.get(
                `SELECT * FROM call_e_campaign_mission_recipients WHERE mission_id = ? AND status = 'in_progress' ORDER BY position LIMIT 1`,
                [normalizedId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            const recovery = Boolean(recipient);
            if (!recipient) {
                const next = await new Promise((resolve, reject) => this.db.get(
                    `SELECT * FROM call_e_campaign_mission_recipients WHERE mission_id = ? AND status = 'queued' ORDER BY position LIMIT 1`,
                    [normalizedId], (error, row) => error ? reject(error) : resolve(row || null),
                ));
                if (next) {
                    await new Promise((resolve, reject) => this.db.run(
                        `UPDATE call_e_campaign_mission_recipients SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
                         WHERE mission_id = ? AND position = ? AND status = 'queued'`,
                        [normalizedId, next.position], (error) => error ? reject(error) : resolve(),
                    ));
                    recipient = await new Promise((resolve, reject) => this.db.get(
                        'SELECT * FROM call_e_campaign_mission_recipients WHERE mission_id = ? AND position = ?',
                        [normalizedId, next.position], (error, row) => error ? reject(error) : resolve(row || null),
                    ));
                }
            }
            if (recipient) {
                await new Promise((resolve, reject) => this.db.run(
                    `UPDATE call_e_campaign_missions SET status = 'running', updated_at = CURRENT_TIMESTAMP
                     WHERE mission_id = ? AND status IN ('approved', 'running')`,
                    [normalizedId], (error) => error ? reject(error) : resolve(),
                ));
            } else {
                const remaining = await new Promise((resolve, reject) => this.db.get(
                    `SELECT COUNT(*) AS count FROM call_e_campaign_mission_recipients
                     WHERE mission_id = ? AND status IN ('queued', 'in_progress', 'accepted')`,
                    [normalizedId], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
                ));
                const needsReview = await new Promise((resolve, reject) => this.db.get(
                    `SELECT COUNT(*) AS count FROM call_e_campaign_mission_recipients
                     WHERE mission_id = ? AND status IN ('needs_review', 'failed', 'blocked', 'canceled')`,
                    [normalizedId], (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
                ));
                if (remaining === 0) {
                    const nextStatus = needsReview > 0 ? 'needs_review' : 'completed';
                    await new Promise((resolve, reject) => this.db.run(
                        'UPDATE call_e_campaign_missions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE mission_id = ?',
                        [nextStatus, normalizedId], (error) => error ? reject(error) : resolve(),
                    ));
                }
            }
            const saved = recipient ? await this.getCallECampaignMissionForBusiness(normalizedId, normalizedBusinessId) : null;
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return saved ? { mission: saved.mission, recipient: saved.recipients.find((row) => row.position === recipient.position), recovery } : null;
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async updateCallECampaignMissionRecipient(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const position = Number(input.position);
        const nextStatus = String(input.status || '').trim();
        const localCallId = input.local_call_id == null ? null : String(input.local_call_id).trim();
        const errorCode = input.error_code == null ? null : String(input.error_code).trim().toLowerCase();
        const transitions = {
            queued: new Set(['in_progress', 'blocked', 'canceled']),
            in_progress: new Set(['accepted', 'failed', 'blocked', 'needs_review']),
            accepted: new Set(['completed', 'failed', 'canceled', 'needs_review']),
            failed: new Set(), blocked: new Set(), needs_review: new Set(), completed: new Set(), canceled: new Set(),
        };
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !Number.isSafeInteger(position) || position < 0 || !Object.prototype.hasOwnProperty.call(transitions, nextStatus) ||
            (localCallId !== null && !/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) ||
            (errorCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode))) {
            throw Object.assign(new Error('CALL-E mission recipient update is invalid'), { code: 'call_e_mission_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const existing = await new Promise((resolve, reject) => this.db.get(
                `SELECT r.status, r.local_call_id FROM call_e_campaign_mission_recipients r
                 JOIN call_e_campaign_missions m ON m.mission_id = r.mission_id
                 WHERE r.mission_id = ? AND r.position = ? AND m.business_id = ?`,
                [missionId, position, businessId], (error, row) => error ? reject(error) : resolve(row || null),
            ));
            if (!existing) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            if (existing.status === nextStatus && (localCallId === null || existing.local_call_id === localCallId)) {
                const savedReplay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...savedReplay, idempotentReplay: true };
            }
            if (!transitions[existing.status]?.has(nextStatus)) {
                throw Object.assign(new Error('CALL-E mission recipient transition is not allowed'), { code: 'call_e_mission_transition_invalid' });
            }
            if (nextStatus === 'accepted' && !localCallId) {
                throw Object.assign(new Error('An accepted mission recipient requires a local call ID'), { code: 'call_e_mission_invalid' });
            }
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_mission_recipients SET status = ?, local_call_id = COALESCE(?, local_call_id),
                        error_code = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND position = ? AND status = ?`,
                [nextStatus, localCallId, errorCode, missionId, position, existing.status], (error) => error ? reject(error) : resolve(),
            ));
            const counts = await new Promise((resolve, reject) => this.db.get(
                `SELECT SUM(CASE WHEN status IN ('queued', 'in_progress', 'accepted') THEN 1 ELSE 0 END) AS active_count,
                        SUM(CASE WHEN status IN ('needs_review', 'failed', 'blocked', 'canceled') THEN 1 ELSE 0 END) AS attention_count
                 FROM call_e_campaign_mission_recipients WHERE mission_id = ?`,
                [missionId], (error, row) => error ? reject(error) : resolve(row || {}),
            ));
            const parentStatus = Number(counts.attention_count) > 0 ? 'needs_review'
                : Number(counts.active_count) > 0 ? 'running' : 'completed';
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_missions SET status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND business_id = ? AND status NOT IN ('rejected', 'canceled')`,
                [parentStatus, missionId, businessId], (error) => error ? reject(error) : resolve(),
            ));
            const eventKey = `recipient:${missionId}:${position}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
            await new Promise((resolve, reject) => this.db.run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, event_type, recipient_position, state, error_code)
                 VALUES (?, ?, ?, 'recipient_transition', ?, ?, ?)`,
                [businessId, missionId, eventKey, position, nextStatus, errorCode], (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async getCallEBusinessMissionPolicy(businessId) {
        return new Promise((resolve, reject) => this.db.get(
            'SELECT business_id, secondary_approval_threshold, approval_ttl_hours, review_sla_minutes, review_repeat_minutes, updated_by, updated_at FROM call_e_business_mission_policies WHERE business_id = ?',
            [String(businessId || '').trim()], (error, row) => error ? reject(error) : resolve(row || null),
        ));
    }

    async validateCallECampaignMissionApproval(missionId, businessId) {
        const rows = await new Promise((resolve, reject) => this.db.all(
            `SELECT reviewed_by, decision, created_at FROM call_e_approval_decisions
             WHERE entity_type = 'mission' AND entity_id = ? AND business_id = ?
             UNION ALL
             SELECT reviewed_by, decision, created_at FROM call_e_mission_secondary_approvals
             WHERE mission_id = ? AND business_id = ? ORDER BY created_at`,
            [missionId, businessId, missionId, businessId], (error, result) => error ? reject(error) : resolve(result || []),
        ));
        const policy = await this.getCallEBusinessMissionPolicy(businessId);
        const threshold = Number(policy?.secondary_approval_threshold || 26);
        const ttlHours = Number(policy?.approval_ttl_hours || 24);
        const approvals = rows.filter((row) => row.decision === 'approve');
        const mission = await new Promise((resolve, reject) => this.db.get(
            'SELECT recipient_count FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?',
            [missionId, businessId], (error, row) => error ? reject(error) : resolve(row || null),
        ));
        const expected = Number(mission?.recipient_count) >= threshold ? 2 : 1;
        if (approvals.length < expected || (expected === 2 && new Set(approvals.map((row) => row.reviewed_by)).size < 2)) {
            return { valid: false, reason: 'approval_incomplete' };
        }
        const approvalTimestamp = String(approvals[approvals.length - 1]?.created_at || '');
        const lastApprovalAt = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(approvalTimestamp)
            ? approvalTimestamp : `${approvalTimestamp.replace(' ', 'T')}Z`);
        return { valid: Number.isFinite(lastApprovalAt) && Date.now() - lastApprovalAt <= ttlHours * 60 * 60 * 1000,
            reason: 'approval_expired', approval_expires_at: Number.isFinite(lastApprovalAt) ? new Date(lastApprovalAt + ttlHours * 60 * 60 * 1000).toISOString() : null };
    }

    async setCallEBusinessMissionPolicy(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const threshold = Number(input.secondary_approval_threshold);
        const ttl = Number(input.approval_ttl_hours);
        const reviewSlaMinutes = Number(input.review_sla_minutes ?? 0);
        const reviewRepeatMinutes = Number(input.review_repeat_minutes ?? 0);
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
            !Number.isSafeInteger(threshold) || threshold < 2 || threshold > 26 ||
            !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 720 || !Number.isSafeInteger(reviewSlaMinutes) || reviewSlaMinutes < 0 || reviewSlaMinutes > 10080 ||
            !Number.isSafeInteger(reviewRepeatMinutes) || reviewRepeatMinutes < 0 || reviewRepeatMinutes > 10080 || (reviewRepeatMinutes > 0 && reviewSlaMinutes === 0)) {
            throw Object.assign(new Error('CALL-E mission approval policy is invalid'), { code: 'call_e_mission_policy_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_business_mission_policies (business_id, secondary_approval_threshold, approval_ttl_hours, review_sla_minutes, review_repeat_minutes, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id) DO UPDATE SET secondary_approval_threshold = excluded.secondary_approval_threshold,
               approval_ttl_hours = excluded.approval_ttl_hours, review_sla_minutes = excluded.review_sla_minutes,
               review_repeat_minutes = excluded.review_repeat_minutes,
               updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [businessId, threshold, ttl, reviewSlaMinutes, reviewRepeatMinutes, actorId], (error) => error ? reject(error) : resolve(),
        ));
        return this.getCallEBusinessMissionPolicy(businessId);
    }

    async getCallEBusinessProviderRouting(businessId) {
        const row = await new Promise((resolve, reject) => this.db.get(
            'SELECT provider_order_json, updated_by, updated_at FROM call_e_business_provider_routing WHERE business_id = ?',
            [String(businessId || '').trim()], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        if (!row) return null;
        let order = [];
        try { order = JSON.parse(row.provider_order_json); } catch (_) {}
        return { provider_order: Array.isArray(order) ? order : [], updated_by: row.updated_by, updated_at: row.updated_at };
    }

    async setCallEBusinessProviderRouting(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const order = Array.isArray(input.provider_order) ? input.provider_order : [];
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
            order.length < 1 || order.length > 3 || order.some((provider) => !['twilio', 'plivo', 'vonage'].includes(provider)) || new Set(order).size !== order.length) {
            throw Object.assign(new Error('CALL-E business provider routing policy is invalid'), { code: 'call_e_provider_routing_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_business_provider_routing (business_id, provider_order_json, updated_by, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id) DO UPDATE SET provider_order_json = excluded.provider_order_json,
               updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [businessId, JSON.stringify(order), actorId], (error) => error ? reject(error) : resolve(),
        ));
        return this.getCallEBusinessProviderRouting(businessId);
    }

    async recordCallEMissionActivity(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const missionId = String(input.mission_id || '').trim();
        const eventKey = String(input.event_key || '').trim();
        const actorId = input.actor_id == null ? null : String(input.actor_id).trim();
        const eventType = String(input.event_type || '').trim();
        const position = input.recipient_position == null ? null : Number(input.recipient_position);
        const state = String(input.state || '').trim();
        const errorCode = input.error_code == null ? null : String(input.error_code).trim();
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) ||
            !/^[A-Za-z0-9._:-]{8,180}$/.test(eventKey) || (actorId !== null && !/^\d{1,20}$/.test(actorId)) ||
            !['mission_created', 'approval_recorded', 'mission_resolved', 'recipient_transition', 'recipient_retry_requested', 'mission_advanced'].includes(eventType) ||
            (position !== null && (!Number.isSafeInteger(position) || position < 0 || position > 24)) ||
            !/^[a-z_]{1,40}$/.test(state) || (errorCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode))) {
            throw Object.assign(new Error('CALL-E mission activity event is invalid'), { code: 'call_e_mission_activity_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, recipient_position, state, error_code)
             SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM call_e_campaign_missions WHERE mission_id = ? AND business_id = ?
             )`,
            [businessId, missionId, eventKey, actorId, eventType, position, state, errorCode, missionId, businessId],
            function done(error) { if (error) reject(error); else resolve(this.changes > 0); },
        ));
    }

    async listCallEMissionActivity(businessId, missionId, limit = 100) {
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT event_id, actor_id, event_type, recipient_position, state, error_code, created_at
             FROM call_e_mission_activity WHERE business_id = ? AND mission_id = ? ORDER BY event_id DESC LIMIT ?`,
            [String(businessId || '').trim(), String(missionId || '').trim(), safeLimit],
            (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async retryCallECampaignMissionRecipient(input = {}) {
        const missionId = String(input.mission_id || '').trim();
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const position = Number(input.position);
        const eventKey = String(input.idempotency_key || '').trim();
        if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !/^\d{1,20}$/.test(actorId) || !Number.isSafeInteger(position) || position < 0 || position > 24 ||
            !/^[A-Za-z0-9._:-]{8,180}$/.test(eventKey)) {
            throw Object.assign(new Error('CALL-E mission retry request is invalid'), { code: 'call_e_mission_retry_invalid' });
        }
        let release;
        const previous = this.callECampaignWriteChain;
        this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            await new Promise((resolve, reject) => this.db.run('BEGIN IMMEDIATE', (error) => error ? reject(error) : resolve()));
            const row = await new Promise((resolve, reject) => this.db.get(
                `SELECT m.status AS mission_status, r.status, r.error_code FROM call_e_campaign_missions m
                 JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
                 WHERE m.mission_id = ? AND m.business_id = ? AND r.position = ?`,
                [missionId, businessId, position], (error, result) => error ? reject(error) : resolve(result || null),
            ));
            if (!row) {
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return null;
            }
            if (row.status === 'queued') {
                const replay = await this.getCallECampaignMissionForBusiness(missionId, businessId);
                await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
                return { ...replay, idempotentReplay: true };
            }
            if (row.status !== 'failed' || row.error_code !== 'call_e_request_rejected' ||
                !['running', 'needs_review'].includes(row.mission_status)) {
                throw Object.assign(new Error('Only a provider-confirmed rejected submission can be retried'), { code: 'call_e_mission_retry_not_safe' });
            }
            const active = await new Promise((resolve, reject) => this.db.get(
                `SELECT COUNT(*) AS count FROM call_e_campaign_mission_recipients
                 WHERE mission_id = ? AND status IN ('in_progress', 'accepted')`,
                [missionId], (error, result) => error ? reject(error) : resolve(Number(result?.count) || 0),
            ));
            if (active > 0) throw Object.assign(new Error('Reconcile active recipients before retrying'), { code: 'call_e_mission_active_recipient' });
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_mission_recipients SET status = 'queued', error_code = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND position = ? AND status = 'failed' AND error_code = 'call_e_request_rejected'`,
                [missionId, position], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `UPDATE call_e_campaign_missions SET status = 'running', updated_at = CURRENT_TIMESTAMP
                 WHERE mission_id = ? AND business_id = ? AND status IN ('running', 'needs_review')`,
                [missionId, businessId], (error) => error ? reject(error) : resolve(),
            ));
            await new Promise((resolve, reject) => this.db.run(
                `INSERT OR IGNORE INTO call_e_mission_activity (business_id, mission_id, event_key, actor_id, event_type, recipient_position, state)
                 VALUES (?, ?, ?, ?, 'recipient_retry_requested', ?, 'queued')`,
                [businessId, missionId, `recipient-retry:${missionId}:${eventKey}`, actorId, position], (error) => error ? reject(error) : resolve(),
            ));
            const saved = await this.getCallECampaignMissionForBusiness(missionId, businessId);
            await new Promise((resolve, reject) => this.db.run('COMMIT', (error) => error ? reject(error) : resolve()));
            return { ...saved, idempotentReplay: false };
        } catch (error) {
            await new Promise((resolve) => this.db.run('ROLLBACK', () => resolve()));
            throw error;
        } finally {
            release();
        }
    }

    async getCallECampaignMissionReport(businessId, fromDate, toDate) {
        return new Promise((resolve, reject) => this.db.get(
            `SELECT COUNT(DISTINCT m.mission_id) AS mission_count,
                    COUNT(DISTINCT CASE WHEN m.status = 'completed' THEN m.mission_id END) AS completed_missions,
                    COUNT(DISTINCT CASE WHEN m.status IN ('needs_review', 'paused') THEN m.mission_id END) AS attention_missions,
                    SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_recipients,
                    SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_recipients,
                    SUM(CASE WHEN r.status IN ('blocked', 'needs_review') THEN 1 ELSE 0 END) AS review_recipients,
                    SUM(CASE WHEN r.status = 'canceled' THEN 1 ELSE 0 END) AS canceled_recipients,
                    SUM(CASE WHEN r.status IN ('queued', 'in_progress', 'accepted') THEN 1 ELSE 0 END) AS open_recipients
             FROM call_e_campaign_missions m JOIN call_e_campaign_mission_recipients r ON r.mission_id = m.mission_id
             WHERE m.business_id = ? AND m.created_at >= ? AND m.created_at < datetime(?, '+1 day')`,
            [String(businessId || '').trim(), fromDate, toDate], (error, row) => error ? reject(error) : resolve(row || {}),
        ));
    }

    async setCallEMissionAlertSubscription(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const enabled = input.enabled === true;
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId)) {
            throw Object.assign(new Error('CALL-E alert subscription is invalid'), { code: 'call_e_alert_subscription_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_mission_alert_subscriptions (business_id, actor_id, enabled, last_notified_event_id, updated_at)
             VALUES (?, ?, ?, CASE WHEN ? = 1 THEN COALESCE((SELECT MAX(event_id) FROM call_e_mission_activity WHERE business_id = ?), 0) ELSE 0 END, CURRENT_TIMESTAMP)
             ON CONFLICT(business_id, actor_id) DO UPDATE SET
               enabled = excluded.enabled,
               last_notified_event_id = CASE WHEN call_e_mission_alert_subscriptions.enabled = 0 AND excluded.enabled = 1
                 THEN excluded.last_notified_event_id ELSE call_e_mission_alert_subscriptions.last_notified_event_id END,
               updated_at = CURRENT_TIMESTAMP`,
            [businessId, actorId, enabled ? 1 : 0, enabled ? 1 : 0, businessId], (error) => error ? reject(error) : resolve(),
        ));
        return { business_id: businessId, actor_id: actorId, enabled };
    }

    async getCallEMissionAlertSubscription(businessId, actorId) {
        const row = await new Promise((resolve, reject) => this.db.get(
            'SELECT business_id, actor_id, enabled, updated_at FROM call_e_mission_alert_subscriptions WHERE business_id = ? AND actor_id = ?',
            [String(businessId || '').trim(), String(actorId || '').trim()], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        return row ? { ...row, enabled: Number(row.enabled) === 1 } : { business_id: businessId, actor_id: actorId, enabled: false };
    }

    async setCallEMissionReportDigestSubscription(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const intervalHours = Number(input.interval_hours);
        const enabled = input.enabled === true;
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
            ![24, 168].includes(intervalHours) || typeof input.enabled !== 'boolean') {
            throw Object.assign(new Error('CALL-E report digest subscription is invalid'), { code: 'call_e_report_digest_invalid' });
        }
        await new Promise((resolve, reject) => this.db.run(
            `INSERT INTO call_e_mission_report_digest_subscriptions (business_id, actor_id, interval_hours, enabled, next_delivery_at, updated_at)
             VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' hours'), CURRENT_TIMESTAMP)
             ON CONFLICT(business_id, actor_id) DO UPDATE SET interval_hours = excluded.interval_hours, enabled = excluded.enabled,
               next_delivery_at = CASE WHEN call_e_mission_report_digest_subscriptions.interval_hours != excluded.interval_hours
                 OR call_e_mission_report_digest_subscriptions.enabled = 0 OR excluded.enabled = 0
                 THEN excluded.next_delivery_at ELSE call_e_mission_report_digest_subscriptions.next_delivery_at END,
               updated_at = CURRENT_TIMESTAMP`,
            [businessId, actorId, intervalHours, enabled ? 1 : 0, intervalHours], (error) => error ? reject(error) : resolve(),
        ));
        return this.getCallEMissionReportDigestSubscription(businessId, actorId);
    }

    async getCallEMissionReportDigestSubscription(businessId, actorId) {
        const row = await new Promise((resolve, reject) => this.db.get(
            `SELECT business_id, actor_id, interval_hours, enabled, next_delivery_at FROM call_e_mission_report_digest_subscriptions
             WHERE business_id = ? AND actor_id = ?`,
            [String(businessId || '').trim(), String(actorId || '').trim()], (error, result) => error ? reject(error) : resolve(result || null),
        ));
        return row ? { ...row, enabled: Number(row.enabled) === 1 } : { business_id: businessId, actor_id: actorId, interval_hours: 24, enabled: false, next_delivery_at: null };
    }

    async listDueCallEMissionReportDigests(nowIso = new Date().toISOString(), limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT s.business_id, s.actor_id, s.interval_hours, s.next_delivery_at
             FROM call_e_mission_report_digest_subscriptions s
             WHERE s.enabled = 1 AND datetime(s.next_delivery_at) <= datetime(?)
               AND datetime(s.updated_at) <= datetime(?, '-5 minutes')
               AND EXISTS (
                 SELECT 1 FROM call_e_business_operator_events access
                 WHERE access.business_id = s.business_id AND access.telegram_id = s.actor_id
                   AND access.event_type = 'access_granted' AND access.id = (
                     SELECT MAX(latest.id) FROM call_e_business_operator_events latest
                     WHERE latest.business_id = s.business_id AND latest.telegram_id = s.actor_id
                   )
               )
             ORDER BY s.next_delivery_at LIMIT ?`,
            [nowIso, nowIso, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async advanceCallEMissionReportDigest(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const previousDue = String(input.previous_due_at || '').trim();
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_report_digest_subscriptions SET
               next_delivery_at = datetime(next_delivery_at, '+' || interval_hours || ' hours'), updated_at = CURRENT_TIMESTAMP
             WHERE business_id = ? AND actor_id = ? AND enabled = 1 AND next_delivery_at = ?`,
            [businessId, actorId, previousDue], function (error) { error ? reject(error) : resolve(this.changes > 0); },
        ));
    }

    async claimCallEMissionReportDigest(input = {}) {
        const businessId = String(input.business_id || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const previousDue = String(input.previous_due_at || '').trim();
        const nowIso = String(input.now || new Date().toISOString());
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_report_digest_subscriptions SET updated_at = ?
             WHERE business_id = ? AND actor_id = ? AND enabled = 1 AND next_delivery_at = ?
               AND datetime(next_delivery_at) <= datetime(?) AND datetime(updated_at) <= datetime(?, '-5 minutes')`,
            [nowIso, businessId, actorId, previousDue, nowIso, nowIso], function (error) { error ? reject(error) : resolve(this.changes > 0); },
        ));
    }

    async touchCallEMissionReportDigest(input = {}) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_report_digest_subscriptions SET updated_at = CURRENT_TIMESTAMP
             WHERE business_id = ? AND actor_id = ? AND enabled = 1`,
            [String(input.business_id || '').trim(), String(input.actor_id || '').trim()], (error) => error ? reject(error) : resolve(),
        ));
    }

    async listCallEMissionAlertSubscriptions() {
        return new Promise((resolve, reject) => this.db.all(
            `SELECT s.business_id, s.actor_id, s.last_notified_event_id
             FROM call_e_mission_alert_subscriptions s
             WHERE s.enabled = 1
               AND EXISTS (
                 SELECT 1 FROM call_e_business_operator_events current_access
                 WHERE current_access.business_id = s.business_id
                   AND current_access.telegram_id = s.actor_id
                   AND current_access.event_type = 'access_granted'
                   AND current_access.id = (
                     SELECT MAX(latest_access.id) FROM call_e_business_operator_events latest_access
                     WHERE latest_access.business_id = s.business_id AND latest_access.telegram_id = s.actor_id
                   )
               )
             ORDER BY s.updated_at LIMIT 500`,
            (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async listCallEMissionAlertsForSubscription(input = {}, limit = 20) {
        const afterId = Math.max(0, Number(input.after_event_id) || 0);
        const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
        return new Promise((resolve, reject) => this.db.all(
            `SELECT event_id, mission_id, event_type, recipient_position, state, error_code, created_at
             FROM call_e_mission_activity WHERE business_id = ? AND event_id > ?
             ORDER BY event_id ASC LIMIT ?`,
            [String(input.business_id || '').trim(), afterId, safeLimit], (error, rows) => error ? reject(error) : resolve(rows || []),
        ));
    }

    async advanceCallEMissionAlertCursor(input = {}) {
        const eventId = Math.max(0, Number(input.event_id) || 0);
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_alert_subscriptions SET last_notified_event_id = MAX(last_notified_event_id, ?), updated_at = CURRENT_TIMESTAMP
             WHERE business_id = ? AND actor_id = ? AND enabled = 1`,
            [eventId, String(input.business_id || '').trim(), String(input.actor_id || '').trim()],
            function done(error) { if (error) reject(error); else resolve(this.changes > 0); },
        ));
    }

    async touchCallEMissionAlertSubscription(input = {}) {
        return new Promise((resolve, reject) => this.db.run(
            `UPDATE call_e_mission_alert_subscriptions SET updated_at = CURRENT_TIMESTAMP
             WHERE business_id = ? AND actor_id = ? AND enabled = 1`,
            [String(input.business_id || '').trim(), String(input.actor_id || '').trim()],
            function done(error) { if (error) reject(error); else resolve(this.changes > 0); },
        ));
    }

    async resetCallERejectedOutboundCall(payload = {}) {
        const idempotencyKey = String(payload.idempotency_key || "").trim();
        const requestHash = String(payload.request_hash || "").trim();
        const localCallId = String(payload.local_call_id || "").trim();
        if (!idempotencyKey || !/^[a-f0-9]{64}$/i.test(requestHash) || !/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
            throw new Error("CALL-E rejected-call reset is invalid");
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE outbound_call_idempotency
                 SET request_hash = ?, call_sid = NULL, status = 'pending',
                     response_payload = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE idempotency_key = ? AND provider = 'call_e'
                   AND status = 'failed' AND error_message = 'call_e_no_call_created'`,
                [requestHash, JSON.stringify({ localCallId }), idempotencyKey],
                function (err) {
                    if (err) return reject(err);
                    resolve({ reset: (this.changes || 0) > 0 });
                },
            );
        });
    }

    async upsertCallEReconciliationRecord(payload = {}) {
        const localCallId = String(payload.local_call_id || '').trim();
        const providerCallId = String(payload.provider_call_id || '').trim() || null;
        const rawBusinessId = String(payload.business_id || '').trim();
        const businessId = rawBusinessId || null;
        const templateId = Number(payload.template_id);
        const templateVersion = Number(payload.template_version);
        const requestHash = String(payload.request_hash || '').trim();
        const schema = payload.result_schema;
        if (!/^call_e_[0-9a-f-]{36}$/i.test(localCallId) ||
            (providerCallId && !/^call_[A-Za-z0-9_-]{1,190}$/.test(providerCallId)) ||
            (businessId !== null && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) ||
            !Number.isSafeInteger(templateId) || templateId <= 0 ||
            !Number.isSafeInteger(templateVersion) || templateVersion <= 0 ||
            !/^[a-f0-9]{64}$/i.test(requestHash) || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
            throw new Error('CALL-E reconciliation record is invalid');
        }
        const schemaJson = JSON.stringify(schema);
        if (schemaJson.length > 16000) throw new Error('CALL-E result schema is too large');
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO call_e_reconciliation (
                    local_call_id, provider_call_id, business_id, template_id, template_version,
                    request_hash, result_schema_json, execution_status, call_outcome,
                    result_status, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(local_call_id) DO UPDATE SET
                    provider_call_id = COALESCE(excluded.provider_call_id, call_e_reconciliation.provider_call_id),
                    business_id = excluded.business_id,
                    template_id = excluded.template_id,
                    template_version = excluded.template_version,
                    request_hash = excluded.request_hash,
                    result_schema_json = excluded.result_schema_json,
                    execution_status = COALESCE(excluded.execution_status, call_e_reconciliation.execution_status),
                    call_outcome = COALESCE(excluded.call_outcome, call_e_reconciliation.call_outcome),
                    result_status = COALESCE(excluded.result_status, call_e_reconciliation.result_status),
                    updated_at = CURRENT_TIMESTAMP`,
                [localCallId, providerCallId, businessId, templateId, templateVersion, requestHash, schemaJson,
                    payload.execution_status || null, payload.call_outcome || null, payload.result_status || null],
                function (err) { if (err) return reject(err); resolve({ saved: this.changes > 0 }); },
            );
        });
    }

    async getCallEReconciliationRecord(localCallId) {
        const id = String(localCallId || '').trim();
        if (!/^call_e_[0-9a-f-]{36}$/i.test(id)) return null;
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM call_e_reconciliation WHERE local_call_id = ?', [id], (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve(null);
                let resultSchema = null;
                let seenEventIds = [];
                try { resultSchema = JSON.parse(row.result_schema_json || 'null'); } catch (_) {}
                try { seenEventIds = JSON.parse(row.seen_event_ids_json || '[]'); } catch (_) {}
                resolve({ ...row, result_schema: resultSchema, seen_event_ids: Array.isArray(seenEventIds) ? seenEventIds : [] });
            });
        });
    }

    async hasActiveCallEOperator(telegramId) {
        const actorId = String(telegramId || '').trim();
        if (!/^\d{1,20}$/.test(actorId)) return false;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT 1 AS present FROM call_e_business_operator_events current
                 WHERE current.telegram_id = ? AND current.event_type = 'access_granted'
                   AND current.role IN ('policy_manager', 'call_operator')
                   AND NOT EXISTS (
                     SELECT 1 FROM call_e_business_operator_events newer
                     WHERE newer.business_id = current.business_id
                       AND newer.telegram_id = current.telegram_id AND newer.id > current.id
                   ) LIMIT 1`,
                [actorId],
                (error, row) => error ? reject(error) : resolve(Boolean(row)),
            );
        });
    }

    async listCallEReconciliationCallsForOperator(input = {}) {
        const actorId = String(input.telegram_id || '').trim();
        const limit = Number(input.limit);
        const offset = Number(input.offset);
        const status = String(input.execution_status || '').trim().toLowerCase();
        const outcome = String(input.call_outcome || '').trim().toLowerCase();
        const resultStatus = String(input.result_status || '').trim().toLowerCase();
        const query = String(input.query || '').trim();
        const startDate = String(input.start_date || '').trim();
        const endDate = String(input.end_date || '').trim();
        const validDate = (value) => {
            if (!value) return true;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const parsed = new Date(`${value}T00:00:00.000Z`);
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
        };
        if (!/^\d{1,20}$/.test(actorId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isSafeInteger(offset) || offset < 0 || offset > 5000 ||
            (status && !['queued', 'in_progress', 'completed', 'failed', 'canceled'].includes(status)) ||
            (outcome && !['completed', 'no_answer', 'busy', 'declined'].includes(outcome)) ||
            (resultStatus && !['pending', 'available', 'unavailable', 'not_applicable'].includes(resultStatus)) ||
            (query && !/^[A-Za-z0-9_-]{2,200}$/.test(query)) || !validDate(startDate) || !validDate(endDate) ||
            (startDate && endDate && startDate > endDate)) {
            throw new Error('CALL-E operations list filters are invalid');
        }

        const operatorAccess = await this.hasActiveCallEOperator(actorId);
        if (!operatorAccess) return { operator_access: false, rows: [], total: 0, summary: { active: 0, failed: 0, results_ready: 0 }, limit, offset };

        const conditions = [`r.business_id IS NOT NULL`, `EXISTS (
            SELECT 1 FROM call_e_business_operator_events grant_event
            WHERE grant_event.business_id = r.business_id AND grant_event.telegram_id = ?
              AND grant_event.event_type = 'access_granted'
              AND grant_event.role IN ('policy_manager', 'call_operator')
              AND NOT EXISTS (
                SELECT 1 FROM call_e_business_operator_events newer
                WHERE newer.business_id = grant_event.business_id
                  AND newer.telegram_id = grant_event.telegram_id AND newer.id > grant_event.id
              )
        )`];
        const params = [actorId];
        if (status) { conditions.push('r.execution_status = ?'); params.push(status); }
        if (outcome) { conditions.push('r.call_outcome = ?'); params.push(outcome); }
        if (resultStatus) { conditions.push('r.result_status = ?'); params.push(resultStatus); }
        if (query) {
            conditions.push('(instr(lower(r.local_call_id), lower(?)) > 0 OR instr(lower(COALESCE(r.provider_call_id, "")), lower(?)) > 0)');
            params.push(query, query);
        }
        if (startDate) { conditions.push('date(r.created_at) >= date(?)'); params.push(startDate); }
        if (endDate) { conditions.push('date(r.created_at) <= date(?)'); params.push(endDate); }
        const where = conditions.join(' AND ');
        const summaryPromise = new Promise((resolve, reject) => {
            this.db.get(
                `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN r.execution_status IN ('queued', 'in_progress') THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN r.execution_status = 'failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN r.result_status = 'available' THEN 1 ELSE 0 END) AS results_ready
                 FROM call_e_reconciliation r WHERE ${where}`,
                params,
                (error, row) => error ? reject(error) : resolve(row || {}),
            );
        });
        const rowsPromise = new Promise((resolve, reject) => {
            this.db.all(
                `SELECT r.local_call_id, r.provider_call_id, r.template_id, r.template_version,
                    r.execution_status, r.call_outcome, r.result_status, r.error_code, r.created_at, r.updated_at
                 FROM call_e_reconciliation r WHERE ${where}
                 ORDER BY COALESCE(r.updated_at, r.created_at) DESC, r.local_call_id DESC LIMIT ? OFFSET ?`,
                [...params, limit, offset],
                (error, rows) => error ? reject(error) : resolve(rows || []),
            );
        });
        const [summary, rows] = await Promise.all([summaryPromise, rowsPromise]);
        return {
            operator_access: true,
            rows,
            total: Number(summary.total) || 0,
            summary: {
                active: Number(summary.active) || 0,
                failed: Number(summary.failed) || 0,
                results_ready: Number(summary.results_ready) || 0,
            },
            limit,
            offset,
        };
    }

    async getCallEReconciliationRecordByProviderId(providerCallId) {
        const id = String(providerCallId || '').trim();
        if (!/^call_[A-Za-z0-9_-]{1,190}$/.test(id)) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT local_call_id, business_id, template_id, template_version FROM call_e_reconciliation WHERE provider_call_id = ?',
                [id],
                (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
                },
            );
        });
    }

    async getCallEWebhookReceipt(providerCallId) {
        const id = String(providerCallId || '').trim();
        if (!/^call_[A-Za-z0-9_-]{1,190}$/.test(id)) return null;
        return new Promise((resolve, reject) => {
            this.db.get('SELECT event_id, event_type, processed_at FROM call_e_webhook_receipts WHERE provider_call_id = ?', [id], (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        });
    }

    async recordCallEWebhookReceipt(payload = {}) {
        const providerCallId = String(payload.provider_call_id || '').trim();
        const eventId = String(payload.event_id || '').trim();
        const eventType = String(payload.event_type || '').trim();
        if (!/^call_[A-Za-z0-9_-]{1,190}$/.test(providerCallId) ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(eventId) ||
            !['call.completed', 'call.failed', 'call.canceled'].includes(eventType)) {
            throw new Error('CALL-E webhook receipt is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO call_e_webhook_receipts (provider_call_id, event_id, event_type)
                 VALUES (?, ?, ?)`,
                [providerCallId, eventId, eventType],
                function (err) { if (err) return reject(err); resolve({ saved: this.changes > 0 }); },
            );
        });
    }

    async getCallEReconciliationState(providerCallId) {
        const id = String(providerCallId || '').trim();
        if (!/^call_[A-Za-z0-9_-]{1,190}$/.test(id)) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT event_cursor, last_event_id, seen_event_ids_json, ivr_dtmf_observed FROM call_e_reconciliation WHERE provider_call_id = ?`,
                [id],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    let seenEventIds = [];
                    try { seenEventIds = JSON.parse(row.seen_event_ids_json || '[]'); } catch (_) {}
                    resolve({ nextCursor: row.event_cursor || null, lastEventId: row.last_event_id || null, seenEventIds: Array.isArray(seenEventIds) ? seenEventIds : [], ivrDtmfObserved: row.ivr_dtmf_observed === 1 });
                },
            );
        });
    }

    async saveCallEReconciliationState(providerCallId, state = {}) {
        const id = String(providerCallId || '').trim();
        const cursor = state.nextCursor == null ? null : String(state.nextCursor);
        const lastEventId = state.lastEventId == null ? null : String(state.lastEventId);
        const seen = Array.isArray(state.seenEventIds) ? state.seenEventIds : [];
        if (!/^call_[A-Za-z0-9_-]{1,190}$/.test(id) ||
            (cursor && cursor.length > 512) || (lastEventId && lastEventId.length > 200) || seen.length > 500 ||
            seen.some((eventId) => typeof eventId !== 'string' || eventId.length > 200)) {
            throw new Error('CALL-E reconciliation cursor is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE call_e_reconciliation SET event_cursor = ?, last_event_id = ?, seen_event_ids_json = ?, ivr_dtmf_observed = ?, updated_at = CURRENT_TIMESTAMP WHERE provider_call_id = ?`,
                [cursor, lastEventId, JSON.stringify(seen), state.ivrDtmfObserved === true ? 1 : 0, id],
                function (err) { if (err) return reject(err); resolve({ saved: this.changes > 0 }); },
            );
        });
    }

    async updateCallEReconciliationSnapshot(localCallId, snapshot = {}) {
        const id = String(localCallId || '').trim();
        if (!/^call_e_[0-9a-f-]{36}$/i.test(id)) throw new Error('CALL-E local call ID is invalid');
        const allowedStatus = new Set(['queued', 'in_progress', 'completed', 'failed', 'canceled']);
        const allowedOutcome = new Set(['completed', 'no_answer', 'busy', 'declined']);
        const allowedResultStatus = new Set(['pending', 'available', 'unavailable', 'not_applicable']);
        if (!allowedStatus.has(snapshot.execution_status) ||
            !(snapshot.call_outcome == null || allowedOutcome.has(snapshot.call_outcome)) ||
            !allowedResultStatus.has(snapshot.result_status)) throw new Error('CALL-E lifecycle snapshot is invalid');
        const errorCode = typeof snapshot.error_code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(snapshot.error_code)
            ? snapshot.error_code : null;
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE call_e_reconciliation SET execution_status = ?, call_outcome = ?, result_status = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE local_call_id = ?`,
                [snapshot.execution_status, snapshot.call_outcome || null, snapshot.result_status, errorCode, id],
                function (err) { if (err) return reject(err); resolve({ saved: this.changes > 0 }); },
            );
        });
    }

    async getOutboundCallIdempotency(idempotency_key) {
        const key = String(idempotency_key || '').trim();
        if (!key) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT *
                FROM outbound_call_idempotency
                WHERE idempotency_key = ?
                LIMIT 1
            `;
            this.db.get(sql, [key], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async upsertCartesiaCallRecord(payload = {}) {
        const localCallId = String(payload.local_call_id || '').trim();
        const providerCallId = String(payload.provider_call_id || '').trim();
        const businessId = String(payload.business_id || '').trim() || null;
        const agentId = String(payload.agent_id || '').trim();
        const fromNumberId = String(payload.from_number_id || '').trim() || null;
        const phoneNumber = String(payload.phone_number || '').trim() || null;
        const direction = String(payload.direction || '').trim().toLowerCase() || null;
        const status = String(payload.status || '').trim().toLowerCase();
        const startTime = String(payload.start_time || '').trim() || null;
        const endTime = String(payload.end_time || '').trim() || null;
        const endReason = String(payload.end_reason || '').trim().slice(0, 100) || null;
        const accountType = String(payload.telephony_account_type || '').trim().toLowerCase() || null;
        const eventTimestamp = String(payload.event_timestamp || new Date().toISOString()).trim();
        if (!/^cartesia_[A-Za-z0-9_-]{1,200}$/.test(localCallId) ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(agentId) ||
            (businessId && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) ||
            (direction && !['inbound', 'outbound'].includes(direction)) ||
            !['created', 'started', 'completed', 'failed'].includes(status) ||
            (accountType && !['cartesia', 'twilio', 'sip_trunk'].includes(accountType)) ||
            !Number.isFinite(Date.parse(eventTimestamp))) {
            throw new Error('Cartesia call record is invalid');
        }
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO cartesia_calls (
                    local_call_id, provider_call_id, business_id, agent_id,
                    from_number_id, phone_number, direction, status,
                    start_time, end_time, end_reason, telephony_account_type,
                    last_event_timestamp, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(provider_call_id) DO UPDATE SET
                    business_id = COALESCE(cartesia_calls.business_id, excluded.business_id),
                    agent_id = excluded.agent_id,
                    from_number_id = COALESCE(cartesia_calls.from_number_id, excluded.from_number_id),
                    phone_number = COALESCE(cartesia_calls.phone_number, excluded.phone_number),
                    direction = COALESCE(cartesia_calls.direction, excluded.direction),
                    status = CASE
                        WHEN cartesia_calls.status IN ('completed', 'failed') THEN cartesia_calls.status
                        WHEN cartesia_calls.last_event_timestamp IS NOT NULL
                          AND excluded.last_event_timestamp < cartesia_calls.last_event_timestamp
                        THEN cartesia_calls.status
                        ELSE excluded.status
                    END,
                    start_time = COALESCE(cartesia_calls.start_time, excluded.start_time),
                    end_time = COALESCE(excluded.end_time, cartesia_calls.end_time),
                    end_reason = COALESCE(excluded.end_reason, cartesia_calls.end_reason),
                    telephony_account_type = COALESCE(cartesia_calls.telephony_account_type, excluded.telephony_account_type),
                    last_event_timestamp = MAX(cartesia_calls.last_event_timestamp, excluded.last_event_timestamp),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(sql, [
                localCallId, providerCallId, businessId, agentId, fromNumberId,
                phoneNumber, direction, status, startTime, endTime, endReason,
                accountType, eventTimestamp,
            ], function (err) {
                if (err) return reject(err);
                resolve({ saved: this.changes > 0 });
            });
        });
    }

    async upsertCartesiaCallBatchSnapshot(payload = {}) {
        const batchId = String(payload.provider_batch_id || '').trim();
        const businessId = String(payload.business_id || '').trim();
        const name = String(payload.name || '').trim();
        const agentId = String(payload.agent_id || '').trim();
        const fromNumberId = String(payload.from_number_id || '').trim();
        const status = String(payload.status || '').trim().toLowerCase();
        const fingerprint = String(payload.request_fingerprint || '').trim().toLowerCase();
        const rawSnapshotAt = String(payload.provider_updated_at || '').trim();
        const snapshotAt = Number.isFinite(Date.parse(rawSnapshotAt)) ? new Date(Date.parse(rawSnapshotAt)).toISOString() : '';
        const snapshotSyncedAt = new Date().toISOString();
        const counts = ['total_calls_scheduled', 'total_calls_dispatched', 'total_calls_finished', 'retry_count']
            .map((key) => Number(payload[key]));
        const expectedRecipients = Array.isArray(payload.expected_recipients) ? payload.expected_recipients : [];
        const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !name || name.length > 120 || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(fromNumberId) ||
            !['pending', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status) ||
            counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
            !/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isFinite(Date.parse(snapshotAt)) ||
            expectedRecipients.length > 5000 || recipients.length > 10000) {
            throw new Error('Cartesia batch snapshot is invalid');
        }
        const normalizedExpected = expectedRecipients.map((recipient) => String(recipient?.to_number || recipient || '').trim());
        if (normalizedExpected.some((number) => !/^\+[1-9]\d{7,14}$/.test(number))) {
            throw new Error('Cartesia batch recipient seed is invalid');
        }
        const normalizedRecipients = recipients.map((recipient, index) => {
            const phoneNumber = String(recipient?.to_number || '').trim();
            const recipientId = String(recipient?.id || '').trim();
            const callId = String(recipient?.agent_call_id || '').trim();
            const providerStatus = String(recipient?.status || '').trim();
            const createdAt = String(recipient?.created_at || '').trim();
            const endReason = String(recipient?.end_reason || '').trim();
            if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber) ||
                (recipientId && !/^[A-Za-z0-9_-]{1,200}$/.test(recipientId)) ||
                (callId && !/^[A-Za-z0-9_-]{1,200}$/.test(callId)) ||
                !providerStatus || providerStatus.length > 80 || !/^[A-Za-z0-9_-]+$/.test(providerStatus) ||
                (createdAt && !Number.isFinite(Date.parse(createdAt))) ||
                (endReason && (!/^[A-Za-z0-9_-]{1,100}$/.test(endReason)))) {
                throw new Error('Cartesia batch recipient snapshot is invalid');
            }
            const fallbackHash = crypto.createHash('sha256')
                .update(`${index}:${phoneNumber}:${createdAt}`).digest('hex');
            return {
                phoneNumber,
                recipientId: recipientId || null,
                attemptKey: recipientId ? `provider:${recipientId}` : `derived:${fallbackHash}`,
                providerStatus,
                callId: callId || null,
                endReason: endReason || null,
                hasError: recipient?.has_provider_error === true,
                createdAt: createdAt || null,
            };
        });

        const current = await new Promise((resolve, reject) => {
            this.db.get('SELECT business_id, request_fingerprint FROM cartesia_call_batches WHERE provider_batch_id = ?', [batchId], (error, row) => {
                if (error) return reject(error);
                resolve(row || null);
            });
        });
        if (current && (current.business_id !== businessId || current.request_fingerprint !== fingerprint)) {
            throw new Error('Cartesia batch tenant or request fingerprint conflict');
        }
        await new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_call_batches (
                    provider_batch_id, business_id, name, agent_id, from_number_id, region,
                    target_concurrency_limit, status, total_calls_scheduled, total_calls_dispatched,
                    total_calls_finished, retry_count, provider_created_at, scheduled_at, admitted_at,
                    provider_updated_at, last_synced_at, request_fingerprint, reconcile_next_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(provider_batch_id) DO UPDATE SET
                    name = excluded.name,
                    agent_id = excluded.agent_id,
                    from_number_id = excluded.from_number_id,
                    region = excluded.region,
                    target_concurrency_limit = excluded.target_concurrency_limit,
                    status = excluded.status,
                    total_calls_scheduled = excluded.total_calls_scheduled,
                    total_calls_dispatched = excluded.total_calls_dispatched,
                    total_calls_finished = excluded.total_calls_finished,
                    retry_count = excluded.retry_count,
                    provider_created_at = COALESCE(excluded.provider_created_at, cartesia_call_batches.provider_created_at),
                    scheduled_at = excluded.scheduled_at,
                    admitted_at = excluded.admitted_at,
                    provider_updated_at = excluded.provider_updated_at,
                    last_synced_at = excluded.last_synced_at,
                    reconcile_next_at = CASE
                        WHEN excluded.status IN ('completed', 'failed', 'cancelled') THEN NULL
                        ELSE COALESCE(cartesia_call_batches.reconcile_next_at, excluded.reconcile_next_at)
                    END,
                    reconcile_last_error_code = CASE
                        WHEN excluded.status IN ('completed', 'failed', 'cancelled') THEN NULL
                        ELSE cartesia_call_batches.reconcile_last_error_code
                    END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE excluded.provider_updated_at >= cartesia_call_batches.provider_updated_at
            `, [
                batchId, businessId, name, agentId, fromNumberId, payload.region || null,
                Number.isSafeInteger(Number(payload.target_concurrency_limit)) ? Number(payload.target_concurrency_limit) : null,
                status, ...counts, payload.provider_created_at || null, payload.scheduled_at || null,
                payload.admitted_at || null, snapshotAt, snapshotSyncedAt, fingerprint,
                ['completed', 'failed', 'cancelled'].includes(status) ? null : snapshotSyncedAt,
            ], (error) => error ? reject(error) : resolve());
        });

        for (const phoneNumber of normalizedExpected) {
            const seedKey = `submitted:${crypto.createHash('sha256').update(phoneNumber).digest('hex')}`;
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO cartesia_call_batch_recipients (
                        provider_batch_id, attempt_key, phone_number, local_state
                    ) SELECT ?, ?, ?, 'awaiting_provider_snapshot'
                    WHERE NOT EXISTS (
                        SELECT 1 FROM cartesia_call_batch_recipients
                        WHERE provider_batch_id = ? AND phone_number = ?
                    )
                `, [batchId, seedKey, phoneNumber, batchId, phoneNumber], (error) => error ? reject(error) : resolve());
            });
        }

        const knownRows = await new Promise((resolve, reject) => {
            this.db.all('SELECT phone_number FROM cartesia_call_batch_recipients WHERE provider_batch_id = ?', [batchId], (error, rows) => {
                if (error) return reject(error);
                resolve(rows || []);
            });
        });
        const knownNumbers = new Set(knownRows.map((row) => row.phone_number));
        if (normalizedRecipients.some((recipient) => !knownNumbers.has(recipient.phoneNumber))) {
            throw new Error('Cartesia batch snapshot contains an unknown recipient');
        }

        for (const recipient of normalizedRecipients) {
            const existingAttempt = await new Promise((resolve, reject) => {
                this.db.get(`
                    SELECT id, snapshot_updated_at FROM cartesia_call_batch_recipients
                    WHERE provider_batch_id = ? AND attempt_key = ?
                `, [batchId, recipient.attemptKey], (error, row) => error ? reject(error) : resolve(row || null));
            });
            if (existingAttempt && existingAttempt.snapshot_updated_at && snapshotAt < existingAttempt.snapshot_updated_at) continue;
            let placeholder = existingAttempt;
            if (!placeholder && recipient.recipientId) {
                placeholder = await new Promise((resolve, reject) => {
                    this.db.get(`
                        SELECT id, snapshot_updated_at FROM cartesia_call_batch_recipients
                        WHERE provider_batch_id = ? AND phone_number = ?
                          AND local_state = 'awaiting_provider_snapshot' AND provider_recipient_id IS NULL
                        ORDER BY id LIMIT 1
                    `, [batchId, recipient.phoneNumber], (error, row) => error ? reject(error) : resolve(row || null));
                });
            }
            if (placeholder) {
                await new Promise((resolve, reject) => {
                    this.db.run(`
                        UPDATE cartesia_call_batch_recipients SET attempt_key = ?, provider_recipient_id = ?,
                            provider_status = ?, provider_call_id = ?, end_reason = ?, has_provider_error = ?,
                            local_state = 'provider_snapshot', provider_created_at = ?, snapshot_updated_at = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND (snapshot_updated_at IS NULL OR snapshot_updated_at <= ?)
                    `, [recipient.attemptKey, recipient.recipientId, recipient.providerStatus, recipient.callId,
                        recipient.endReason, recipient.hasError ? 1 : 0, recipient.createdAt, snapshotAt, placeholder.id, snapshotAt],
                    (error) => error ? reject(error) : resolve());
                });
            } else {
                await new Promise((resolve, reject) => {
                    this.db.run(`
                        INSERT INTO cartesia_call_batch_recipients (
                            provider_batch_id, attempt_key, provider_recipient_id, phone_number,
                            provider_status, provider_call_id, end_reason, has_provider_error,
                            local_state, provider_created_at, snapshot_updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provider_snapshot', ?, ?)
                        ON CONFLICT(provider_batch_id, attempt_key) DO UPDATE SET
                            provider_recipient_id = excluded.provider_recipient_id,
                            phone_number = excluded.phone_number,
                            provider_status = excluded.provider_status,
                            provider_call_id = excluded.provider_call_id,
                            end_reason = excluded.end_reason,
                            has_provider_error = excluded.has_provider_error,
                            local_state = 'provider_snapshot',
                            provider_created_at = excluded.provider_created_at,
                            snapshot_updated_at = excluded.snapshot_updated_at,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE excluded.snapshot_updated_at >= cartesia_call_batch_recipients.snapshot_updated_at
                    `, [batchId, recipient.attemptKey, recipient.recipientId, recipient.phoneNumber,
                        recipient.providerStatus, recipient.callId, recipient.endReason, recipient.hasError ? 1 : 0,
                        recipient.createdAt, snapshotAt], (error) => error ? reject(error) : resolve());
                });
            }
        }
        return { saved: true, recipientCount: normalizedRecipients.length };
    }

    async getCartesiaCallBatch(providerBatchId, businessId = undefined) {
        const batchId = String(providerBatchId || '').trim();
        const normalizedBusinessId = businessId === undefined ? null : String(businessId || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) ||
            (normalizedBusinessId !== null && !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId))) {
            throw new Error('Cartesia batch ID is invalid');
        }
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM cartesia_call_batches WHERE provider_batch_id = ?${normalizedBusinessId === null ? '' : ' AND business_id = ?'} LIMIT 1`;
            this.db.get(sql, normalizedBusinessId === null ? [batchId] : [batchId, normalizedBusinessId], (error, row) => error ? reject(error) : resolve(row || null));
        });
    }

    async listCartesiaCallBatchRecipients(providerBatchId, businessId = undefined) {
        const batchId = String(providerBatchId || '').trim();
        const normalizedBusinessId = businessId === undefined ? null : String(businessId || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) ||
            (normalizedBusinessId !== null && !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId))) {
            throw new Error('Cartesia batch recipient query is invalid');
        }
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT r.provider_recipient_id, r.phone_number, r.provider_status, r.provider_call_id,
                       r.end_reason, r.has_provider_error, r.local_state, r.provider_created_at,
                       r.snapshot_updated_at
                FROM cartesia_call_batch_recipients r
                JOIN cartesia_call_batches b ON b.provider_batch_id = r.provider_batch_id
                WHERE r.provider_batch_id = ?${normalizedBusinessId === null ? '' : ' AND b.business_id = ?'}
                ORDER BY r.id ASC LIMIT 10000
            `;
            this.db.all(sql, normalizedBusinessId === null ? [batchId] : [batchId, normalizedBusinessId], (error, rows) => error ? reject(error) : resolve(rows || []));
        });
    }

    async recordCartesiaBatchRetentionAudit(event = {}) {
        const batchId = String(event.provider_batch_id || '').trim();
        const fingerprint = String(event.request_fingerprint || '').trim().toLowerCase();
        const outcome = String(event.outcome || '').trim();
        const reasonCode = /^[a-z][a-z0-9_]{0,79}$/.test(String(event.reason_code || '')) ? event.reason_code : null;
        const recipientCount = Number(event.recipient_count || 0);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[a-f0-9]{64}$/.test(fingerprint) ||
            !['requested', 'succeeded', 'failed'].includes(outcome) ||
            !Number.isSafeInteger(recipientCount) || recipientCount < 0 || recipientCount > 10000) {
            throw new Error('Cartesia batch retention audit event is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`INSERT INTO cartesia_batch_retention_audit (
                actor_type, actor_id, provider_batch_id, action, outcome,
                recipient_count, request_fingerprint, reason_code
            ) VALUES ('admin_api', 'shared_admin_token', ?, 'recipient_purge', ?, ?, ?, ?)`,
            [batchId, outcome, recipientCount, fingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ saved: true, id: this.lastID });
            });
        });
    }

    async deleteExpiredCartesiaBatchRecipients(payload = {}) {
        const batchId = String(payload.provider_batch_id || '').trim();
        const businessId = String(payload.business_id || '').trim();
        const status = String(payload.status || '').trim();
        const providerUpdatedAt = String(payload.provider_updated_at || '').trim();
        const expectedCount = Number(payload.expected_recipient_count);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
            !['completed', 'failed', 'cancelled'].includes(status) || !Number.isFinite(Date.parse(providerUpdatedAt)) ||
            !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 10000) {
            throw new Error('Cartesia batch retention purge is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM cartesia_call_batch_recipients
                WHERE provider_batch_id = ?
                  AND EXISTS (
                    SELECT 1 FROM cartesia_call_batches
                    WHERE provider_batch_id = ? AND business_id = ? AND status = ?
                      AND status IN ('completed', 'failed', 'cancelled') AND provider_updated_at = ?
                  )
                  AND (SELECT COUNT(*) FROM cartesia_call_batch_recipients WHERE provider_batch_id = ?) = ?`,
            [batchId, batchId, businessId, status, providerUpdatedAt, batchId, expectedCount], function (error) {
                if (error) return reject(error);
                if (this.changes !== expectedCount) {
                    const conflict = new Error('Cartesia batch changed since the retention preview');
                    conflict.code = 'cartesia_batch_retention_stale';
                    conflict.status = 409;
                    return reject(conflict);
                }
                resolve({ deletedCount: this.changes });
            });
        });
    }

    async listCartesiaCallBatches(businessId, limit = 25) {
        const normalizedBusinessId = String(businessId || '').trim();
        const normalizedLimit = Number(limit);
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId) ||
            !Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia business batch query is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT provider_batch_id, business_id, name, agent_id, from_number_id, region,
                       target_concurrency_limit, status, total_calls_scheduled, total_calls_dispatched,
                       total_calls_finished, retry_count, provider_created_at, scheduled_at, admitted_at,
                       provider_updated_at, last_synced_at, created_at, updated_at
                FROM cartesia_call_batches WHERE business_id = ?
                ORDER BY COALESCE(provider_created_at, created_at) DESC LIMIT ?
            `, [normalizedBusinessId, normalizedLimit], (error, rows) => error ? reject(error) : resolve(rows || []));
        });
    }

    async claimCartesiaBatchReconciliation(payload = {}) {
        const token = String(payload.lease_token || '').trim();
        const now = String(payload.now || '').trim();
        const leaseUntil = String(payload.lease_until || '').trim();
        if (!/^[A-Za-z0-9_-]{16,100}$/.test(token) || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(leaseUntil))) {
            throw new Error('Cartesia batch reconciliation lease is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.get(`UPDATE cartesia_call_batches
                SET reconcile_lease_token = ?, reconcile_lease_until = ?, reconcile_next_at = NULL
                WHERE provider_batch_id = (
                    SELECT provider_batch_id FROM cartesia_call_batches
                    WHERE status IN ('pending', 'in_progress')
                      AND (reconcile_next_at IS NULL OR reconcile_next_at <= ?)
                      AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= ?)
                    ORDER BY COALESCE(reconcile_next_at, created_at) ASC, created_at ASC
                    LIMIT 1
                )
                  AND status IN ('pending', 'in_progress')
                  AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= ?)
                RETURNING provider_batch_id, business_id, reconcile_attempt_count`,
            [token, leaseUntil, now, now, now], (error, row) => error ? reject(error) : resolve(row || null));
        });
    }

    async completeCartesiaBatchReconciliation(providerBatchId, leaseToken, terminal, nextAttemptAt) {
        const batchId = String(providerBatchId || '').trim();
        const token = String(leaseToken || '').trim();
        const nextAt = nextAttemptAt === null ? null : String(nextAttemptAt || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9_-]{16,100}$/.test(token) ||
            (terminal !== true && !Number.isFinite(Date.parse(nextAt || '')))) {
            throw new Error('Cartesia batch reconciliation completion is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE cartesia_call_batches
                SET reconcile_lease_token = NULL, reconcile_lease_until = NULL,
                    reconcile_attempt_count = 0, reconcile_last_error_code = NULL,
                    reconcile_next_at = ?
                WHERE provider_batch_id = ? AND reconcile_lease_token = ?`,
            [terminal ? null : nextAt, batchId, token], function (error) {
                if (error) return reject(error);
                resolve({ updated: this.changes === 1 });
            });
        });
    }

    async renewCartesiaBatchReconciliationLease(providerBatchId, leaseToken, leaseUntil) {
        const batchId = String(providerBatchId || '').trim();
        const token = String(leaseToken || '').trim();
        const until = String(leaseUntil || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9_-]{16,100}$/.test(token) || !Number.isFinite(Date.parse(until))) {
            throw new Error('Cartesia batch reconciliation lease renewal is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE cartesia_call_batches SET reconcile_lease_until = ?
                WHERE provider_batch_id = ? AND reconcile_lease_token = ?`,
            [until, batchId, token], function (error) {
                if (error) return reject(error);
                resolve({ updated: this.changes === 1 });
            });
        });
    }

    async failCartesiaBatchReconciliation(payload = {}) {
        const batchId = String(payload.provider_batch_id || '').trim();
        const token = String(payload.lease_token || '').trim();
        const nextAt = payload.next_attempt_at === null ? null : String(payload.next_attempt_at || '').trim();
        const maxAttempts = Number(payload.max_attempts);
        const errorCode = /^[a-z][a-z0-9_]{0,79}$/.test(String(payload.error_code || '')) ? payload.error_code : 'cartesia_reconcile_failed';
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId) || !/^[A-Za-z0-9_-]{16,100}$/.test(token) ||
            !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20 ||
            (nextAt !== null && !Number.isFinite(Date.parse(nextAt)))) {
            throw new Error('Cartesia batch reconciliation failure is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE cartesia_call_batches
                SET reconcile_lease_token = NULL, reconcile_lease_until = NULL,
                    reconcile_attempt_count = reconcile_attempt_count + 1,
                    reconcile_next_at = CASE WHEN reconcile_attempt_count + 1 >= ? THEN NULL ELSE ? END,
                    reconcile_last_error_code = ?
                WHERE provider_batch_id = ? AND reconcile_lease_token = ?`,
            [maxAttempts, nextAt, errorCode, batchId, token], function (error) {
                if (error) return reject(error);
                resolve({ updated: this.changes === 1 });
            });
        });
    }

    async listCartesiaCallRecords(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 50) {
            throw new Error('Cartesia call record limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT local_call_id, provider_call_id, agent_id, from_number_id,
                       phone_number, direction, status, start_time, end_time,
                       end_reason, telephony_account_type, created_at, updated_at
                FROM cartesia_calls
                ORDER BY COALESCE(start_time, created_at) DESC, created_at DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async listCartesiaCallRecordsForBusiness(businessId, limit = 25) {
        const normalizedBusinessId = String(businessId || '').trim();
        const normalizedLimit = Number(limit);
        if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId) ||
            !Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 50) {
            throw new Error('Cartesia business call-record query is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT local_call_id, provider_call_id, agent_id, from_number_id,
                       phone_number, direction, status, start_time, end_time,
                       end_reason, telephony_account_type, created_at, updated_at
                FROM cartesia_calls
                WHERE business_id = ?
                ORDER BY COALESCE(start_time, created_at) DESC, created_at DESC
                LIMIT ?
            `, [normalizedBusinessId, normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async getCartesiaCallRecordByProviderId(providerCallId, businessId = undefined) {
        const normalizedId = String(providerCallId || '').trim();
        const normalizedBusinessId = businessId === undefined ? null : String(businessId || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(normalizedId) ||
            (normalizedBusinessId !== null && !/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedBusinessId))) {
            throw new Error('Cartesia provider call ID is invalid');
        }
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT local_call_id, provider_call_id, agent_id, direction, status,
                       start_time, end_time, end_reason, telephony_account_type, business_id
                FROM cartesia_calls
                WHERE provider_call_id = ?${normalizedBusinessId === null ? '' : ' AND business_id = ?'}
                LIMIT 1
            `;
            const params = normalizedBusinessId === null ? [normalizedId] : [normalizedId, normalizedBusinessId];
            this.db.get(sql, params, (error, row) => {
                if (error) return reject(error);
                resolve(row || null);
            });
        });
    }

    async recordCartesiaCallReviewAudit(input = {}) {
        const actorTelegramId = String(input.actor_telegram_id || '').trim();
        const businessId = input.business_id == null ? null : String(input.business_id || '').trim();
        const providerCallId = String(input.provider_call_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (!/^\d{1,20}$/.test(actorTelegramId) ||
            (businessId !== null && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ||
            !['allowed', 'denied', 'failed'].includes(outcome) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia call-review audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_call_review_audit (
                    actor_telegram_id, business_id, provider_call_id, outcome, reason_code
                ) VALUES (?, ?, ?, ?, ?)
            `, [actorTelegramId, businessId, providerCallId, outcome, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async listCartesiaCallReviewAudit(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia call-review audit limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, actor_telegram_id, business_id, provider_call_id,
                       outcome, reason_code, created_at
                FROM cartesia_call_review_audit
                ORDER BY id DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async recordCartesiaAdminActionAudit(input = {}) {
        const actorTelegramId = String(input.actor_telegram_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceType = String(input.resource_type || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const previousAgentId = input.previous_agent_id == null ? null : String(input.previous_agent_id || '').trim();
        const targetAgentId = input.target_agent_id == null ? null : String(input.target_agent_id || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (!/^\d{1,20}$/.test(actorTelegramId) ||
            action !== 'phone_agent_assignment' || resourceType !== 'phone_number' ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            (previousAgentId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(previousAgentId)) ||
            (targetAgentId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(targetAgentId)) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia admin-action audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_admin_action_audit (
                    actor_telegram_id, action, resource_type, resource_id, outcome,
                    previous_agent_id, target_agent_id, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [actorTelegramId, action, resourceType, resourceId, outcome,
                previousAgentId, targetAgentId, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async listCartesiaAdminActionAudit(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia admin-action audit limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, actor_telegram_id, action, resource_type, resource_id, outcome,
                       previous_agent_id, target_agent_id, reason_code, created_at
                FROM cartesia_admin_action_audit
                ORDER BY id DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async recordCartesiaPhoneNumberOperationAudit(input = {}) {
        const actorType = String(input.actor_type || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const targetAgentId = input.target_agent_id == null ? null : String(input.target_agent_id || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (!['admin_api', 'miniapp_user'].includes(actorType) ||
            (actorType === 'admin_api' && actorId !== 'shared_admin_token') ||
            (actorType === 'miniapp_user' && !/^\d{1,20}$/.test(actorId)) ||
            !['phone_agent_assignment', 'phone_number_import', 'phone_number_provision', 'phone_number_release'].includes(action) ||
            !/^[A-Za-z0-9._:-]{1,220}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            (targetAgentId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(targetAgentId)) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia phone-number operation audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_phone_number_operation_audit (
                    actor_type, actor_id, action, resource_id, outcome,
                    target_agent_id, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [actorType, actorId, action, resourceId, outcome, targetAgentId, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async listCartesiaPhoneNumberOperationAudit(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia phone-number operation audit limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, actor_type, actor_id, action, resource_id, outcome,
                       target_agent_id, reason_code, created_at
                FROM cartesia_phone_number_operation_audit
                ORDER BY id DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async recordCartesiaProviderOperationAudit(input = {}) {
        const actorType = String(input.actor_type || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (actorType !== 'admin_api' || actorId !== 'shared_admin_token' ||
            !['twilio_provider_create', 'twilio_provider_update', 'sip_provider_create', 'sip_provider_update', 'telephony_provider_delete'].includes(action) ||
            !/^[A-Za-z0-9._:-]{1,220}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia provider operation audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_provider_operation_audit (
                    actor_type, actor_id, action, resource_id, outcome, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [actorType, actorId, action, resourceId, outcome, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async listCartesiaProviderOperationAudit(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia provider operation audit limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, actor_type, actor_id, action, resource_id, outcome, reason_code, created_at
                FROM (
                    SELECT id, actor_type, actor_id, action, resource_id, outcome, reason_code, created_at
                    FROM cartesia_provider_operation_audit
                    UNION ALL
                    SELECT -id AS id, actor_type, actor_id, action, resource_id, outcome, reason_code, created_at
                    FROM cartesia_webhook_assignment_audit
                    UNION ALL
                    SELECT -1000000000 - id AS id, actor_type, actor_id, action, resource_id, outcome, reason_code, created_at
                    FROM cartesia_webhook_creation_audit
                )
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async recordCartesiaWebhookAssignmentAudit(input = {}) {
        const actorType = String(input.actor_type || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (actorType !== 'admin_api' || actorId !== 'shared_admin_token' || action !== 'agent_webhook_assignment' ||
            !/^agent:[A-Za-z0-9_-]{1,200}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia webhook assignment audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_webhook_assignment_audit (
                    actor_type, actor_id, action, resource_id, outcome, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [actorType, actorId, action, resourceId, outcome, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async recordCartesiaWebhookCreationAudit(input = {}) {
        const actorType = String(input.actor_type || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (actorType !== 'admin_api' || actorId !== 'shared_admin_token' || action !== 'webhook_create' ||
            !/^endpoint:[a-f0-9]{32}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia webhook creation audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_webhook_creation_audit (
                    actor_type, actor_id, action, resource_id, outcome, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [actorType, actorId, action, resourceId, outcome, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async recordCartesiaCallOperationAudit(input = {}) {
        const actorType = String(input.actor_type || '').trim();
        const actorId = String(input.actor_id || '').trim();
        const action = String(input.action || '').trim();
        const resourceId = String(input.resource_id || '').trim();
        const outcome = String(input.outcome || '').trim();
        const requestFingerprint = String(input.request_fingerprint || '').trim().toLowerCase();
        const reasonCode = input.reason_code == null ? null : String(input.reason_code || '').trim();
        if (actorType !== 'admin_api' || actorId !== 'shared_admin_token' ||
            !['outbound_call_dispatch', 'outbound_call_cancel'].includes(action) ||
            !/^[A-Za-z0-9._:-]{1,220}$/.test(resourceId) ||
            !['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(outcome) ||
            !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
            (reasonCode !== null && !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode))) {
            throw new Error('Cartesia call operation audit input is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO cartesia_call_operation_audit (
                    actor_type, actor_id, action, resource_id, outcome, request_fingerprint, reason_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [actorType, actorId, action, resourceId, outcome, requestFingerprint, reasonCode], function (error) {
                if (error) return reject(error);
                resolve({ id: this.lastID, recorded: true });
            });
        });
    }

    async listCartesiaCallOperationAudit(limit = 25) {
        const normalizedLimit = Number(limit);
        if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
            throw new Error('Cartesia call operation audit limit is invalid');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, actor_type, actor_id, action, resource_id, outcome, reason_code, created_at
                FROM cartesia_call_operation_audit
                ORDER BY id DESC
                LIMIT ?
            `, [normalizedLimit], (error, rows) => {
                if (error) return reject(error);
                resolve(Array.isArray(rows) ? rows : []);
            });
        });
    }

    async recordCartesiaWebhookEvent(payload = {}) {
        const eventId = String(payload.webhook_request_id || '').trim();
        const providerCallId = String(payload.provider_call_id || '').trim();
        const eventType = String(payload.event_type || '').trim();
        const eventTimestamp = String(payload.event_timestamp || '').trim();
        const payloadHash = String(payload.payload_hash || '').trim().toLowerCase();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId) ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ||
            !['call_started', 'call_completed', 'call_failed', 'call_turn', 'post_call_analysis'].includes(eventType) ||
            !Number.isFinite(Date.parse(eventTimestamp)) || !/^[a-f0-9]{64}$/.test(payloadHash)) {
            throw new Error('Cartesia webhook event receipt is invalid');
        }
        const existing = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT provider_call_id, event_type, payload_hash FROM cartesia_webhook_events WHERE webhook_request_id = ?',
                [eventId],
                (err, row) => err ? reject(err) : resolve(row || null),
            );
        });
        if (existing) {
            return {
                duplicate: existing.provider_call_id === providerCallId &&
                    existing.event_type === eventType && existing.payload_hash === payloadHash,
                conflict: existing.provider_call_id !== providerCallId ||
                    existing.event_type !== eventType || existing.payload_hash !== payloadHash,
            };
        }
        const database = this.db;
        return new Promise((resolve, reject) => {
            database.run(
                `INSERT OR IGNORE INTO cartesia_webhook_events (
                    webhook_request_id, provider_call_id, event_type, event_timestamp, payload_hash
                ) VALUES (?, ?, ?, ?, ?)`,
                [eventId, providerCallId, eventType, eventTimestamp, payloadHash],
                function (err) {
                    if (err) return reject(err);
                    if (this.changes > 0) {
                        resolve({ inserted: true, duplicate: false, conflict: false });
                        return;
                    }
                    database.get(
                        'SELECT provider_call_id, event_type, payload_hash FROM cartesia_webhook_events WHERE webhook_request_id = ?',
                        [eventId],
                        (readError, row) => {
                            if (readError) return reject(readError);
                            if (!row) return resolve({ inserted: false, duplicate: false, conflict: false });
                            const matches = row.provider_call_id === providerCallId &&
                                row.event_type === eventType && row.payload_hash === payloadHash;
                            resolve({ inserted: false, duplicate: matches, conflict: !matches });
                        },
                    );
                },
            );
        });
    }

    async getVapiOutboundCallByProviderId(providerCallId) {
        const callId = String(providerCallId || "").trim();
        if (!callId || callId.length > 200) return null;
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT provider, status, call_sid, request_hash, response_payload, created_at, updated_at
                 FROM outbound_call_idempotency
                 WHERE provider IN ('vapi', 'vapi_web') AND call_sid = ? AND status = 'completed'
                 ORDER BY updated_at DESC LIMIT 1`,
                [callId],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    let result = {};
                    try { result = JSON.parse(row.response_payload || "{}"); } catch (_) {}
                    resolve({
                        provider: row.provider,
                        provider_call_id: row.call_sid,
                        status: row.status,
                        template_id: Number(result.templateId) || null,
                        template_version: Number(result.templateVersion) || null,
                        mapping_id: Number(result.mappingId) || null,
                        created_at: row.created_at,
                        updated_at: row.updated_at,
                    });
                },
            );
        });
    }

    async completeOutboundCallIdempotency(payload = {}) {
        const idempotencyKey = String(payload.idempotency_key || '').trim();
        const provider = String(payload.provider || '').trim().toLowerCase();
        if (!idempotencyKey || !provider) return 0;
        const requestHash = String(payload.request_hash || '').trim() || null;
        const callSid = String(payload.call_sid || '').trim() || null;
        const status = ['pending', 'completed', 'failed'].includes(String(payload.status || '').toLowerCase())
            ? String(payload.status || '').toLowerCase()
            : 'failed';
        const responsePayload = payload.response_payload != null
            ? JSON.stringify(payload.response_payload)
            : null;
        const errorMessage = payload.error_message != null
            ? String(payload.error_message).trim() || null
            : null;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO outbound_call_idempotency (
                    idempotency_key, provider, business_id, request_hash, call_sid,
                    status, response_payload, error_message, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    provider = excluded.provider,
                    business_id = COALESCE(excluded.business_id, outbound_call_idempotency.business_id),
                    request_hash = COALESCE(excluded.request_hash, outbound_call_idempotency.request_hash),
                    call_sid = COALESCE(excluded.call_sid, outbound_call_idempotency.call_sid),
                    status = excluded.status,
                    response_payload = excluded.response_payload,
                    error_message = excluded.error_message,
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    idempotencyKey,
                    provider,
                    String(payload.business_id || '').trim() || null,
                    requestHash,
                    callSid,
                    status,
                    responsePayload,
                    errorMessage,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async reserveCallScriptMutationIdempotency(idempotencyKey, fingerprint) {
        const key = String(idempotencyKey || '').trim();
        const normalizedFingerprint = String(fingerprint || '').trim();
        if (!key || !normalizedFingerprint) {
            return { reserved: false, record: null };
        }
        const dbInstance = this;
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO call_script_mutation_idempotency (
                    idempotency_key, fingerprint, status, updated_at
                )
                VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
            `;
            this.db.run(sql, [key, normalizedFingerprint], function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                const reserved = (this.changes || 0) > 0;
                dbInstance
                    .getCallScriptMutationIdempotency(key)
                    .then((record) => resolve({ reserved, record }))
                    .catch(reject);
            });
        });
    }

    async getCallScriptMutationIdempotency(idempotencyKey) {
        const key = String(idempotencyKey || '').trim();
        if (!key) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT *
                FROM call_script_mutation_idempotency
                WHERE idempotency_key = ?
                LIMIT 1
            `;
            this.db.get(sql, [key], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async completeCallScriptMutationIdempotency(idempotencyKey, fingerprint, statusCode, body) {
        const key = String(idempotencyKey || '').trim();
        const normalizedFingerprint = String(fingerprint || '').trim();
        if (!key || !normalizedFingerprint) return 0;
        const responseStatus = Number.isFinite(Number(statusCode))
            ? Math.max(100, Math.floor(Number(statusCode)))
            : 200;
        const responseBody = body !== undefined ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO call_script_mutation_idempotency (
                    idempotency_key, fingerprint, status, response_status, response_body, updated_at
                )
                VALUES (?, ?, 'done', ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    fingerprint = excluded.fingerprint,
                    status = 'done',
                    response_status = excluded.response_status,
                    response_body = excluded.response_body,
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(sql, [key, normalizedFingerprint, responseStatus, responseBody], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async clearCallScriptMutationIdempotency(idempotencyKey) {
        const key = String(idempotencyKey || '').trim();
        if (!key) return 0;
        return new Promise((resolve, reject) => {
            const sql = `
                DELETE FROM call_script_mutation_idempotency
                WHERE idempotency_key = ?
            `;
            this.db.run(sql, [key], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async upsertVonageCallMapping(call_sid, vonage_uuid, source = null) {
        const callSid = String(call_sid || '').trim();
        const vonageUuid = String(vonage_uuid || '').trim();
        const mappingSource = String(source || '').trim() || null;
        if (!callSid || !vonageUuid) return 0;
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO vonage_call_mappings (
                    vonage_uuid, call_sid, source, updated_at
                )
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(vonage_uuid) DO UPDATE SET
                    call_sid = excluded.call_sid,
                    source = COALESCE(excluded.source, vonage_call_mappings.source),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(sql, [vonageUuid, callSid, mappingSource], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async getVonageCallSidByUuid(vonage_uuid) {
        const vonageUuid = String(vonage_uuid || '').trim();
        if (!vonageUuid) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT call_sid, vonage_uuid, source, created_at, updated_at
                FROM vonage_call_mappings
                WHERE vonage_uuid = ?
                LIMIT 1
            `;
            this.db.get(sql, [vonageUuid], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async listRecentVonageCallMappings(limit = 200) {
        const safeLimit = Number.isFinite(Number(limit))
            ? Math.max(1, Math.min(1000, Math.floor(Number(limit))))
            : 200;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT vonage_uuid, call_sid, source, created_at, updated_at
                FROM vonage_call_mappings
                ORDER BY updated_at DESC
                LIMIT ?
            `;
            this.db.all(sql, [safeLimit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCallRuntimeState(call_sid) {
        if (!call_sid) return null;
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT *
                FROM call_runtime_state
                WHERE call_sid = ?
                LIMIT 1
            `;
            this.db.get(sql, [call_sid], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async upsertCallRuntimeState(payload = {}) {
        const callSid = String(payload.call_sid || '').trim();
        if (!callSid) return 0;
        const interactionCount = Number(payload.interaction_count);
        const digitCaptureActive = payload.digit_capture_active ? 1 : 0;
        const snapshot = payload.snapshot != null
            ? JSON.stringify(payload.snapshot)
            : null;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO call_runtime_state (
                    call_sid,
                    provider,
                    interaction_count,
                    flow_state,
                    call_mode,
                    digit_capture_active,
                    snapshot,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(call_sid) DO UPDATE SET
                    provider = COALESCE(excluded.provider, call_runtime_state.provider),
                    interaction_count = COALESCE(excluded.interaction_count, call_runtime_state.interaction_count),
                    flow_state = COALESCE(excluded.flow_state, call_runtime_state.flow_state),
                    call_mode = COALESCE(excluded.call_mode, call_runtime_state.call_mode),
                    digit_capture_active = excluded.digit_capture_active,
                    snapshot = COALESCE(excluded.snapshot, call_runtime_state.snapshot),
                    updated_at = CURRENT_TIMESTAMP
            `;
            this.db.run(
                sql,
                [
                    callSid,
                    payload.provider || null,
                    Number.isFinite(interactionCount)
                        ? Math.max(0, Math.floor(interactionCount))
                        : 0,
                    payload.flow_state || null,
                    payload.call_mode || null,
                    digitCaptureActive,
                    snapshot,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async deleteCallRuntimeState(call_sid) {
        const callSid = String(call_sid || '').trim();
        if (!callSid) return 0;
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM call_runtime_state WHERE call_sid = ?',
                [callSid],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes || 0);
                    }
                }
            );
        });
    }

    async cleanupCallRuntimeState(hoursToKeep = 24) {
        const safeHours = Math.max(1, Number(hoursToKeep) || 24);
        return new Promise((resolve, reject) => {
            const sql = `
                DELETE FROM call_runtime_state
                WHERE updated_at < datetime('now', '-' || ? || ' hours')
            `;
            this.db.run(sql, [safeHours], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    async getLatestActiveCallForUserChatId(userChatId) {
        const normalizedUserChatId = String(userChatId || '').trim();
        if (!normalizedUserChatId) return null;
        const placeholders = CALL_ACTIVE_STATUSES.map(() => '?').join(', ');
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT
                    c.*,
                    crs.provider AS runtime_provider,
                    crs.interaction_count AS runtime_interaction_count,
                    crs.flow_state AS runtime_flow_state,
                    crs.call_mode AS runtime_call_mode,
                    crs.digit_capture_active AS runtime_digit_capture_active,
                    crs.snapshot AS runtime_snapshot,
                    crs.updated_at AS runtime_updated_at
                FROM calls c
                LEFT JOIN call_runtime_state crs ON crs.call_sid = c.call_sid
                WHERE TRIM(COALESCE(c.user_chat_id, '')) = ?
                  AND COALESCE(
                    NULLIF(REPLACE(LOWER(TRIM(c.status)), '_', '-'), ''),
                    NULLIF(REPLACE(LOWER(TRIM(c.twilio_status)), '_', '-'), '')
                  ) IN (${placeholders})
                ORDER BY datetime(COALESCE(crs.updated_at, c.updated_at, c.started_at, c.created_at)) DESC
                LIMIT 1
            `;
            this.db.get(sql, [normalizedUserChatId, ...CALL_ACTIVE_STATUSES], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    // NEW: Get recent calls with transcripts count (REQUIRED FOR API ENDPOINTS)
    async getRecentCalls(limitOrOptions = 10, offset = 0) {
        let limit = 10;
        let actualOffset = 0;
        let status = null;
        let direction = null;
        let search = null;
        let start = null;
        let end = null;

        if (typeof limitOrOptions === 'object' && limitOrOptions !== null) {
            limit = Number(limitOrOptions.limit ?? 10);
            actualOffset = Number(limitOrOptions.offset ?? 0);
            status = limitOrOptions.status ?? null;
            direction = limitOrOptions.direction ?? null;
            search = limitOrOptions.query ?? null;
            start = limitOrOptions.start ?? null;
            end = limitOrOptions.end ?? null;
        } else {
            limit = Number(limitOrOptions ?? 10);
            actualOffset = Number(offset ?? 0);
        }

        const where = [];
        const params = [];

        if (status) {
            const statuses = String(status)
                .split(',')
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean);
            if (statuses.length === 1) {
                where.push('LOWER(c.status) = ?');
                params.push(statuses[0]);
            } else if (statuses.length > 1) {
                where.push(`LOWER(c.status) IN (${statuses.map(() => '?').join(',')})`);
                params.push(...statuses);
            }
        }

        if (direction) {
            const directions = String(direction)
                .split(',')
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean);
            if (directions.length === 1) {
                where.push('LOWER(c.direction) = ?');
                params.push(directions[0]);
            } else if (directions.length > 1) {
                where.push(`LOWER(c.direction) IN (${directions.map(() => '?').join(',')})`);
                params.push(...directions);
            }
        }

        if (search) {
            const needle = `%${String(search).trim()}%`;
            where.push('(c.phone_number LIKE ? OR c.call_sid LIKE ?)');
            params.push(needle, needle);
        }

        if (start) {
            where.push('c.created_at >= ?');
            params.push(start);
        }

        if (end) {
            where.push('c.created_at <= ?');
            params.push(end);
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    c.*,
                    COUNT(t.id) as transcript_count
                FROM calls c
                LEFT JOIN transcripts t ON c.call_sid = t.call_sid
                ${whereClause}
                GROUP BY c.call_sid
                ORDER BY c.created_at DESC
                LIMIT ? OFFSET ?
            `;

            params.push(limit, actualOffset);
            this.db.all(query, params, (err, rows) => {
                if (err) {
                    console.error('Database error in getRecentCalls:', err);
                    reject(err);
                } else {
                    this.attachLatestCallDispositions(rows || [])
                        .then(resolve)
                        .catch(reject);
                }
            });
        });
    }

    // NEW: Get total calls count (REQUIRED FOR API ENDPOINTS)
    async getCallsCount() {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM calls', (err, row) => {
                if (err) {
                    console.error('Database error in getCallsCount:', err);
                    reject(err);
                } else {
                    resolve(row?.count || 0);
                }
            });
        });
    }

    async getRecentCallCountByNumber(number, hours = 24) {
        if (!number) return 0;
        const window = Math.max(1, Number(hours) || 24);
        const sql = `
            SELECT COUNT(*) as count
            FROM calls
            WHERE phone_number = ?
              AND created_at >= datetime('now', '-${window} hours')
        `;
        return new Promise((resolve, reject) => {
            this.db.get(sql, [number], (err, row) => {
                if (err) {
                    console.error('Database error in getRecentCallCountByNumber:', err);
                    reject(err);
                } else {
                    resolve(row?.count || 0);
                }
            });
        });
    }

    async getSetting(key) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT value FROM app_settings WHERE key = ?', [key], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row?.value ?? null);
                }
            });
        });
    }

    async setSetting(key, value) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO app_settings (key, value, updated_at)
                VALUES (?, ?, datetime('now'))
            `);
            stmt.run([key, value], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
            stmt.finalize();
        });
    }

    async tableExists(tableName) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
                [tableName],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(Boolean(row?.name));
                    }
                }
            );
        });
    }

    async indexExists(indexName) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
                [indexName],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(Boolean(row?.name));
                    }
                }
            );
        });
    }

    async ensureSchemaGuardrails(options = {}) {
        const expectedVersion = Math.max(1, Number(options.expectedVersion) || 1);
        const strict = options.strict !== false;
        const requiredTables = Array.isArray(options.requiredTables) ? options.requiredTables : [];
        const requiredIndexes = Array.isArray(options.requiredIndexes) ? options.requiredIndexes : [];
        const rawVersion = await this.getSetting('schema_version');
        let currentVersion = Number.parseInt(rawVersion, 10);
        if (!Number.isFinite(currentVersion)) {
            currentVersion = 0;
        }

        if (currentVersion > expectedVersion) {
            const error = new Error(`Database schema version ${currentVersion} is newer than supported ${expectedVersion}`);
            if (strict) throw error;
            console.warn(error.message);
        } else if (currentVersion < expectedVersion) {
            await this.setSetting('schema_version', String(expectedVersion));
            currentVersion = expectedVersion;
        }

        const missingTables = [];
        for (const tableName of requiredTables) {
            if (!tableName) continue;
            const exists = await this.tableExists(tableName);
            if (!exists) missingTables.push(tableName);
        }

        const missingIndexes = [];
        for (const indexName of requiredIndexes) {
            if (!indexName) continue;
            const exists = await this.indexExists(indexName);
            if (!exists) missingIndexes.push(indexName);
        }

        if (missingTables.length || missingIndexes.length) {
            const error = new Error(
                `Database schema artifacts missing. tables=${missingTables.join(',') || 'none'} indexes=${missingIndexes.join(',') || 'none'}`
            );
            if (strict) throw error;
            console.warn(error.message);
        }

        return {
            schema_version: currentVersion,
            expected_version: expectedVersion,
            strict,
            missing_tables: missingTables,
            missing_indexes: missingIndexes,
            ok: missingTables.length === 0 && missingIndexes.length === 0
        };
    }

    // Enhanced webhook notification creation with priority
    async createEnhancedWebhookNotification(call_sid, notification_type, telegram_chat_id, priority = 'normal') {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO webhook_notifications (call_sid, notification_type, telegram_chat_id, priority, retry_count)
                VALUES (?, ?, ?, ?, 0)
            `);
            
            stmt.run([call_sid, notification_type, telegram_chat_id, priority], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    // Backward compatibility method
    async createWebhookNotification(call_sid, notification_type, telegram_chat_id) {
        return this.createEnhancedWebhookNotification(call_sid, notification_type, telegram_chat_id, 'normal');
    }

    // Enhanced webhook notification update with delivery metrics
    async updateEnhancedWebhookNotification(id, status, error_message = null, telegram_message_id = null, options = {}) {
        return new Promise((resolve, reject) => {
            const sent_at = status === 'sent' ? new Date().toISOString() : null;
            const last_attempt_at = options.lastAttemptAt || new Date().toISOString();
            const next_attempt_at = options.nextAttemptAt || null;
            
            // Calculate delivery time if we're marking as sent
            if (status === 'sent') {
                this.db.get('SELECT created_at FROM webhook_notifications WHERE id = ?', [id], (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    let delivery_time_ms = null;
                    if (row) {
                        const created = new Date(row.created_at);
                        delivery_time_ms = new Date() - created;
                    }
                    
                    const stmt = this.db.prepare(`
                        UPDATE webhook_notifications 
                        SET status = ?, error_message = ?, sent_at = ?, 
                            telegram_message_id = ?, delivery_time_ms = ?, 
                            last_attempt_at = ?, next_attempt_at = ?
                        WHERE id = ?
                    `);
                    
                    stmt.run([status, error_message, sent_at, telegram_message_id, delivery_time_ms, last_attempt_at, null, id], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this.changes);
                        }
                    });
                    stmt.finalize();
                });
            } else {
                const stmt = this.db.prepare(`
                    UPDATE webhook_notifications 
                    SET status = ?, error_message = ?, retry_count = retry_count + 1,
                        last_attempt_at = ?, next_attempt_at = ?
                    WHERE id = ?
                `);
                
                stmt.run([status, error_message, last_attempt_at, next_attempt_at, id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                });
                stmt.finalize();
            }
        });
    }

    // Backward compatibility method
    async updateWebhookNotification(id, status, error_message = null) {
        return this.updateEnhancedWebhookNotification(id, status, error_message, null);
    }

    // Enhanced pending notifications with priority and retry logic
    async getEnhancedPendingWebhookNotifications(limit = 50, maxRetries = 3) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    wn.*,
                    c.phone_number, 
                    c.call_summary, 
                    c.ai_analysis,
                    c.status as call_status,
                    c.duration as call_duration,
                    c.twilio_status
                FROM webhook_notifications wn
                JOIN calls c ON wn.call_sid = c.call_sid
                WHERE wn.status IN ('pending', 'retrying')
                    AND wn.retry_count < ?
                    AND (wn.next_attempt_at IS NULL OR wn.next_attempt_at <= datetime('now'))
                ORDER BY 
                    CASE wn.priority
                        WHEN 'urgent' THEN 1
                        WHEN 'high' THEN 2
                        WHEN 'normal' THEN 3
                        WHEN 'low' THEN 4
                        ELSE 5
                    END,
                    CASE wn.notification_type
                        WHEN 'call_failed' THEN 1
                        WHEN 'call_completed' THEN 2
                        WHEN 'call_transcript' THEN 3
                        ELSE 4
                    END,
                    wn.created_at ASC
                LIMIT ?
            `;
            
            this.db.all(sql, [maxRetries, limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    // Backward compatibility method
    async getPendingWebhookNotifications() {
        return this.getEnhancedPendingWebhookNotifications(50);
    }

    // FIXED: Enhanced notification metrics logging - Using INSERT OR REPLACE instead of ON CONFLICT
    async logNotificationMetric(notification_type, success, delivery_time_ms = null) {
        const today = new Date().toISOString().split('T')[0];
        
        return new Promise((resolve, reject) => {
            // First try to get existing record
            this.db.get(
                'SELECT * FROM notification_metrics WHERE date = ? AND notification_type = ?',
                [today, notification_type],
                (err, existingRow) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const success_increment = success ? 1 : 0;
                    const failure_increment = success ? 0 : 1;
                    const delivery_time = delivery_time_ms || 0;

                    if (existingRow) {
                        // Update existing record
                        const new_total = existingRow.total_count + 1;
                        const new_success = existingRow.success_count + success_increment;
                        const new_failure = existingRow.failure_count + failure_increment;
                        const new_avg_delivery = ((existingRow.avg_delivery_time_ms * existingRow.total_count) + delivery_time) / new_total;

                        const stmt = this.db.prepare(`
                            UPDATE notification_metrics 
                            SET total_count = ?, success_count = ?, failure_count = ?, 
                                avg_delivery_time_ms = ?, updated_at = datetime('now')
                            WHERE id = ?
                        `);
                        
                        stmt.run([new_total, new_success, new_failure, new_avg_delivery, existingRow.id], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.changes);
                            }
                        });
                        stmt.finalize();
                    } else {
                        // Insert new record
                        const stmt = this.db.prepare(`
                            INSERT INTO notification_metrics 
                            (date, notification_type, total_count, success_count, failure_count, avg_delivery_time_ms)
                            VALUES (?, ?, 1, ?, ?, ?)
                        `);
                        
                        stmt.run([today, notification_type, success_increment, failure_increment, delivery_time], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.lastID);
                            }
                        });
                        stmt.finalize();
                    }
                }
            );
        });
    }

    // Enhanced service health logging
    async logServiceHealth(service_name, status, details = null) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO service_health_logs (service_name, status, details)
                VALUES (?, ?, ?)
            `);
            
            stmt.run([service_name, status, JSON.stringify(details)], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async logProviderDiagnosticsSnapshot(entries = []) {
        const safeEntries = (Array.isArray(entries) ? entries : []).filter((entry) =>
            ['twilio', 'plivo', 'vonage'].includes(String(entry?.provider || '').toLowerCase()));
        for (const entry of safeEntries) {
            const details = {
                provider: String(entry.provider).toLowerCase(), ready: entry.ready === true,
                circuit_state: ['closed', 'open', 'half_open'].includes(entry.circuit_state) ? entry.circuit_state : 'unknown',
                score: Math.max(0, Math.min(100, Math.floor(Number(entry.score) || 0))),
                reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(entry.reason_code || '')) ? String(entry.reason_code) : null,
            };
            await this.logServiceHealth('provider_diagnostics', details.circuit_state, details);
        }
        return safeEntries.length;
    }

    async listProviderDiagnosticsHistory(limit = 50) {
        const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        const rows = await new Promise((resolve, reject) => this.db.all(
            `SELECT id, status, details, timestamp FROM service_health_logs
             WHERE service_name = 'provider_diagnostics' ORDER BY id DESC LIMIT ?`,
            [safeLimit], (error, result) => error ? reject(error) : resolve(result || [])));
        return rows.map((row) => {
            let details = {};
            try { details = JSON.parse(row.details || '{}'); } catch (_) {}
            return { id: Number(row.id), provider: ['twilio', 'plivo', 'vonage'].includes(details.provider) ? details.provider : 'unknown',
                status: ['closed', 'open', 'half_open'].includes(row.status) ? row.status : 'unknown',
                ready: details.ready === true, score: Math.max(0, Math.min(100, Math.floor(Number(details.score) || 0))),
                reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(details.reason_code || '')) ? details.reason_code : null,
                recorded_at: row.timestamp };
        });
    }

    // Call metrics tracking
    async addCallMetric(call_sid, metric_type, metric_value, metric_data = null) {
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO call_metrics (call_sid, metric_type, metric_value, metric_data)
                VALUES (?, ?, ?, ?)
            `);
            
            stmt.run([call_sid, metric_type, metric_value, JSON.stringify(metric_data)], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async createCallJob(job_type, payload = {}, run_at = null) {
        const scheduled = run_at || new Date().toISOString();
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO call_jobs (job_type, payload, run_at)
                VALUES (?, ?, ?)
            `);
            stmt.run([job_type, JSON.stringify(payload || {}), scheduled], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            stmt.finalize();
        });
    }

    async getCallJob(job_id) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM call_jobs WHERE id = ?`;
            this.db.get(sql, [job_id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async listCallJobs({ job_type = null, status = null, limit = 20 } = {}) {
        const clauses = [];
        const params = [];
        if (job_type) {
            clauses.push('job_type = ?');
            params.push(job_type);
        }
        if (status) {
            clauses.push('status = ?');
            params.push(status);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const sql = `
            SELECT * FROM call_jobs
            ${where}
            ORDER BY run_at ASC
            LIMIT ?
        `;
        params.push(Math.min(100, Math.max(1, Number(limit) || 20)));
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async claimDueCallJobs(limit = 10) {
        const now = new Date().toISOString();
        const rows = await new Promise((resolve, reject) => {
            const sql = `
                SELECT * FROM call_jobs
                WHERE status = 'pending' AND run_at <= ?
                ORDER BY run_at ASC
                LIMIT ?
            `;
            this.db.all(sql, [now, limit], (err, result) => {
                if (err) reject(err);
                else resolve(result || []);
            });
        });

        const claimed = [];
        for (const row of rows) {
            const updated = await new Promise((resolve, reject) => {
                const sql = `
                    UPDATE call_jobs
                    SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
                    WHERE id = ? AND status = 'pending'
                `;
                this.db.run(sql, [now, now, row.id], function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                });
            });
            if (updated) {
                claimed.push({ ...row, attempts: (row.attempts || 0) + 1 });
            }
        }
        return claimed;
    }

    async rescheduleCallJob(job_id, run_at, error = null) {
        const updatedAt = new Date().toISOString();
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE call_jobs
                SET status = 'pending',
                    run_at = ?,
                    last_error = ?,
                    updated_at = ?,
                    locked_at = NULL
                WHERE id = ?
            `;
            this.db.run(sql, [run_at, error, updatedAt, job_id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async completeCallJob(job_id, status = 'completed', error = null) {
        const updatedAt = new Date().toISOString();
        const completedAt = (status === 'completed' || status === 'failed') ? updatedAt : null;
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE call_jobs
                SET status = ?,
                    last_error = ?,
                    updated_at = ?,
                    completed_at = COALESCE(?, completed_at),
                    locked_at = NULL
                WHERE id = ?
            `;
            this.db.run(sql, [status, error, updatedAt, completedAt, job_id], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    async createReviewCase(reviewCase = {}) {
        const status = String(reviewCase?.status || 'open').trim().toLowerCase() || 'open';
        const metadata = reviewCase?.metadata && typeof reviewCase.metadata === 'object'
            ? JSON.stringify(reviewCase.metadata)
            : null;
        const reviewCaseId = await new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO review_cases (
                    call_sid,
                    phone_number,
                    requested_action,
                    reason,
                    notes,
                    source,
                    status,
                    created_by,
                    metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                [
                    reviewCase?.call_sid || null,
                    reviewCase?.phone_number || null,
                    reviewCase?.requested_action || null,
                    reviewCase?.reason || null,
                    reviewCase?.notes || null,
                    reviewCase?.source || 'api',
                    status,
                    reviewCase?.created_by || null,
                    metadata,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
            stmt.finalize();
        });
        if (reviewCase?.call_sid) {
            await this.markCallOutcomeAction(reviewCase.call_sid, 'review_case');
        }
        return reviewCaseId;
    }

    async getReviewCase(review_case_id) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM review_cases WHERE id = ?`;
            this.db.get(sql, [review_case_id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async listReviewCases({ status = null, limit = 20 } = {}) {
        const clauses = [];
        const params = [];
        if (status) {
            clauses.push('status = ?');
            params.push(status);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const sql = `
            SELECT * FROM review_cases
            ${where}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        `;
        params.push(Math.min(100, Math.max(1, Number(limit) || 20)));
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async updateReviewCaseStatus(review_case_id, status, updates = {}) {
        const normalizedStatus = String(status || '').trim().toLowerCase();
        const updatedAt = new Date().toISOString();
        const metadata = updates?.metadata && typeof updates.metadata === 'object'
            ? JSON.stringify(updates.metadata)
            : undefined;
        const resolvedAt =
            normalizedStatus === 'resolved' || normalizedStatus === 'closed'
                ? updatedAt
                : null;
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE review_cases
                SET status = ?,
                    notes = COALESCE(?, notes),
                    metadata = COALESCE(?, metadata),
                    updated_at = ?,
                    resolved_at = CASE
                        WHEN ? IS NOT NULL THEN ?
                        WHEN ? IN ('open', 'in_progress') THEN NULL
                        ELSE resolved_at
                    END
                WHERE id = ?
            `;
            this.db.run(
                sql,
                [
                    normalizedStatus,
                    updates?.notes || null,
                    metadata === undefined ? null : metadata,
                    updatedAt,
                    resolvedAt,
                    resolvedAt,
                    normalizedStatus,
                    review_case_id,
                ],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    async moveCallJobToDlq(job = {}, reason = 'max_attempts_exceeded', error = null) {
        const now = new Date().toISOString();
        const jobId = Number(job?.id);
        if (!Number.isFinite(jobId) || jobId <= 0) {
            throw new Error('Invalid call job id for DLQ');
        }
        const payload = typeof job?.payload === 'string'
            ? job.payload
            : JSON.stringify(job?.payload || {});
        const attempts = Math.max(0, Number(job?.attempts) || 0);
        const sql = `
            INSERT INTO call_job_dlq (
                job_id,
                job_type,
                payload,
                attempts,
                last_error,
                dead_letter_reason,
                status,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
            ON CONFLICT(job_id) DO UPDATE SET
                job_type = excluded.job_type,
                payload = excluded.payload,
                attempts = excluded.attempts,
                last_error = excluded.last_error,
                dead_letter_reason = excluded.dead_letter_reason,
                status = 'open',
                updated_at = excluded.updated_at
        `;
        return new Promise((resolve, reject) => {
            this.db.run(sql, [
                jobId,
                String(job?.job_type || 'unknown'),
                payload,
                attempts,
                error || job?.last_error || null,
                reason || null,
                now,
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID || jobId);
                }
            });
        });
    }

    async listCallJobDlq({ status = null, limit = 20, offset = 0 } = {}) {
        const params = [];
        const clauses = [];
        if (status && String(status).toLowerCase() !== 'all') {
            clauses.push('status = ?');
            params.push(String(status).toLowerCase());
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const sql = `
            SELECT *
            FROM call_job_dlq
            ${where}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `;
        params.push(Math.min(100, Math.max(1, Number(limit) || 20)));
        params.push(Math.max(0, Number(offset) || 0));
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    async getCallJobDlqEntry(dlqId) {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT * FROM call_job_dlq WHERE id = ?';
            this.db.get(sql, [dlqId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async countOpenCallJobDlq() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT COUNT(*) AS total FROM call_job_dlq WHERE status = 'open'`;
            this.db.get(sql, [], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(Number(row?.total) || 0);
                }
            });
        });
    }

    async markCallJobDlqReplayed(dlqId, replayJobId) {
        const now = new Date().toISOString();
        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE call_job_dlq
                SET replay_count = replay_count + 1,
                    status = 'replayed',
                    last_replay_job_id = ?,
                    replayed_at = ?,
                    updated_at = ?
                WHERE id = ?
            `;
            this.db.run(sql, [replayJobId || null, now, now, dlqId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes || 0);
                }
            });
        });
    }

    // FIXED: User session tracking - Using INSERT OR REPLACE instead of ON CONFLICT
    async updateUserSession(telegram_chat_id, call_outcome = null) {
        return new Promise((resolve, reject) => {
            // First try to get existing session
            this.db.get(
                'SELECT * FROM user_sessions WHERE telegram_chat_id = ?',
                [telegram_chat_id],
                (err, existingSession) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const success_increment = (call_outcome === 'completed') ? 1 : 0;
                    const failure_increment = (call_outcome && call_outcome !== 'completed') ? 1 : 0;

                    if (existingSession) {
                        // Update existing session
                        const stmt = this.db.prepare(`
                            UPDATE user_sessions 
                            SET total_calls = total_calls + 1,
                                successful_calls = successful_calls + ?,
                                failed_calls = failed_calls + ?,
                                last_activity = datetime('now')
                            WHERE telegram_chat_id = ?
                        `);
                        
                        stmt.run([success_increment, failure_increment, telegram_chat_id], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.changes);
                            }
                        });
                        stmt.finalize();
                    } else {
                        // Insert new session
                        const stmt = this.db.prepare(`
                            INSERT INTO user_sessions 
                            (telegram_chat_id, total_calls, successful_calls, failed_calls, last_activity)
                            VALUES (?, 1, ?, ?, datetime('now'))
                        `);
                        
                        stmt.run([telegram_chat_id, success_increment, failure_increment], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.lastID);
                            }
                        });
                        stmt.finalize();
                    }
                }
            );
        });
    }

    // Get enhanced call details
    async getCall(call_sid) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM calls WHERE call_sid = ?`;
            
            this.db.get(sql, [call_sid], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    this.attachLatestCallDispositions(row ? [row] : [])
                        .then((rows) => resolve(rows[0] || null))
                        .catch(reject);
                }
            });
        });
    }

    async upsertCallOutcome(outcome = {}) {
        const normalizedCallSid = String(outcome.call_sid || outcome.callSid || '').trim();
        if (!normalizedCallSid) {
            throw new Error('call_sid is required');
        }

        const normalizedPrimaryFlow = normalizeCallScriptFlowType(
            outcome.primary_flow || outcome.primaryFlow || '',
        ) || null;
        const normalizedProfile = normalizeRelationshipProfileType(
            outcome.profile_used || outcome.profileUsed || '',
            '',
        ) || null;
        const parsedObjectiveTags = parseObjectiveTags(
            outcome.objective_tags ?? outcome.objectiveTags ?? [],
        );
        const normalizedObjectiveTags = buildObjectiveTagsForFlow(
            normalizedPrimaryFlow,
            Array.isArray(parsedObjectiveTags) ? parsedObjectiveTags : [],
        );
        const normalizedDisposition = (() => {
            const candidate = normalizeCallDispositionForDb(
                outcome.disposition || '',
            );
            return candidate && isValidCallDisposition(candidate) ? candidate : null;
        })();
        const nowIso = new Date().toISOString();
        const callbackActionCreated =
            outcome.callback_action_created === true || outcome.callbackActionCreated === true
                ? 1
                : 0;
        const reviewCaseActionCreated =
            outcome.review_case_action_created === true || outcome.reviewCaseActionCreated === true
                ? 1
                : 0;
        const secureFollowUpActionCreated =
            outcome.secure_follow_up_action_created === true || outcome.secureFollowUpActionCreated === true
                ? 1
                : 0;

        const sql = `
            INSERT INTO call_outcomes (
                call_sid,
                script_used,
                script_version,
                profile_used,
                primary_flow,
                objective_tags,
                provider_used,
                voice_used,
                first_message_version,
                disposition,
                callback_action_created,
                review_case_action_created,
                secure_follow_up_action_created,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(call_sid) DO UPDATE SET
                script_used = COALESCE(excluded.script_used, call_outcomes.script_used),
                script_version = COALESCE(excluded.script_version, call_outcomes.script_version),
                profile_used = COALESCE(excluded.profile_used, call_outcomes.profile_used),
                primary_flow = COALESCE(excluded.primary_flow, call_outcomes.primary_flow),
                objective_tags = COALESCE(excluded.objective_tags, call_outcomes.objective_tags),
                provider_used = COALESCE(excluded.provider_used, call_outcomes.provider_used),
                voice_used = COALESCE(excluded.voice_used, call_outcomes.voice_used),
                first_message_version = COALESCE(excluded.first_message_version, call_outcomes.first_message_version),
                disposition = COALESCE(excluded.disposition, call_outcomes.disposition),
                callback_action_created = CASE
                    WHEN excluded.callback_action_created = 1 THEN 1
                    ELSE call_outcomes.callback_action_created
                END,
                review_case_action_created = CASE
                    WHEN excluded.review_case_action_created = 1 THEN 1
                    ELSE call_outcomes.review_case_action_created
                END,
                secure_follow_up_action_created = CASE
                    WHEN excluded.secure_follow_up_action_created = 1 THEN 1
                    ELSE call_outcomes.secure_follow_up_action_created
                END,
                updated_at = excluded.updated_at
        `;

        await new Promise((resolve, reject) => {
            this.db.run(
                sql,
                [
                    normalizedCallSid,
                    outcome.script_used || outcome.scriptUsed || null,
                    outcome.script_version || outcome.scriptVersion || null,
                    normalizedProfile,
                    normalizedPrimaryFlow,
                    normalizedObjectiveTags.length ? JSON.stringify(normalizedObjectiveTags) : null,
                    outcome.provider_used || outcome.providerUsed || null,
                    outcome.voice_used || outcome.voiceUsed || null,
                    outcome.first_message_version || outcome.firstMessageVersion || null,
                    normalizedDisposition,
                    callbackActionCreated,
                    reviewCaseActionCreated,
                    secureFollowUpActionCreated,
                    nowIso,
                    nowIso,
                ],
                (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                },
            );
        });

        return this.getCallOutcome(normalizedCallSid);
    }

    async getCallOutcome(call_sid) {
        return new Promise((resolve, reject) => {
            const normalizedCallSid = String(call_sid || '').trim();
            if (!normalizedCallSid) {
                resolve(null);
                return;
            }
            const sql = `SELECT * FROM call_outcomes WHERE call_sid = ?`;
            this.db.get(sql, [normalizedCallSid], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (!row) {
                    resolve(null);
                    return;
                }
                let objectiveTags = [];
                try {
                    objectiveTags = row.objective_tags ? JSON.parse(row.objective_tags) : [];
                } catch (_) {
                    objectiveTags = [];
                }
                resolve({
                    ...row,
                    objective_tags: Array.isArray(objectiveTags) ? objectiveTags : [],
                    callback_action_created: row.callback_action_created === 1,
                    review_case_action_created: row.review_case_action_created === 1,
                    secure_follow_up_action_created: row.secure_follow_up_action_created === 1,
                });
            });
        });
    }

    async recordCallOutcomeFromCallCreated(call_sid, state = {}) {
        const normalizedCallSid = String(call_sid || '').trim();
        if (!normalizedCallSid) {
            throw new Error('call_sid is required');
        }

        const flowTypes = Array.isArray(state.flow_types) ? state.flow_types : [];
        const primaryFlow =
            normalizeCallScriptFlowType(state.primary_flow || state.flow_type || '') ||
            getPrimaryFlowType({
                ...state,
                flow_types: flowTypes,
            }) ||
            null;
        const objectiveTags = getEffectiveObjectiveTags({
            ...state,
            flow_types: flowTypes,
            flow_type: primaryFlow,
            primary_flow: primaryFlow,
        });

        return this.upsertCallOutcome({
            call_sid: normalizedCallSid,
            script_used: state.script_id || state.script || null,
            script_version: state.script_version || null,
            profile_used:
                state.conversation_profile ||
                state.call_profile ||
                state.purpose ||
                null,
            primary_flow: primaryFlow,
            objective_tags: objectiveTags,
            provider_used: state.provider || null,
            voice_used: state.voice_model || null,
            first_message_version: state.first_message_version || null,
        });
    }

    async markCallOutcomeAction(call_sid, action) {
        const normalizedCallSid = String(call_sid || '').trim();
        if (!normalizedCallSid) {
            throw new Error('call_sid is required');
        }

        const actionFieldMap = {
            callback: 'callback_action_created',
            review_case: 'review_case_action_created',
            secure_follow_up: 'secure_follow_up_action_created',
        };
        const field = actionFieldMap[String(action || '').trim().toLowerCase()];
        if (!field) {
            throw new Error(`Unsupported call outcome action: ${action}`);
        }

        return this.upsertCallOutcome({
            call_sid: normalizedCallSid,
            [field]: true,
        });
    }

    async upsertCallQualityReport(report = {}) {
        return new Promise((resolve, reject) => {
            const normalizedCallSid = String(report.call_sid || report.callSid || '').trim();
            if (!normalizedCallSid) {
                reject(new Error('call_sid is required'));
                return;
            }

            const findings = Array.isArray(report.findings) ? report.findings : [];
            const metrics = report.metrics && typeof report.metrics === 'object' ? report.metrics : {};
            const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
            const status = String(report.status || 'scored').trim().toLowerCase() || 'scored';
            const score = Number.isFinite(Number(report.score)) ? Math.max(0, Math.min(100, Math.floor(Number(report.score)))) : null;
            const profile = String(report.profile || report.call_profile || '').trim().toLowerCase() || 'general';
            const transcriptTurns = Number.isFinite(Number(metrics.total_turns))
                ? Math.max(0, Math.floor(Number(metrics.total_turns)))
                : 0;
            const userTurns = Number.isFinite(Number(metrics.user_turns))
                ? Math.max(0, Math.floor(Number(metrics.user_turns)))
                : 0;
            const aiTurns = Number.isFinite(Number(metrics.ai_turns))
                ? Math.max(0, Math.floor(Number(metrics.ai_turns)))
                : 0;
            const durationSeconds = Number.isFinite(Number(metrics.duration_seconds))
                ? Math.max(0, Math.floor(Number(metrics.duration_seconds)))
                : 0;
            const passed = report.passed ? 1 : 0;
            const shadowMode = report.shadow_mode === true || report.shadowMode === true ? 1 : 0;
            const modelVersion = String(report.version || report.model_version || 'post_call_qa_v1').trim();
            const evaluatedAt = report.evaluated_at
                ? String(report.evaluated_at)
                : new Date().toISOString();
            const nowIso = new Date().toISOString();

            const sql = `
                INSERT INTO call_quality_reports (
                    call_sid,
                    profile,
                    status,
                    score,
                    passed,
                    shadow_mode,
                    model_version,
                    transcript_turns,
                    user_turns,
                    ai_turns,
                    duration_seconds,
                    findings,
                    metrics,
                    recommendations,
                    evaluated_at,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(call_sid) DO UPDATE SET
                    profile = excluded.profile,
                    status = excluded.status,
                    score = excluded.score,
                    passed = excluded.passed,
                    shadow_mode = excluded.shadow_mode,
                    model_version = excluded.model_version,
                    transcript_turns = excluded.transcript_turns,
                    user_turns = excluded.user_turns,
                    ai_turns = excluded.ai_turns,
                    duration_seconds = excluded.duration_seconds,
                    findings = excluded.findings,
                    metrics = excluded.metrics,
                    recommendations = excluded.recommendations,
                    evaluated_at = excluded.evaluated_at,
                    updated_at = excluded.updated_at
            `;

            const params = [
                normalizedCallSid,
                profile,
                status,
                score,
                passed,
                shadowMode,
                modelVersion || 'post_call_qa_v1',
                transcriptTurns,
                userTurns,
                aiTurns,
                durationSeconds,
                JSON.stringify(findings),
                JSON.stringify(metrics),
                JSON.stringify(recommendations),
                evaluatedAt,
                nowIso,
                nowIso,
            ];

            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ ok: true, changes: this.changes || 0 });
            });
        });
    }

    async getCallQualityReport(call_sid) {
        return new Promise((resolve, reject) => {
            const normalizedCallSid = String(call_sid || '').trim();
            if (!normalizedCallSid) {
                resolve(null);
                return;
            }
            const sql = `SELECT * FROM call_quality_reports WHERE call_sid = ? LIMIT 1`;
            this.db.get(sql, [normalizedCallSid], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (!row) {
                    resolve(null);
                    return;
                }
                const parseJson = (value, fallback) => {
                    if (value === undefined || value === null || value === '') return fallback;
                    try {
                        const parsed = JSON.parse(value);
                        return parsed === undefined ? fallback : parsed;
                    } catch (_error) {
                        return fallback;
                    }
                };
                resolve({
                    ...row,
                    passed: Number(row.passed) === 1,
                    shadow_mode: Number(row.shadow_mode) === 1,
                    findings: parseJson(row.findings, []),
                    metrics: parseJson(row.metrics, {}),
                    recommendations: parseJson(row.recommendations, []),
                });
            });
        });
    }

    async getCallQualitySummary(options = {}) {
        const hoursRaw = Number(options.hours);
        const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(24 * 30, Math.floor(hoursRaw))) : 24 * 7;
        const topFindingsRaw = Number(options.topFindingsLimit);
        const topFindingsLimit = Number.isFinite(topFindingsRaw)
            ? Math.max(3, Math.min(20, Math.floor(topFindingsRaw)))
            : 8;
        const lowScoreRaw = Number(options.lowScoreLimit);
        const lowScoreLimit = Number.isFinite(lowScoreRaw)
            ? Math.max(3, Math.min(50, Math.floor(lowScoreRaw)))
            : 10;
        const sinceExpr = `-${hours} hours`;
        const trendBucket = hours <= 72 ? 'hour' : 'day';
        const trendBucketExpr =
            trendBucket === 'hour'
                ? "strftime('%Y-%m-%dT%H:00:00Z', evaluated_at)"
                : "strftime('%Y-%m-%d', evaluated_at)";

        const queryAll = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
        const queryOne = (sql, params = []) =>
            new Promise((resolve, reject) => {
                this.db.get(sql, params, (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                });
            });

        const totals = await queryOne(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
                AVG(CASE WHEN score IS NOT NULL THEN score END) AS avg_score,
                SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored,
                SUM(CASE WHEN status = 'insufficient_transcript' THEN 1 ELSE 0 END) AS insufficient_transcript,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)`,
            [sinceExpr],
        );

        const statusBreakdown = await queryAll(
            `SELECT status,
                    COUNT(*) AS total,
                    AVG(CASE WHEN score IS NOT NULL THEN score END) AS avg_score,
                    SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)
             GROUP BY status
             ORDER BY total DESC`,
            [sinceExpr],
        );

        const profileBreakdown = await queryAll(
            `SELECT COALESCE(NULLIF(profile, ''), 'general') AS profile,
                    COUNT(*) AS total,
                    AVG(CASE WHEN score IS NOT NULL THEN score END) AS avg_score,
                    SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)
             GROUP BY COALESCE(NULLIF(profile, ''), 'general')
             ORDER BY total DESC, avg_score DESC`,
            [sinceExpr],
        );

        const lowScoreCalls = await queryAll(
            `SELECT call_sid, profile, status, score, passed, shadow_mode, evaluated_at
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)
               AND score IS NOT NULL
             ORDER BY score ASC, evaluated_at DESC
             LIMIT ?`,
            [sinceExpr, lowScoreLimit],
        );

        const trendRows = await queryAll(
            `SELECT ${trendBucketExpr} AS bucket,
                    COUNT(*) AS total,
                    SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
                    AVG(CASE WHEN score IS NOT NULL THEN score END) AS avg_score
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)
               AND ${trendBucketExpr} IS NOT NULL
             GROUP BY ${trendBucketExpr}
             ORDER BY bucket ASC`,
            [sinceExpr],
        );

        const findingRows = await queryAll(
            `SELECT findings
             FROM call_quality_reports
             WHERE evaluated_at >= datetime('now', ?)
             ORDER BY evaluated_at DESC
             LIMIT 1200`,
            [sinceExpr],
        );
        const findingCounts = new Map();
        for (const row of findingRows) {
            let findings = [];
            try {
                const parsed = JSON.parse(row?.findings || '[]');
                if (Array.isArray(parsed)) findings = parsed;
            } catch (_error) {
                findings = [];
            }
            for (const finding of findings) {
                const key = String(finding || '').trim();
                if (!key) continue;
                findingCounts.set(key, (findingCounts.get(key) || 0) + 1);
            }
        }
        const topFindings = Array.from(findingCounts.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, topFindingsLimit)
            .map(([finding, count]) => ({ finding, count }));

        const total = Number(totals?.total || 0);
        const passed = Number(totals?.passed || 0);
        const passRate = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;
        const avgScore = Number.isFinite(Number(totals?.avg_score))
            ? Number(Number(totals.avg_score).toFixed(2))
            : null;

        return {
            window_hours: hours,
            totals: {
                total,
                passed,
                pass_rate: passRate,
                avg_score: avgScore,
                scored: Number(totals?.scored || 0),
                insufficient_transcript: Number(totals?.insufficient_transcript || 0),
                skipped: Number(totals?.skipped || 0),
            },
            status_breakdown: statusBreakdown.map((row) => ({
                status: String(row.status || ''),
                total: Number(row.total || 0),
                passed: Number(row.passed || 0),
                pass_rate: Number(row.total || 0) > 0
                    ? Number(((Number(row.passed || 0) / Number(row.total || 0)) * 100).toFixed(2))
                    : 0,
                avg_score: Number.isFinite(Number(row.avg_score))
                    ? Number(Number(row.avg_score).toFixed(2))
                    : null,
            })),
            profile_breakdown: profileBreakdown.map((row) => ({
                profile: String(row.profile || 'general'),
                total: Number(row.total || 0),
                passed: Number(row.passed || 0),
                pass_rate: Number(row.total || 0) > 0
                    ? Number(((Number(row.passed || 0) / Number(row.total || 0)) * 100).toFixed(2))
                    : 0,
                avg_score: Number.isFinite(Number(row.avg_score))
                    ? Number(Number(row.avg_score).toFixed(2))
                    : null,
            })),
            trend_bucket: trendBucket,
            trend_series: trendRows.map((row) => ({
                bucket: String(row.bucket || ''),
                total: Number(row.total || 0),
                passed: Number(row.passed || 0),
                pass_rate: Number(row.total || 0) > 0
                    ? Number(((Number(row.passed || 0) / Number(row.total || 0)) * 100).toFixed(2))
                    : 0,
                avg_score: Number.isFinite(Number(row.avg_score))
                    ? Number(Number(row.avg_score).toFixed(2))
                    : null,
            })),
            top_findings: topFindings,
            low_score_calls: lowScoreCalls.map((row) => ({
                call_sid: row.call_sid,
                profile: row.profile || 'general',
                status: row.status,
                score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
                passed: Number(row.passed) === 1,
                shadow_mode: Number(row.shadow_mode) === 1,
                evaluated_at: row.evaluated_at,
            })),
        };
    }

    // Get enhanced call transcripts (supports both table names)
    async getCallTranscripts(call_sid) {
        return new Promise((resolve, reject) => {
            const selectFrom = (tableName) => `
                SELECT * FROM ${tableName}
                WHERE call_sid = ?
                ORDER BY interaction_count ASC, timestamp ASC
            `;
            const sqlLegacy = selectFrom("transcripts");
            const sqlEnhanced = selectFrom("call_transcripts");

            this.db.all(sqlLegacy, [call_sid], (legacyErr, legacyRows) => {
                if (!legacyErr && Array.isArray(legacyRows) && legacyRows.length > 0) {
                    resolve(legacyRows);
                    return;
                }
                this.db.all(sqlEnhanced, [call_sid], (enhancedErr, enhancedRows) => {
                    if (enhancedErr) {
                        if (!legacyErr) {
                            resolve(Array.isArray(legacyRows) ? legacyRows : []);
                            return;
                        }
                        reject(legacyErr);
                        return;
                    }
                    resolve(Array.isArray(enhancedRows) ? enhancedRows : []);
                });
            });
        });
    }

    // Get enhanced calls with comprehensive metrics
    async getCallsWithTranscripts(limit = 50) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT c.*, 
                       COUNT(ct.id) as transcript_count,
                       COUNT(CASE WHEN ct.personality_used IS NOT NULL THEN 1 END) as personality_adaptations,
                       GROUP_CONCAT(DISTINCT ct.personality_used) as personalities_used
                FROM calls c
                LEFT JOIN transcripts ct ON c.call_sid = ct.call_sid
                GROUP BY c.call_sid
                ORDER BY c.created_at DESC
                LIMIT ?
            `;
            
            this.db.all(sql, [limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    this.attachLatestCallDispositions(rows || [])
                        .then(resolve)
                        .catch(reject);
                }
            });
        });
    }

    // Get enhanced notification analytics
    async getNotificationAnalytics(days = 7) {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT 
                    notification_type,
                    SUM(total_count) as total,
                    SUM(success_count) as successful,
                    SUM(failure_count) as failed,
                    AVG(avg_delivery_time_ms) as avg_delivery_time,
                    COUNT(*) as days_active,
                    MAX(updated_at) as last_updated
                FROM notification_metrics 
                WHERE date >= date('now', '-${days} days')
                GROUP BY notification_type
                ORDER BY total DESC
            `;
            
            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    const analytics = {
                        period_days: days,
                        total_notifications: 0,
                        total_successful: 0,
                        total_failed: 0,
                        overall_success_rate: 0,
                        avg_delivery_time_ms: 0,
                        breakdown: rows || []
                    };
                    
                    let totalDeliveryTime = 0;
                    let deliveryTimeCount = 0;
                    
                    analytics.breakdown.forEach(row => {
                        analytics.total_notifications += row.total;
                        analytics.total_successful += row.successful;
                        analytics.total_failed += row.failed;
                        
                        if (row.avg_delivery_time && row.total > 0) {
                            totalDeliveryTime += row.avg_delivery_time * row.total;
                            deliveryTimeCount += row.total;
                        }
                    });
                    
                    if (analytics.total_notifications > 0) {
                        analytics.overall_success_rate = 
                            ((analytics.total_successful / analytics.total_notifications) * 100).toFixed(2);
                    }
                    
                    if (deliveryTimeCount > 0) {
                       analytics.avg_delivery_time_ms = (totalDeliveryTime / deliveryTimeCount).toFixed(2);
                   }
                   
                   resolve(analytics);
               }
           });
       });
   }

   // Get comprehensive call statistics
   async getEnhancedCallStats(hours = 24) {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT 
                   COUNT(*) as total_calls,
                   COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_calls,
                   COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_calls,
                   COUNT(CASE WHEN status = 'busy' THEN 1 END) as busy_calls,
                   COUNT(CASE WHEN status = 'no-answer' THEN 1 END) as no_answer_calls,
                   AVG(duration) as avg_duration,
                   AVG(answer_delay) as avg_answer_delay,
                   AVG(ring_duration) as avg_ring_duration,
                   COUNT(CASE WHEN created_at >= datetime('now', '-${hours} hours') THEN 1 END) as recent_calls,
                   COUNT(DISTINCT user_chat_id) as unique_users
               FROM calls
           `;
           
           this.db.get(sql, [], (err, row) => {
               if (err) {
                   reject(err);
               } else {
                   // Calculate success rate
                   const successRate = row.total_calls > 0 ? 
                       ((row.completed_calls / row.total_calls) * 100).toFixed(2) : 0;
                   
                   resolve({
                       ...row,
                       success_rate: successRate,
                       period_hours: hours
                   });
               }
           });
       });
   }

   // Get service health summary
   async getServiceHealthSummary(hours = 24) {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT 
                   service_name,
                   status,
                   COUNT(*) as count,
                   MAX(timestamp) as last_occurrence
               FROM service_health_logs 
               WHERE timestamp >= datetime('now', '-${hours} hours')
               GROUP BY service_name, status
               ORDER BY service_name, status
           `;
           
           this.db.all(sql, [], (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   const summary = {
                       period_hours: hours,
                       services: {},
                       total_events: 0
                   };
                   
                   rows.forEach(row => {
                       if (!summary.services[row.service_name]) {
                           summary.services[row.service_name] = {};
                       }
                       summary.services[row.service_name][row.status] = {
                           count: row.count,
                           last_occurrence: row.last_occurrence
                       };
                       summary.total_events += row.count;
                   });
                   
                   resolve(summary);
               }
           });
       });
   }

   async getGptObservabilitySummary(windowMinutes = 60) {
       const safeWindow = Math.max(1, Math.min(1440, Number(windowMinutes) || 60));
       const windowExpr = `-${safeWindow} minutes`;

       const totals = await new Promise((resolve, reject) => {
           const sql = `
               SELECT
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                   SUM(CASE WHEN status = 'cached' THEN 1 ELSE 0 END) as cached_count,
                   AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_duration_ms
               FROM gpt_tool_audit
               WHERE created_at >= datetime('now', ?)
           `;
           this.db.get(sql, [windowExpr], (err, row) => {
               if (err) reject(err);
               else resolve(row || {});
           });
       });

       const byToolRows = await new Promise((resolve, reject) => {
           const sql = `
               SELECT tool_name, status, COUNT(*) as count
               FROM gpt_tool_audit
               WHERE created_at >= datetime('now', ?)
               GROUP BY tool_name, status
               ORDER BY tool_name ASC, status ASC
           `;
           this.db.all(sql, [windowExpr], (err, rows) => {
               if (err) reject(err);
               else resolve(rows || []);
           });
       });

       const sloRows = await new Promise((resolve, reject) => {
           const sql = `
               SELECT status, COUNT(*) as count
               FROM service_health_logs
               WHERE service_name = 'gpt_slo'
                 AND timestamp >= datetime('now', ?)
               GROUP BY status
           `;
           this.db.all(sql, [windowExpr], (err, rows) => {
               if (err) reject(err);
               else resolve(rows || []);
           });
       });

       const circuitRows = await new Promise((resolve, reject) => {
           const sql = `
               SELECT status, COUNT(*) as count
               FROM service_health_logs
               WHERE service_name = 'gpt_tool_circuit'
                 AND timestamp >= datetime('now', ?)
               GROUP BY status
           `;
           this.db.all(sql, [windowExpr], (err, rows) => {
               if (err) reject(err);
               else resolve(rows || []);
           });
       });

       const idemRows = await new Promise((resolve, reject) => {
           const sql = `
               SELECT status, COUNT(*) as count
               FROM gpt_tool_idempotency
               WHERE updated_at >= datetime('now', ?)
               GROUP BY status
           `;
           this.db.all(sql, [windowExpr], (err, rows) => {
               if (err) reject(err);
               else resolve(rows || []);
           });
       });

       const total = Number(totals?.total) || 0;
       const failed = Number(totals?.failed_count) || 0;
       const failureRate = total > 0 ? failed / total : 0;
       const byTool = {};
       byToolRows.forEach((row) => {
           const toolName = String(row.tool_name || 'unknown');
           if (!byTool[toolName]) {
               byTool[toolName] = { ok: 0, failed: 0, cached: 0, other: 0, total: 0 };
           }
           const status = String(row.status || 'other');
           const count = Number(row.count) || 0;
           if (status === 'ok') byTool[toolName].ok += count;
           else if (status === 'failed') byTool[toolName].failed += count;
           else if (status === 'cached') byTool[toolName].cached += count;
           else byTool[toolName].other += count;
           byTool[toolName].total += count;
       });

       const toMap = (rows = []) => rows.reduce((acc, row) => {
           const key = String(row.status || 'unknown');
           acc[key] = Number(row.count) || 0;
           return acc;
       }, {});

       return {
           window_minutes: safeWindow,
           tool_execution: {
               total,
               ok: Number(totals?.ok_count) || 0,
               failed,
               cached: Number(totals?.cached_count) || 0,
               failure_rate: Number(failureRate.toFixed(4)),
               avg_duration_ms: Math.round(Number(totals?.avg_duration_ms) || 0),
               by_tool: byTool
           },
           slo: toMap(sloRows),
           circuits: toMap(circuitRows),
           idempotency: toMap(idemRows)
       };
   }

   // Create SMS messages table
   async initializeSMSTables() {
       return new Promise((resolve, reject) => {
           const createSMSTable = `CREATE TABLE IF NOT EXISTS sms_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               message_sid TEXT UNIQUE NOT NULL,
               to_number TEXT,
               from_number TEXT,
               body TEXT NOT NULL,
               status TEXT DEFAULT 'queued',
               direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
               provider TEXT,
               error_code TEXT,
               error_message TEXT,
               ai_response TEXT,
               response_message_sid TEXT,
               user_chat_id TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createBulkSMSTable = `CREATE TABLE IF NOT EXISTS bulk_sms_operations (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               total_recipients INTEGER NOT NULL,
               successful INTEGER DEFAULT 0,
               failed INTEGER DEFAULT 0,
               message TEXT NOT NULL,
               user_chat_id TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createSmsOptOutTable = `CREATE TABLE IF NOT EXISTS sms_opt_outs (
               phone_number TEXT PRIMARY KEY,
               reason TEXT,
               opted_out INTEGER DEFAULT 1,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createSmsIdempotencyTable = `CREATE TABLE IF NOT EXISTS sms_idempotency (
               idempotency_key TEXT PRIMARY KEY,
               message_sid TEXT,
               to_number TEXT,
               body_hash TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createSmsScriptsTable = `CREATE TABLE IF NOT EXISTS sms_scripts (
               name TEXT PRIMARY KEY,
               description TEXT,
               content TEXT NOT NULL,
               metadata TEXT,
               version INTEGER DEFAULT 1,
               lifecycle_state TEXT DEFAULT 'draft',
               submitted_for_review_at DATETIME,
               reviewed_at DATETIME,
               reviewed_by TEXT,
               review_note TEXT,
               live_at DATETIME,
               live_by TEXT,
               created_by TEXT,
               updated_by TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createSmsScriptVersionsTable = `CREATE TABLE IF NOT EXISTS sms_script_versions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               script_name TEXT NOT NULL,
               version INTEGER NOT NULL,
               snapshot TEXT NOT NULL,
               reason TEXT,
               created_by TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(script_name, version),
               FOREIGN KEY(script_name) REFERENCES sms_scripts(name) ON DELETE CASCADE
           )`;

           this.db.serialize(() => {
               this.db.run(createSMSTable, (err) => {
                   if (err) {
                       console.error('Error creating SMS table:', err);
                       reject(err);
                       return;
                   }
               });
               
               this.db.run(createBulkSMSTable, (err) => {
                   if (err) {
                       console.error('Error creating bulk SMS table:', err);
                       reject(err);
                       return;
                   }
                   this.db.run(createSmsOptOutTable, (optErr) => {
                       if (optErr) {
                           console.error('Error creating sms_opt_outs table:', optErr);
                           reject(optErr);
                           return;
                       }
                       this.db.run(createSmsIdempotencyTable, (idemErr) => {
                           if (idemErr) {
                               console.error('Error creating sms_idempotency table:', idemErr);
                               reject(idemErr);
                               return;
                           }
                           this.db.run(createSmsScriptsTable, (scriptErr) => {
                               if (scriptErr) {
                                   console.error('Error creating sms_scripts table:', scriptErr);
                                   reject(scriptErr);
                                   return;
                               }
                               this.db.run(createSmsScriptVersionsTable, (versionsErr) => {
                                   if (versionsErr) {
                                       console.error('Error creating sms_script_versions table:', versionsErr);
                                       reject(versionsErr);
                                       return;
                                   }
                                   this.ensureSmsColumns(['provider']).then(() => {
                                       this.ensureSmsScriptColumns([
                                           'version',
                                           'lifecycle_state',
                                           'submitted_for_review_at',
                                           'reviewed_at',
                                           'reviewed_by',
                                           'review_note',
                                           'live_at',
                                           'live_by',
                                       ]).then(() => {
                                           const smsIndexes = [
                                               'CREATE INDEX IF NOT EXISTS idx_sms_messages_status_updated_at ON sms_messages(status, updated_at)',
                                               'CREATE INDEX IF NOT EXISTS idx_sms_messages_direction_updated_at ON sms_messages(direction, updated_at)',
                                               'CREATE INDEX IF NOT EXISTS idx_sms_messages_provider ON sms_messages(provider)',
                                               'CREATE INDEX IF NOT EXISTS idx_sms_scripts_updated_at ON sms_scripts(updated_at)',
                                               'CREATE INDEX IF NOT EXISTS idx_sms_scripts_lifecycle_state ON sms_scripts(lifecycle_state)',
                                               'CREATE INDEX IF NOT EXISTS idx_sms_script_versions_name_version ON sms_script_versions(script_name, version)',
                                           ];
                                           Promise.all(
                                               smsIndexes.map((sql) => new Promise((indexResolve, indexReject) => {
                                                   this.db.run(sql, (indexErr) => {
                                                       if (indexErr) indexReject(indexErr);
                                                       else indexResolve();
                                                   });
                                               })),
                                           ).then(() => {
                                               console.log('✅ SMS tables created successfully');
                                               resolve();
                                           }).catch(reject);
                                       }).catch(reject);
                                   }).catch(reject);
                               });
                           });
                       });
                   });
               });
           });
       });
   }

   async ensureSmsColumns(columns = []) {
       if (!columns.length) return;
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(sms_messages)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const existingNames = new Set(existing.map((row) => row.name));
       const addColumn = (name, definition) => new Promise((resolve, reject) => {
           this.db.run(`ALTER TABLE sms_messages ADD COLUMN ${name} ${definition}`, (err) => {
               if (err) {
                   if (String(err.message || '').includes('duplicate')) resolve();
                   else reject(err);
               } else {
                   resolve();
               }
           });
       });
       for (const column of columns) {
           if (existingNames.has(column)) continue;
           if (column === 'provider') {
               await addColumn('provider', 'TEXT');
           }
       }
   }

   async ensureSmsScriptColumns(columns = []) {
       if (!columns.length) return;
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(sms_scripts)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const existingNames = new Set(existing.map((row) => row.name));
       const addColumn = (name, definition) => new Promise((resolve, reject) => {
           this.db.run(`ALTER TABLE sms_scripts ADD COLUMN ${name} ${definition}`, (err) => {
               if (err) {
                   if (String(err.message || '').includes('duplicate')) resolve();
                   else reject(err);
               } else {
                   resolve();
               }
           });
       });
       for (const column of columns) {
           if (existingNames.has(column)) continue;
           if (column === 'version') {
               await addColumn('version', 'INTEGER DEFAULT 1');
           } else if (column === 'lifecycle_state') {
               await addColumn('lifecycle_state', "TEXT DEFAULT 'draft'");
           } else if (column === 'submitted_for_review_at') {
               await addColumn('submitted_for_review_at', 'DATETIME');
           } else if (column === 'reviewed_at') {
               await addColumn('reviewed_at', 'DATETIME');
           } else if (column === 'reviewed_by') {
               await addColumn('reviewed_by', 'TEXT');
           } else if (column === 'review_note') {
               await addColumn('review_note', 'TEXT');
           } else if (column === 'live_at') {
               await addColumn('live_at', 'DATETIME');
           } else if (column === 'live_by') {
               await addColumn('live_by', 'TEXT');
           }
       }
   }

   // Create Email tables
   async initializeEmailTables() {
       return new Promise((resolve, reject) => {
           const createEmailMessagesTable = `CREATE TABLE IF NOT EXISTS email_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               message_id TEXT UNIQUE NOT NULL,
               to_email TEXT NOT NULL,
               from_email TEXT,
               subject TEXT,
               html TEXT,
               text TEXT,
               template_id TEXT,
               variables_json TEXT,
               variables_hash TEXT,
               metadata_json TEXT,
               status TEXT DEFAULT 'queued',
               provider TEXT,
               provider_message_id TEXT,
               provider_response TEXT,
               failure_reason TEXT,
               tenant_id TEXT,
               bulk_job_id TEXT,
               scheduled_at DATETIME,
               last_attempt_at DATETIME,
               next_attempt_at DATETIME,
               retry_count INTEGER DEFAULT 0,
               max_retries INTEGER DEFAULT 5,
               queue_lock_token TEXT,
               queue_lock_expires_at_ms INTEGER,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               sent_at DATETIME,
               delivered_at DATETIME,
               failed_at DATETIME,
               suppressed_reason TEXT
           )`;

           const createEmailEventsTable = `CREATE TABLE IF NOT EXISTS email_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               message_id TEXT NOT NULL,
               event_type TEXT NOT NULL,
               provider TEXT,
               timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
               metadata TEXT
           )`;

           const createEmailBulkJobsTable = `CREATE TABLE IF NOT EXISTS email_bulk_jobs (
               job_id TEXT PRIMARY KEY,
               status TEXT DEFAULT 'queued',
               total INTEGER DEFAULT 0,
               queued INTEGER DEFAULT 0,
               sending INTEGER DEFAULT 0,
               sent INTEGER DEFAULT 0,
               failed INTEGER DEFAULT 0,
               delivered INTEGER DEFAULT 0,
               bounced INTEGER DEFAULT 0,
               complained INTEGER DEFAULT 0,
               suppressed INTEGER DEFAULT 0,
               tenant_id TEXT,
               template_id TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               completed_at DATETIME
           )`;

           const createEmailSuppressionTable = `CREATE TABLE IF NOT EXISTS email_suppression (
               email TEXT PRIMARY KEY,
               reason TEXT,
               source TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createEmailIdempotencyTable = `CREATE TABLE IF NOT EXISTS email_idempotency (
               idempotency_key TEXT PRIMARY KEY,
               message_id TEXT,
               bulk_job_id TEXT,
               request_hash TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createEmailProviderEventsTable = `CREATE TABLE IF NOT EXISTS email_provider_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               event_key TEXT UNIQUE NOT NULL,
               message_id TEXT,
               provider TEXT,
               event_type TEXT,
               reason TEXT,
               payload_json TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createEmailDlqTable = `CREATE TABLE IF NOT EXISTS email_dlq (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               message_id TEXT NOT NULL,
               reason TEXT,
               payload TEXT,
               status TEXT DEFAULT 'open',
               replay_count INTEGER DEFAULT 0,
               replayed_at DATETIME,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               last_replay_error TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createEmailTemplatesTable = `CREATE TABLE IF NOT EXISTS email_templates (
               template_id TEXT PRIMARY KEY,
               subject TEXT,
               html TEXT,
               text TEXT,
               required_vars TEXT,
               version INTEGER DEFAULT 1,
               lifecycle_state TEXT DEFAULT 'draft',
               submitted_for_review_at DATETIME,
               reviewed_at DATETIME,
               reviewed_by TEXT,
               review_note TEXT,
               live_at DATETIME,
               live_by TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`;

           const createEmailTemplateVersionsTable = `CREATE TABLE IF NOT EXISTS email_template_versions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               template_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               snapshot TEXT NOT NULL,
               reason TEXT,
               created_by TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(template_id, version),
               FOREIGN KEY(template_id) REFERENCES email_templates(template_id) ON DELETE CASCADE
           )`;

           const createEmailMetricsTable = `CREATE TABLE IF NOT EXISTS email_metrics (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               date TEXT NOT NULL,
               metric_type TEXT NOT NULL,
               total_count INTEGER DEFAULT 0,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(date, metric_type)
           )`;

           const indexes = [
               'CREATE INDEX IF NOT EXISTS idx_email_messages_status ON email_messages(status)',
               'CREATE INDEX IF NOT EXISTS idx_email_messages_to_email ON email_messages(to_email)',
               'CREATE INDEX IF NOT EXISTS idx_email_messages_bulk_job_id ON email_messages(bulk_job_id)',
               'CREATE INDEX IF NOT EXISTS idx_email_messages_provider_message_id ON email_messages(provider_message_id)',
               'CREATE INDEX IF NOT EXISTS idx_email_messages_created_at ON email_messages(created_at)',
               'CREATE INDEX IF NOT EXISTS idx_email_events_message_id ON email_events(message_id)',
               'CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type)',
               'CREATE INDEX IF NOT EXISTS idx_email_events_timestamp ON email_events(timestamp)',
               'CREATE INDEX IF NOT EXISTS idx_email_bulk_status ON email_bulk_jobs(status)',
               'CREATE INDEX IF NOT EXISTS idx_email_bulk_tenant ON email_bulk_jobs(tenant_id)',
               'CREATE INDEX IF NOT EXISTS idx_email_suppression_email ON email_suppression(email)',
               'CREATE INDEX IF NOT EXISTS idx_email_provider_events_key ON email_provider_events(event_key)',
               'CREATE INDEX IF NOT EXISTS idx_email_provider_events_message_id ON email_provider_events(message_id)',
               'CREATE INDEX IF NOT EXISTS idx_email_provider_events_created_at ON email_provider_events(created_at)',
               'CREATE INDEX IF NOT EXISTS idx_email_templates_lifecycle_state ON email_templates(lifecycle_state)',
               'CREATE INDEX IF NOT EXISTS idx_email_template_versions_template_version ON email_template_versions(template_id, version)'
           ];

           this.db.serialize(() => {
               this.db.run(createEmailMessagesTable, (err) => {
                   if (err) {
                       console.error('Error creating email_messages table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailEventsTable, (err) => {
                   if (err) {
                       console.error('Error creating email_events table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailBulkJobsTable, (err) => {
                   if (err) {
                       console.error('Error creating email_bulk_jobs table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailSuppressionTable, (err) => {
                   if (err) {
                       console.error('Error creating email_suppression table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailIdempotencyTable, (err) => {
                   if (err) {
                       console.error('Error creating email_idempotency table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailProviderEventsTable, (err) => {
                   if (err) {
                       console.error('Error creating email_provider_events table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailDlqTable, (err) => {
                   if (err) {
                       console.error('Error creating email_dlq table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailTemplatesTable, (err) => {
                   if (err) {
                       console.error('Error creating email_templates table:', err);
                       reject(err);
                       return;
                   }
               });
               this.db.run(createEmailTemplateVersionsTable, (versionErr) => {
                   if (versionErr) {
                       console.error('Error creating email_template_versions table:', versionErr);
                       reject(versionErr);
                       return;
                   }
               });
               this.db.run(createEmailMetricsTable, (err) => {
                   if (err) {
                       console.error('Error creating email_metrics table:', err);
                       reject(err);
                       return;
                   }
               });

               let indexErrors = null;
               indexes.forEach((stmt) => {
                   this.db.run(stmt, (err) => {
                       if (err) {
                           indexErrors = err;
                           console.error('Error creating email index:', err);
                       }
                   });
               });
               if (indexErrors) {
                   reject(indexErrors);
                   return;
               }
               this.ensureEmailTemplateColumns([
                   'version',
                   'lifecycle_state',
                   'submitted_for_review_at',
                   'reviewed_at',
                   'reviewed_by',
                   'review_note',
                   'live_at',
                   'live_by',
               ]).then(() => {
                   console.log('✅ Email tables created successfully');
                   resolve();
               }).catch(reject);
           });
       });
   }

   async initializePostCallAutomationTables() {
       const statements = [
           `CREATE TABLE IF NOT EXISTS post_call_automation_rules (
               rule_id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               enabled INTEGER DEFAULT 1,
               trigger_event TEXT NOT NULL,
               conditions_json TEXT,
               actions_json TEXT NOT NULL,
               priority INTEGER DEFAULT 100,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               last_run_at DATETIME
           )`,
           `CREATE TABLE IF NOT EXISTS post_call_automation_runs (
               run_id TEXT PRIMARY KEY,
               rule_id TEXT NOT NULL,
               call_sid TEXT,
               trigger_event TEXT NOT NULL,
               status TEXT NOT NULL,
               actions_json TEXT,
               result_json TEXT,
               error TEXT,
               idempotency_key TEXT UNIQUE,
               payload_json TEXT,
               retry_of_run_id TEXT,
               attempt INTEGER DEFAULT 1,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               completed_at DATETIME
           )`,
           `CREATE TABLE IF NOT EXISTS post_call_workflow_definitions (
               workflow_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               business_id TEXT,
               name TEXT NOT NULL,
               trigger_event TEXT NOT NULL,
               schema_version INTEGER NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('draft', 'approved')),
               definition_json TEXT NOT NULL,
               created_by TEXT NOT NULL,
               approved_by TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               approved_at DATETIME,
               PRIMARY KEY(workflow_id, version)
           )`,
<<<<<<< HEAD
           `CREATE TABLE IF NOT EXISTS call_e_result_workflow_action_approvals (
               workflow_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               business_id TEXT NOT NULL,
               approved_by TEXT NOT NULL,
               request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
               created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY(workflow_id, version),
               FOREIGN KEY(workflow_id, version) REFERENCES post_call_workflow_definitions(workflow_id, version) ON DELETE CASCADE
           )`,
           `CREATE TRIGGER IF NOT EXISTS call_e_result_workflow_action_approvals_no_update
            BEFORE UPDATE ON call_e_result_workflow_action_approvals
            BEGIN SELECT RAISE(ABORT, 'CALL-E result workflow approvals are append-only'); END`,
           `CREATE TRIGGER IF NOT EXISTS call_e_result_workflow_action_approvals_no_delete
            BEFORE DELETE ON call_e_result_workflow_action_approvals
            BEGIN SELECT RAISE(ABORT, 'CALL-E result workflow approvals are append-only'); END`,
=======
>>>>>>> 95a068c (updated)
           `CREATE TABLE IF NOT EXISTS post_call_workflow_runs (
               run_id TEXT PRIMARY KEY,
               workflow_id TEXT NOT NULL,
               workflow_version INTEGER NOT NULL,
<<<<<<< HEAD
               business_id TEXT,
               trigger_event TEXT NOT NULL,
               trigger_reference TEXT,
               idempotency_key TEXT NOT NULL UNIQUE,
               status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'waiting_approval', 'completed', 'failed', 'canceled', 'needs_review')),
               current_step_id TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               error_code TEXT,
               next_run_at DATETIME,
               runner_id TEXT,
               lease_expires_at DATETIME,
               canceled_by TEXT,
               expires_at DATETIME,
               started_at DATETIME,
               completed_at DATETIME,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`,
           `CREATE TABLE IF NOT EXISTS post_call_workflow_step_runs (
               run_id TEXT NOT NULL,
               step_id TEXT NOT NULL,
               next_step_id TEXT,
               step_type TEXT NOT NULL,
               action_type TEXT,
               status TEXT NOT NULL CHECK(status IN ('running', 'waiting', 'waiting_approval', 'completed', 'failed', 'approved', 'needs_review', 'canceled')),
               idempotency_key TEXT,
               result_json TEXT,
               error_code TEXT,
               approved_by TEXT,
               started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               completed_at DATETIME,
               PRIMARY KEY(run_id, step_id),
               FOREIGN KEY(run_id) REFERENCES post_call_workflow_runs(run_id) ON DELETE CASCADE
=======
               idempotency_key TEXT NOT NULL UNIQUE,
               trigger_event TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'needs_review', 'canceled')),
               current_step_id TEXT,
               payload_json TEXT NOT NULL,
               state_json TEXT NOT NULL,
               error_code TEXT,
               created_by TEXT NOT NULL,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               next_run_at DATETIME,
               completed_at DATETIME,
               execution_owner TEXT,
               lease_expires_at DATETIME,
               reviewed_by TEXT,
               review_decision TEXT,
               reviewed_at DATETIME,
               FOREIGN KEY(workflow_id, workflow_version) REFERENCES post_call_workflow_definitions(workflow_id, version)
           )`,
           `CREATE TABLE IF NOT EXISTS post_call_workflow_events (
               event_id TEXT PRIMARY KEY,
               event_key TEXT NOT NULL UNIQUE,
               business_id TEXT,
               trigger_event TEXT NOT NULL,
               definition_versions_json TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed')),
               error_code TEXT,
               locked_at DATETIME,
               last_enqueued_at DATETIME,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               processed_at DATETIME
>>>>>>> 95a068c (updated)
           )`,
           `CREATE TABLE IF NOT EXISTS crm_contact_sync_records (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               provider TEXT NOT NULL,
               local_contact_id TEXT,
               external_contact_id TEXT,
               email TEXT,
               phone TEXT,
               status TEXT,
               payload_json TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(provider, local_contact_id)
           )`,
           `CREATE TABLE IF NOT EXISTS crm_activity_sync_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               provider TEXT NOT NULL,
               external_contact_id TEXT,
               activity_id TEXT,
               activity_type TEXT,
               status TEXT,
               payload_json TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`,
           'CREATE INDEX IF NOT EXISTS idx_post_call_rules_trigger_enabled ON post_call_automation_rules(trigger_event, enabled)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_rules_priority ON post_call_automation_rules(priority)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_runs_call_sid ON post_call_automation_runs(call_sid)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_runs_idempotency ON post_call_automation_runs(idempotency_key)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_status ON post_call_workflow_definitions(status, created_at)',
<<<<<<< HEAD
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_runs_due ON post_call_workflow_runs(status, next_run_at, created_at)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_runs_workflow ON post_call_workflow_runs(workflow_id, created_at)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_steps_status ON post_call_workflow_step_runs(run_id, status)',
=======
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_runs_status ON post_call_workflow_runs(status, updated_at)',
           'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_events_status ON post_call_workflow_events(status, updated_at)',
>>>>>>> 95a068c (updated)
           'CREATE INDEX IF NOT EXISTS idx_crm_contact_sync_email ON crm_contact_sync_records(email)',
           'CREATE INDEX IF NOT EXISTS idx_crm_activity_sync_contact ON crm_activity_sync_events(external_contact_id)',
       ];
       for (const stmt of statements) {
           await new Promise((resolve, reject) => {
               this.db.run(stmt, (err) => {
                   if (err) reject(err);
                   else resolve();
               });
           });
       }
       await this.ensurePostCallWorkflowRunColumns();
       await this.ensurePostCallWorkflowStepColumns();
       await new Promise((resolve, reject) => {
           this.db.run(
               'CREATE INDEX IF NOT EXISTS idx_post_call_workflow_runs_expiry ON post_call_workflow_runs(status, expires_at)',
               (err) => err ? reject(err) : resolve(),
           );
       });
       await this.ensurePostCallWorkflowTriggers();
       await this.ensurePostCallAutomationRunColumns();
       await this.ensurePostCallWorkflowScopeColumns();
       await this.ensurePostCallWorkflowRunColumns();
       await new Promise((resolve, reject) => {
           this.db.run('CREATE INDEX IF NOT EXISTS idx_post_call_workflow_runs_lease ON post_call_workflow_runs(status, lease_expires_at, updated_at)',
               (err) => err ? reject(err) : resolve());
       });
       console.log('✅ Post-call automation tables created successfully');
   }

<<<<<<< HEAD
   async ensurePostCallWorkflowRunColumns() {
       for (const table of ['post_call_workflow_definitions', 'post_call_workflow_runs']) {
           const tableRows = await new Promise((resolve, reject) => {
               this.db.all(`PRAGMA table_info(${table})`, (err, result) => err ? reject(err) : resolve(result || []));
           });
           if (!tableRows.some((row) => row.name === 'business_id')) {
               await new Promise((resolve, reject) => {
                   this.db.run(`ALTER TABLE ${table} ADD COLUMN business_id TEXT`, (err) => err ? reject(err) : resolve());
               });
           }
       }
       const rows = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(post_call_workflow_runs)', (err, result) => err ? reject(err) : resolve(result || []));
       });
       const names = new Set(rows.map((row) => row.name));
       if (!names.has('trigger_reference')) {
           await new Promise((resolve, reject) => {
               this.db.run('ALTER TABLE post_call_workflow_runs ADD COLUMN trigger_reference TEXT', (err) => err ? reject(err) : resolve());
           });
       }
       if (!names.has('expires_at')) {
           await new Promise((resolve, reject) => {
               this.db.run('ALTER TABLE post_call_workflow_runs ADD COLUMN expires_at DATETIME', (err) => err ? reject(err) : resolve());
           });
       }
       await new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET expires_at = datetime(created_at, '+90 days') WHERE expires_at IS NULL`,
               (err) => err ? reject(err) : resolve(),
           );
       });
   }

   async ensurePostCallWorkflowStepColumns() {
       const rows = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(post_call_workflow_step_runs)', (err, result) => err ? reject(err) : resolve(result || []));
       });
       const names = new Set(rows.map((row) => row.name));
       if (!names.has('next_step_id')) {
           await new Promise((resolve, reject) => {
               this.db.run('ALTER TABLE post_call_workflow_step_runs ADD COLUMN next_step_id TEXT', (err) => err ? reject(err) : resolve());
=======
   async ensurePostCallWorkflowScopeColumns() {
       for (const table of ['post_call_workflow_definitions', 'post_call_workflow_events']) {
           const existing = await new Promise((resolve, reject) => {
               this.db.all(`PRAGMA table_info(${table})`, (err, rows) => err ? reject(err) : resolve(rows || []));
           });
           if (existing.some((column) => column.name === 'business_id')) continue;
           await new Promise((resolve, reject) => {
               this.db.run(`ALTER TABLE ${table} ADD COLUMN business_id TEXT`, (err) => {
                   if (!err) return resolve();
                   this.db.all(`PRAGMA table_info(${table})`, (readErr, rows) => {
                       if (readErr) return reject(err);
                       if ((rows || []).some((column) => column.name === 'business_id')) return resolve();
                       reject(err);
                   });
               });
           });
       }
       await new Promise((resolve, reject) => {
           this.db.run('CREATE INDEX IF NOT EXISTS idx_post_call_workflow_business ON post_call_workflow_definitions(business_id, status, trigger_event, version)',
               (err) => err ? reject(err) : resolve());
       });
   }

   async ensurePostCallWorkflowRunColumns() {
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(post_call_workflow_runs)', (err, rows) => {
               if (err) reject(err);
               else resolve(rows || []);
           });
       });
       const names = new Set(existing.map((row) => row.name));
       const columns = {
           execution_owner: 'TEXT',
           lease_expires_at: 'DATETIME',
           reviewed_by: 'TEXT',
           review_decision: 'TEXT',
           reviewed_at: 'DATETIME',
       };
       for (const [name, type] of Object.entries(columns)) {
           if (names.has(name)) continue;
           await new Promise((resolve, reject) => {
               this.db.run(`ALTER TABLE post_call_workflow_runs ADD COLUMN ${name} ${type}`,
                   (err) => {
                       if (!err) {
                           resolve();
                           return;
                       }
                       this.db.all('PRAGMA table_info(post_call_workflow_runs)', (readErr, rows) => {
                           if (readErr) {
                               reject(err);
                               return;
                           }
                           if ((rows || []).some((column) => column.name === name)) resolve();
                           else reject(err);
                       });
                   });
>>>>>>> 95a068c (updated)
           });
       }
   }

<<<<<<< HEAD
   async ensurePostCallWorkflowTriggers() {
       const statements = [
           `CREATE TRIGGER IF NOT EXISTS post_call_workflow_business_scope_immutable
            BEFORE INSERT ON post_call_workflow_definitions
            WHEN EXISTS (
                SELECT 1 FROM post_call_workflow_definitions prior
                WHERE prior.workflow_id = NEW.workflow_id
                  AND COALESCE(prior.business_id, '') != COALESCE(NEW.business_id, '')
            )
            BEGIN
                SELECT RAISE(ABORT, 'post-call workflow business scope is immutable');
            END`,
           `CREATE TRIGGER IF NOT EXISTS post_call_workflow_resume_after_approval
            AFTER UPDATE OF status ON post_call_workflow_step_runs
            WHEN NEW.status = 'approved' AND OLD.status = 'waiting_approval'
            BEGIN
                UPDATE post_call_workflow_runs
                SET status = 'queued', current_step_id = NEW.next_step_id, next_run_at = NULL,
                    runner_id = NULL, lease_expires_at = NULL, error_code = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = NEW.run_id AND status = 'waiting_approval' AND current_step_id = OLD.step_id;
            END`,
           `CREATE TRIGGER IF NOT EXISTS post_call_workflow_audit_cancel
            AFTER UPDATE OF status ON post_call_workflow_runs
            WHEN NEW.status = 'canceled' AND OLD.status != 'canceled'
            BEGIN
                UPDATE post_call_workflow_step_runs
                SET status = 'canceled', completed_at = CURRENT_TIMESTAMP
                WHERE run_id = NEW.run_id AND step_id = NEW.current_step_id
                  AND status IN ('waiting', 'waiting_approval');
            END`,
       ];
       for (const sql of statements) {
           await new Promise((resolve, reject) => this.db.run(sql, (err) => err ? reject(err) : resolve()));
       }
   }

=======
>>>>>>> 95a068c (updated)
   async ensurePostCallAutomationRunColumns() {
       if (this.postCallAutomationRunColumnsEnsured) {
           return;
       }
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(post_call_automation_runs)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const names = new Set(existing.map((row) => row.name));
       const alterStatements = [];
       if (!names.has('payload_json')) {
           alterStatements.push('ALTER TABLE post_call_automation_runs ADD COLUMN payload_json TEXT');
       }
       if (!names.has('retry_of_run_id')) {
           alterStatements.push('ALTER TABLE post_call_automation_runs ADD COLUMN retry_of_run_id TEXT');
       }
       if (!names.has('attempt')) {
           alterStatements.push('ALTER TABLE post_call_automation_runs ADD COLUMN attempt INTEGER DEFAULT 1');
       }
       for (const stmt of alterStatements) {
           await new Promise((resolve, reject) => {
               this.db.run(stmt, (err) => {
                   if (err) {
                       reject(err);
                   } else {
                       resolve();
                   }
               });
           });
       }
       this.postCallAutomationRunColumnsEnsured = true;
   }

   async ensureEmailDlqColumns() {
       if (this.emailDlqColumnsEnsured) {
           return;
       }
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(email_dlq)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const names = new Set(existing.map((row) => row.name));
       const alterStatements = [];
       if (!names.has('status')) {
           alterStatements.push(`ALTER TABLE email_dlq ADD COLUMN status TEXT DEFAULT 'open'`);
       }
       if (!names.has('replay_count')) {
           alterStatements.push(`ALTER TABLE email_dlq ADD COLUMN replay_count INTEGER DEFAULT 0`);
       }
       if (!names.has('updated_at')) {
           alterStatements.push(`ALTER TABLE email_dlq ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
       }
       if (!names.has('replayed_at')) {
           alterStatements.push(`ALTER TABLE email_dlq ADD COLUMN replayed_at DATETIME`);
       }
       if (!names.has('last_replay_error')) {
           alterStatements.push(`ALTER TABLE email_dlq ADD COLUMN last_replay_error TEXT`);
       }
       for (const stmt of alterStatements) {
           await new Promise((resolve, reject) => {
               this.db.run(stmt, (err) => {
                   if (err) {
                       const message = String(err.message || '').toLowerCase();
                       if (message.includes('duplicate column name')) {
                           resolve();
                           return;
                       }
                       reject(err);
                   } else {
                       resolve();
                   }
               });
           });
       }
       await new Promise((resolve, reject) => {
           this.db.run(
               `CREATE INDEX IF NOT EXISTS idx_email_dlq_status ON email_dlq(status)`,
               (err) => {
                   if (err) reject(err);
                   else resolve();
               },
           );
       });
       await new Promise((resolve, reject) => {
           this.db.run(
               `CREATE INDEX IF NOT EXISTS idx_email_dlq_created_at ON email_dlq(created_at)`,
               (err) => {
                   if (err) reject(err);
                   else resolve();
               },
           );
       });
       this.emailDlqColumnsEnsured = true;
   }

   async ensureEmailTemplateColumns(columns = []) {
       if (!columns.length) return;
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(email_templates)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const names = new Set(existing.map((row) => row.name));
       const addColumn = (name, definition) => new Promise((resolve, reject) => {
           this.db.run(`ALTER TABLE email_templates ADD COLUMN ${name} ${definition}`, (err) => {
               if (err) {
                   const message = String(err.message || '').toLowerCase();
                   if (message.includes('duplicate column name')) {
                       resolve();
                       return;
                   }
                   reject(err);
               } else {
                   resolve();
               }
           });
       });
       for (const column of columns) {
           if (names.has(column)) continue;
           if (column === 'version') {
               await addColumn('version', 'INTEGER DEFAULT 1');
           } else if (column === 'lifecycle_state') {
               await addColumn('lifecycle_state', "TEXT DEFAULT 'draft'");
           } else if (column === 'submitted_for_review_at') {
               await addColumn('submitted_for_review_at', 'DATETIME');
           } else if (column === 'reviewed_at') {
               await addColumn('reviewed_at', 'DATETIME');
           } else if (column === 'reviewed_by') {
               await addColumn('reviewed_by', 'TEXT');
           } else if (column === 'review_note') {
               await addColumn('review_note', 'TEXT');
           } else if (column === 'live_at') {
               await addColumn('live_at', 'DATETIME');
           } else if (column === 'live_by') {
               await addColumn('live_by', 'TEXT');
           }
       }
   }

   async ensureEmailQueueColumns() {
       if (this.emailQueueColumnsEnsured) {
           return;
       }
       const existing = await new Promise((resolve, reject) => {
           this.db.all('PRAGMA table_info(email_messages)', (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
       const names = new Set(existing.map((row) => row.name));
       const alterStatements = [];
       if (!names.has('queue_lock_token')) {
           alterStatements.push('ALTER TABLE email_messages ADD COLUMN queue_lock_token TEXT');
       }
       if (!names.has('queue_lock_expires_at_ms')) {
           alterStatements.push('ALTER TABLE email_messages ADD COLUMN queue_lock_expires_at_ms INTEGER');
       }
       for (const stmt of alterStatements) {
           await new Promise((resolve, reject) => {
               this.db.run(stmt, (err) => {
                   if (err) {
                       const message = String(err.message || '').toLowerCase();
                       if (message.includes('duplicate column name')) {
                           resolve();
                           return;
                       }
                       reject(err);
                   } else {
                       resolve();
                   }
               });
           });
       }
       await new Promise((resolve, reject) => {
           this.db.run(
               'CREATE INDEX IF NOT EXISTS idx_email_messages_queue_lock ON email_messages(queue_lock_expires_at_ms)',
               (err) => {
                   if (err) reject(err);
                   else resolve();
               },
           );
       });
       this.emailQueueColumnsEnsured = true;
   }

   // Save SMS message
   async saveSMSMessage(messageData) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO sms_messages (
               message_sid, to_number, from_number, body, status, 
               direction, provider, ai_response, response_message_sid, user_chat_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

           this.db.run(sql, [
               messageData.message_sid,
               messageData.to_number || null,
               messageData.from_number || null,
               messageData.body,
               messageData.status || 'queued',
               messageData.direction,
               messageData.provider || null,
               messageData.ai_response || null,
               messageData.response_message_sid || null,
               messageData.user_chat_id || null
           ], function (err) {
               if (err) {
                   console.error('Error saving SMS message:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   // Update SMS status
   async updateSMSStatus(messageSid, statusData) {
       return new Promise((resolve, reject) => {
           const sql = `UPDATE sms_messages 
               SET status = ?, error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP 
               WHERE message_sid = ?`;

           this.db.run(sql, [
               statusData.status,
               statusData.error_code || null,
               statusData.error_message || null,
               messageSid
           ], function (err) {
               if (err) {
                   console.error('Error updating SMS status:', err);
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
   }

   async setSmsOptOut(phoneNumber, reason = null) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO sms_opt_outs (phone_number, reason, opted_out, updated_at)
               VALUES (?, ?, 1, CURRENT_TIMESTAMP)
               ON CONFLICT(phone_number) DO UPDATE SET
               reason = excluded.reason,
               opted_out = 1,
               updated_at = CURRENT_TIMESTAMP`;
           this.db.run(sql, [phoneNumber, reason], function (err) {
               if (err) {
                   console.error('Error setting SMS opt-out:', err);
                   reject(err);
               } else {
                   resolve(true);
               }
           });
       });
   }

   async clearSmsOptOut(phoneNumber) {
       return new Promise((resolve, reject) => {
           const sql = `UPDATE sms_opt_outs SET opted_out = 0, updated_at = CURRENT_TIMESTAMP WHERE phone_number = ?`;
           this.db.run(sql, [phoneNumber], function (err) {
               if (err) {
                   console.error('Error clearing SMS opt-out:', err);
                   reject(err);
               } else {
                   resolve(true);
               }
           });
       });
   }

   async isSmsOptedOut(phoneNumber) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT opted_out FROM sms_opt_outs WHERE phone_number = ?`;
           this.db.get(sql, [phoneNumber], (err, row) => {
               if (err) {
                   console.error('Error checking SMS opt-out:', err);
                   reject(err);
               } else {
                   resolve(row ? row.opted_out === 1 : false);
               }
           });
       });
   }

   async saveSmsIdempotency(idempotencyKey, messageSid, toNumber, bodyHash) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT OR IGNORE INTO sms_idempotency (idempotency_key, message_sid, to_number, body_hash)
               VALUES (?, ?, ?, ?)`;
           this.db.run(sql, [idempotencyKey, messageSid, toNumber, bodyHash], function (err) {
               if (err) {
                   console.error('Error saving SMS idempotency:', err);
                   reject(err);
               } else {
                   resolve(true);
               }
           });
       });
   }

   async checkAndConsumeOutboundRateLimit({
       scope,
       key,
       limit,
       windowMs,
       nowMs = Date.now(),
   } = {}) {
       const safeLimit = Number(limit);
       const safeWindowMs = Number(windowMs);
       if (!Number.isFinite(safeLimit) || safeLimit <= 0) {
           return { allowed: true, retryAfterMs: 0, count: 0 };
       }
       if (!Number.isFinite(safeWindowMs) || safeWindowMs <= 0) {
           return { allowed: true, retryAfterMs: 0, count: 0 };
       }

       const resolvedScope = String(scope || 'outbound');
       const resolvedKey = String(key || 'anonymous');
       const bucketStart = Math.floor(Number(nowMs) / safeWindowMs) * safeWindowMs;

       const upsertSql = `
           INSERT INTO outbound_rate_limits (scope, actor_key, window_start, count, updated_at)
           VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT(scope, actor_key) DO UPDATE SET
               count = CASE
                   WHEN outbound_rate_limits.window_start = excluded.window_start THEN
                       outbound_rate_limits.count + 1
                   ELSE 1
               END,
               window_start = excluded.window_start,
               updated_at = CURRENT_TIMESTAMP
       `;

       await new Promise((resolve, reject) => {
           this.db.run(
               upsertSql,
               [resolvedScope, resolvedKey, bucketStart],
               (err) => {
                   if (err) reject(err);
                   else resolve();
               },
           );
       });

       const row = await new Promise((resolve, reject) => {
           this.db.get(
               `SELECT count, window_start FROM outbound_rate_limits WHERE scope = ? AND actor_key = ?`,
               [resolvedScope, resolvedKey],
               (err, result) => {
                   if (err) reject(err);
                   else resolve(result || null);
               },
           );
       });

       const count = Number(row?.count || 0);
       const windowStart = Number(row?.window_start || bucketStart);
       const retryAfterMs = Math.max(0, windowStart + safeWindowMs - Number(nowMs));
       const allowed = count <= safeLimit;

       const cleanupIntervalMs = Math.max(60000, safeWindowMs * 10);
       if (Number(nowMs) - this.outboundRateLastCleanupMs >= cleanupIntervalMs) {
           this.outboundRateLastCleanupMs = Number(nowMs);
           const staleBeforeMs = Number(nowMs) - Math.max(cleanupIntervalMs, safeWindowMs);
           this.cleanupOutboundRateLimits(staleBeforeMs).catch(() => {});
       }

       return {
           allowed,
           retryAfterMs: allowed ? 0 : retryAfterMs,
           count,
           limit: safeLimit,
           windowStart,
       };
   }

   async cleanupOutboundRateLimits(staleBeforeMs) {
       const threshold = Number(staleBeforeMs);
       if (!Number.isFinite(threshold)) return 0;
       return new Promise((resolve, reject) => {
           this.db.run(
               `DELETE FROM outbound_rate_limits WHERE window_start < ?`,
               [threshold],
               function (err) {
                   if (err) reject(err);
                   else resolve(this.changes || 0);
               },
           );
       });
   }

   async getSmsIdempotency(idempotencyKey) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM sms_idempotency WHERE idempotency_key = ?`;
           this.db.get(sql, [idempotencyKey], (err, row) => {
               if (err) {
                   console.error('Error fetching SMS idempotency:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   // Log bulk SMS operation
   async logBulkSMSOperation(operationData) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO bulk_sms_operations (
               total_recipients, successful, failed, message, user_chat_id
           ) VALUES (?, ?, ?, ?, ?)`;

           this.db.run(sql, [
               operationData.total_recipients,
               operationData.successful,
               operationData.failed,
               operationData.message,
               operationData.user_chat_id || null
           ], function (err) {
               if (err) {
                   console.error('Error logging bulk SMS operation:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   // Get SMS messages
   async getSMSMessages(limit = 50, offset = 0) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM sms_messages 
               ORDER BY created_at DESC 
               LIMIT ? OFFSET ?`;

           this.db.all(sql, [limit, offset], (err, rows) => {
               if (err) {
                   console.error('Error getting SMS messages:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async getSmsMessagesForReconcile({ statuses = [], olderThanMinutes = 15, limit = 50 } = {}) {
       const normalizedStatuses = Array.isArray(statuses)
           ? statuses
               .map((item) => String(item || '').trim().toLowerCase())
               .filter(Boolean)
           : [];
       if (!normalizedStatuses.length) {
           return [];
       }
       const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
       const staleMinutes = Math.max(1, Number(olderThanMinutes) || 15);
       const placeholders = normalizedStatuses.map(() => '?').join(', ');
       const sql = `
           SELECT message_sid, status, provider, error_code, error_message, updated_at
           FROM sms_messages
           WHERE direction = 'outbound'
             AND message_sid IS NOT NULL
             AND LOWER(COALESCE(status, '')) IN (${placeholders})
             AND datetime(updated_at) <= datetime('now', ?)
           ORDER BY datetime(updated_at) ASC
           LIMIT ?
       `;
       const staleExpr = `-${staleMinutes} minutes`;
       return new Promise((resolve, reject) => {
           this.db.all(
               sql,
               [...normalizedStatuses, staleExpr, safeLimit],
               (err, rows) => {
                   if (err) {
                       console.error('Error getting stale SMS messages for reconcile:', err);
                       reject(err);
                   } else {
                       resolve(rows || []);
                   }
               },
           );
       });
   }

   // Get SMS conversation
   async getSMSConversation(phoneNumber, limit = 50) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM sms_messages 
               WHERE to_number = ? OR from_number = ? 
               ORDER BY created_at ASC 
               LIMIT ?`;

           this.db.all(sql, [phoneNumber, phoneNumber, limit], (err, rows) => {
               if (err) {
                   console.error('Error getting SMS conversation:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   normalizeSmsScriptRow(row = {}) {
       if (!row || typeof row !== 'object') return null;
       let metadata = {};
       if (row.metadata) {
           try {
               const parsed = JSON.parse(row.metadata);
               if (parsed && typeof parsed === 'object') {
                   metadata = parsed;
               }
           } catch (_) {
               metadata = {};
           }
       }
       const lifecycle = String(row.lifecycle_state || 'draft').trim().toLowerCase();
       const lifecycleState = ['draft', 'review', 'approved', 'live'].includes(lifecycle)
           ? lifecycle
           : 'draft';
       const parsedVersion = Number(row.version);
       const version = Number.isFinite(parsedVersion) && parsedVersion > 0
           ? Math.max(1, Math.floor(parsedVersion))
           : 1;
       return {
           name: row.name,
           description: row.description || null,
           content: row.content || '',
           metadata,
           version,
           lifecycle_state: lifecycleState,
           submitted_for_review_at: row.submitted_for_review_at || null,
           reviewed_at: row.reviewed_at || null,
           reviewed_by: row.reviewed_by || null,
           review_note: row.review_note || null,
           live_at: row.live_at || null,
           live_by: row.live_by || null,
           is_live: lifecycleState === 'live',
           created_by: row.created_by || null,
           updated_by: row.updated_by || null,
           created_at: row.created_at || null,
           updated_at: row.updated_at || null,
       };
   }

   async listSmsScripts() {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT name, description, content, metadata, version,
                      lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                      created_by, updated_by, created_at, updated_at
               FROM sms_scripts
               ORDER BY datetime(updated_at) DESC, name COLLATE NOCASE ASC
           `;
           this.db.all(sql, [], (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve((rows || []).map((row) => this.normalizeSmsScriptRow(row)).filter(Boolean));
               }
           });
       });
   }

   async getSmsScript(name) {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT name, description, content, metadata, version,
                      lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                      created_by, updated_by, created_at, updated_at
               FROM sms_scripts
               WHERE name = ?
           `;
           this.db.get(sql, [name], (err, row) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(row ? this.normalizeSmsScriptRow(row) : null);
               }
           });
       });
   }

   async createSmsScript(payload = {}) {
       const metadata = payload.metadata && typeof payload.metadata === 'object'
           ? JSON.stringify(payload.metadata)
           : null;
       const lifecycle = String(payload.lifecycle_state || 'draft').trim().toLowerCase();
       const lifecycleState = ['draft', 'review', 'approved', 'live'].includes(lifecycle)
           ? lifecycle
           : 'draft';
       const parsedVersion = Number(payload.version);
       const version = Number.isFinite(parsedVersion) && parsedVersion > 0
           ? Math.max(1, Math.floor(parsedVersion))
           : 1;
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO sms_scripts (
                   name, description, content, metadata, version,
                   lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                   created_by, updated_by, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           `;
           this.db.run(
               sql,
               [
                   payload.name,
                   payload.description || null,
                   payload.content || '',
                   metadata,
                   version,
                   lifecycleState,
                   payload.submitted_for_review_at || null,
                   payload.reviewed_at || null,
                   payload.reviewed_by || null,
                   payload.review_note || null,
                   payload.live_at || null,
                   payload.live_by || null,
                   payload.created_by || null,
                   payload.created_by || payload.updated_by || null,
               ],
               function (err) {
                   if (err) {
                       reject(err);
                   } else {
                       resolve(this.changes || 0);
                   }
               },
           );
       });
   }

   async updateSmsScript(name, payload = {}) {
       const fields = [];
       const values = [];
       if (payload.description !== undefined) {
           fields.push('description = ?');
           values.push(payload.description || null);
       }
       if (payload.content !== undefined) {
           fields.push('content = ?');
           values.push(payload.content || '');
       }
       if (payload.metadata !== undefined) {
           const metadata = payload.metadata && typeof payload.metadata === 'object'
               ? JSON.stringify(payload.metadata)
               : null;
           fields.push('metadata = ?');
           values.push(metadata);
       }
       if (payload.updated_by !== undefined) {
           fields.push('updated_by = ?');
           values.push(payload.updated_by || null);
       }
       if (!fields.length) {
           return 0;
       }
       fields.push('version = COALESCE(version, 1) + 1');
       fields.push('updated_at = CURRENT_TIMESTAMP');
       values.push(name);
       return new Promise((resolve, reject) => {
           const sql = `UPDATE sms_scripts SET ${fields.join(', ')} WHERE name = ?`;
           this.db.run(sql, values, function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async deleteSmsScript(name) {
       return new Promise((resolve, reject) => {
           this.db.run('DELETE FROM sms_scripts WHERE name = ?', [name], function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async listSmsScriptVersions(scriptName, limit = 20) {
       const safeLimit = Number.isFinite(Number(limit))
           ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
           : 20;
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT id, script_name, version, snapshot, reason, created_by, created_at
               FROM sms_script_versions
               WHERE script_name = ?
               ORDER BY version DESC
               LIMIT ?
           `;
           this.db.all(sql, [scriptName, safeLimit], (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async getSmsScriptVersion(scriptName, version) {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT id, script_name, version, snapshot, reason, created_by, created_at
               FROM sms_script_versions
               WHERE script_name = ? AND version = ?
               LIMIT 1
           `;
           this.db.get(sql, [scriptName, version], (err, row) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async saveSmsScriptVersion(scriptName, version, snapshot, options = {}) {
       const safeVersion = Number.isFinite(Number(version))
           ? Math.max(1, Math.floor(Number(version)))
           : 1;
       const reason = options.reason ? String(options.reason).slice(0, 120) : null;
       const createdBy = options.created_by ? String(options.created_by).slice(0, 120) : null;
       const serializedSnapshot = typeof snapshot === 'string'
           ? snapshot
           : JSON.stringify(snapshot || {});
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO sms_script_versions (
                   script_name, version, snapshot, reason, created_by, created_at
               )
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(script_name, version) DO UPDATE SET
                   snapshot = excluded.snapshot,
                   reason = excluded.reason,
                   created_by = excluded.created_by,
                   created_at = CURRENT_TIMESTAMP
           `;
           this.db.run(sql, [scriptName, safeVersion, serializedSnapshot, reason, createdBy], function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async setSmsScriptLifecycle(scriptName, updates = {}) {
       const fields = [];
       const values = [];
       const mapping = {
           lifecycle_state: 'lifecycle_state',
           submitted_for_review_at: 'submitted_for_review_at',
           reviewed_at: 'reviewed_at',
           reviewed_by: 'reviewed_by',
           review_note: 'review_note',
           live_at: 'live_at',
           live_by: 'live_by',
       };
       Object.entries(mapping).forEach(([key, column]) => {
           if (!Object.prototype.hasOwnProperty.call(updates, key)) return;
           let value = updates[key];
           if (key === 'lifecycle_state') {
               const normalized = String(value || '').trim().toLowerCase();
               value = ['draft', 'review', 'approved', 'live'].includes(normalized)
                   ? normalized
                   : 'draft';
           } else if (key === 'review_note') {
               value = value === null || value === undefined ? null : String(value).slice(0, 500);
           } else {
               value = value === null || value === undefined ? null : String(value);
           }
           fields.push(`${column} = ?`);
           values.push(value);
       });
       if (!fields.length) {
           return 0;
       }
       fields.push('updated_at = CURRENT_TIMESTAMP');
       values.push(scriptName);
       return new Promise((resolve, reject) => {
           const sql = `UPDATE sms_scripts SET ${fields.join(', ')} WHERE name = ?`;
           this.db.run(sql, values, function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async promoteSmsScriptLive(scriptName, actor = null) {
       const safeActor = actor === null || actor === undefined ? null : String(actor).slice(0, 120);
       return new Promise((resolve, reject) => {
           const dbConn = this.db;
           dbConn.serialize(() => {
               dbConn.run('BEGIN TRANSACTION');
               dbConn.run(
                   `UPDATE sms_scripts
                    SET lifecycle_state = 'approved',
                        live_at = NULL,
                        live_by = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE lifecycle_state = 'live' AND name != ?`,
                   [scriptName],
                   (demoteErr) => {
                       if (demoteErr) {
                           dbConn.run('ROLLBACK');
                           reject(demoteErr);
                           return;
                       }
                       dbConn.run(
                           `UPDATE sms_scripts
                            SET lifecycle_state = 'live',
                                live_at = CURRENT_TIMESTAMP,
                                live_by = ?,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE name = ?`,
                           [safeActor, scriptName],
                           function (promoteErr) {
                               if (promoteErr) {
                                   dbConn.run('ROLLBACK');
                                   reject(promoteErr);
                                   return;
                               }
                               if (this.changes === 0) {
                                   dbConn.run('ROLLBACK');
                                   resolve(0);
                                   return;
                               }
                               const promotedChanges = this.changes;
                               dbConn.run('COMMIT', (commitErr) => {
                                   if (commitErr) {
                                       dbConn.run('ROLLBACK');
                                       reject(commitErr);
                                   } else {
                                       resolve(promotedChanges);
                                   }
                               });
                           },
                       );
                   },
               );
           });
       });
   }

   async upsertPostCallAutomationRule(rule = {}) {
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO post_call_automation_rules (
                   rule_id, name, enabled, trigger_event, conditions_json, actions_json, priority, created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT(rule_id) DO UPDATE SET
                   name = excluded.name,
                   enabled = excluded.enabled,
                   trigger_event = excluded.trigger_event,
                   conditions_json = excluded.conditions_json,
                   actions_json = excluded.actions_json,
                   priority = excluded.priority,
                   updated_at = CURRENT_TIMESTAMP
           `;
           this.db.run(
               sql,
               [
                   rule.rule_id,
                   rule.name,
                   rule.enabled === false || rule.enabled === 0 ? 0 : 1,
                   rule.trigger_event,
                   rule.conditions_json || '{}',
                   rule.actions_json || '[]',
                   Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 100,
               ],
               function (err) {
                   if (err) {
                       console.error('Error upserting post-call automation rule:', err);
                       reject(err);
                   } else {
                       resolve(this.changes || 0);
                   }
               },
           );
       });
   }

   async getPostCallAutomationRule(ruleId) {
       return new Promise((resolve, reject) => {
           this.db.get(
               'SELECT * FROM post_call_automation_rules WHERE rule_id = ?',
               [ruleId],
               (err, row) => {
                   if (err) {
                       console.error('Error fetching post-call automation rule:', err);
                       reject(err);
                   } else {
                       resolve(row || null);
                   }
               },
           );
       });
   }

   async createPostCallWorkflowDefinitionDraft(definition = {}) {
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO post_call_workflow_definitions (
                   workflow_id, version, business_id, name, trigger_event, schema_version, status,
                   definition_json, created_by, created_at
               )
               SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, 'draft', ?, ?, CURRENT_TIMESTAMP
               FROM post_call_workflow_definitions
               WHERE workflow_id = ? AND business_id IS ?
               RETURNING *
           `;
           this.db.get(sql, [
               definition.workflow_id,
<<<<<<< HEAD
               definition.business_id || null,
=======
               definition.business_id ?? null,
>>>>>>> 95a068c (updated)
               definition.name,
               definition.trigger_event,
               definition.schema_version,
               definition.definition_json,
               definition.created_by,
               definition.workflow_id,
               definition.business_id ?? null,
           ], (err, row) => {
               if (err) {
                   reject(err);
                   return;
               }
               resolve(row || null);
           });
       });
   }

   async getPostCallWorkflowDefinition(workflowId, version, businessId = undefined) {
       return new Promise((resolve, reject) => {
           const scoped = businessId !== undefined;
           this.db.get(
               `SELECT * FROM post_call_workflow_definitions WHERE workflow_id = ? AND version = ?${scoped ? ' AND business_id IS ?' : ''}`,
               scoped ? [workflowId, version, businessId] : [workflowId, version],
               (err, row) => err ? reject(err) : resolve(row || null),
           );
       });
   }

   async getLatestPostCallWorkflowDefinition(workflowId, businessId = undefined) {
       return new Promise((resolve, reject) => {
           const scoped = businessId !== undefined;
           this.db.get(
               `SELECT * FROM post_call_workflow_definitions WHERE workflow_id = ?${scoped ? ' AND business_id IS ?' : ''} ORDER BY version DESC LIMIT 1`,
               scoped ? [workflowId, businessId] : [workflowId],
               (err, row) => err ? reject(err) : resolve(row || null),
           );
       });
   }

   async listPostCallWorkflowDefinitions(filters = {}) {
       const params = [];
       const where = [];
       if (filters.workflow_id) {
           where.push('workflow_id = ?');
           params.push(filters.workflow_id);
       }
       if (Object.prototype.hasOwnProperty.call(filters, 'business_id')) {
           where.push('business_id IS ?');
           params.push(filters.business_id ?? null);
       }
       const safeLimit = Number.isFinite(Number(filters.limit))
           ? Math.max(1, Math.min(200, Math.floor(Number(filters.limit))))
           : 100;
       params.push(safeLimit);
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT * FROM post_call_workflow_definitions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY workflow_id ASC, version DESC LIMIT ?`,
               params,
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
   }

   async listApprovedPostCallWorkflowDefinitionsByEvent(triggerEvent, businessId = null) {
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT definition.* FROM post_call_workflow_definitions AS definition
                WHERE definition.status = 'approved' AND definition.trigger_event = ?
                  AND definition.business_id IS ?
                  AND NOT EXISTS (
                      SELECT 1 FROM post_call_workflow_definitions AS newer
                      WHERE newer.workflow_id = definition.workflow_id
                        AND newer.business_id IS definition.business_id
                        AND newer.status = 'approved' AND newer.version > definition.version
                  )
                ORDER BY definition.workflow_id ASC LIMIT 100`,
               [triggerEvent, businessId],
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
   }

   async createPostCallWorkflowEvent(event = {}) {
       const now = new Date().toISOString();
       await new Promise((resolve, reject) => {
           this.db.run(
               `INSERT OR IGNORE INTO post_call_workflow_events (
                   event_id, event_key, business_id, trigger_event, definition_versions_json, payload_json, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
               [event.event_id, event.event_key, event.business_id ?? null, event.trigger_event, event.definition_versions_json, event.payload_json, now, now],
               (err) => err ? reject(err) : resolve(),
           );
       });
       return this.getPostCallWorkflowEventByKey(event.event_key);
   }

   async getPostCallWorkflowEvent(eventId) {
       return new Promise((resolve, reject) => {
           this.db.get('SELECT * FROM post_call_workflow_events WHERE event_id = ?', [eventId],
               (err, row) => err ? reject(err) : resolve(row || null));
       });
   }

   async getPostCallWorkflowEventByKey(eventKey) {
       return new Promise((resolve, reject) => {
           this.db.get('SELECT * FROM post_call_workflow_events WHERE event_key = ?', [eventKey],
               (err, row) => err ? reject(err) : resolve(row || null));
       });
   }

   async listPendingPostCallWorkflowEvents(limit = 100) {
       const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT * FROM post_call_workflow_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
               [safeLimit], (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
   }

   async reservePostCallWorkflowEventDispatch(eventId, { now = new Date().toISOString(), staleBefore = now } = {}) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_events SET last_enqueued_at = ?, updated_at = ?
                WHERE event_id = ? AND status = 'pending'
                  AND (last_enqueued_at IS NULL OR julianday(last_enqueued_at) <= julianday(?))`,
               [now, now, eventId, staleBefore],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async claimPostCallWorkflowEvent(eventId, { now = new Date().toISOString(), staleBefore = now } = {}) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_events SET status = 'processing', locked_at = ?, updated_at = ?, error_code = NULL
                WHERE event_id = ? AND (
                    status = 'pending' OR (status = 'processing' AND julianday(updated_at) <= julianday(?))
                )`,
               [now, now, eventId, staleBefore],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async completePostCallWorkflowEvent(eventId) {
       const now = new Date().toISOString();
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_events SET status = 'completed', locked_at = NULL,
                   error_code = NULL, payload_json = '{}', updated_at = ?, processed_at = ?
                WHERE event_id = ? AND status = 'processing'`,
               [now, now, eventId], function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async resetPostCallWorkflowEvent(eventId, errorCode = 'workflow_event_processing_failed') {
       const now = new Date().toISOString();
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_events SET status = 'pending', locked_at = NULL,
                   error_code = ?, updated_at = ?
                WHERE event_id = ? AND status = 'processing'`,
               [errorCode, now, eventId], function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async requeueStalePostCallWorkflowEvents({ now = new Date().toISOString(), staleBefore = now } = {}) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_events SET status = 'pending', locked_at = NULL,
                   error_code = 'event_processing_interrupted', updated_at = ?
                WHERE status = 'processing' AND julianday(updated_at) <= julianday(?)`,
               [now, staleBefore], function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async approvePostCallWorkflowDefinition(workflowId, version, approvedBy, businessId = undefined) {
       return new Promise((resolve, reject) => {
           const scoped = businessId !== undefined;
           this.db.run(
               `UPDATE post_call_workflow_definitions
                SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
                WHERE workflow_id = ? AND version = ? AND status = 'draft'${scoped ? ' AND business_id IS ?' : ''}`,
               scoped ? [approvedBy, workflowId, version, businessId] : [approvedBy, workflowId, version],
               function (err) {
                   if (err) reject(err);
                   else resolve(this.changes || 0);
               },
           );
       });
   }

<<<<<<< HEAD
   async approveCallEResultWorkflowActions(input = {}) {
       const workflowId = String(input.workflow_id || '').trim();
       const version = Number(input.version);
       const businessId = String(input.business_id || '').trim();
       const actorId = String(input.approved_by || '').trim();
       const requestHash = String(input.request_hash || '').trim().toLowerCase();
       if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId) || !Number.isSafeInteger(version) || version < 1 ||
           !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) || !/^[a-f0-9]{64}$/.test(requestHash)) {
           throw Object.assign(new Error('CALL-E result workflow approval is invalid'), { code: 'call_e_result_workflow_approval_invalid' });
       }
       let release;
       const previous = this.callECampaignWriteChain;
       this.callECampaignWriteChain = new Promise((resolve) => { release = resolve; });
       await previous;
       const run = (sql, params = []) => new Promise((resolve, reject) => this.db.run(sql, params, function (error) {
           if (error) return reject(error);
           resolve({ changes: this.changes || 0 });
       }));
       const get = (sql, params = []) => new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
       let transactionStarted = false;
       try {
           await run('BEGIN IMMEDIATE'); transactionStarted = true;
           const definition = await get('SELECT * FROM post_call_workflow_definitions WHERE workflow_id = ? AND version = ?', [workflowId, version]);
           if (!definition || definition.trigger_event !== 'call_e_result_ready' || definition.business_id !== businessId) {
               await run('COMMIT'); transactionStarted = false;
               return { approved: false, not_found: true };
           }
           const existing = await get('SELECT approved_by, request_hash FROM call_e_result_workflow_action_approvals WHERE workflow_id = ? AND version = ?', [workflowId, version]);
           if (existing) {
               const replay = existing.approved_by === actorId && existing.request_hash === requestHash;
               await run('COMMIT'); transactionStarted = false;
               return { approved: replay, idempotent_replay: replay, conflict: !replay };
           }
           if (definition.status !== 'draft' && definition.status !== 'approved') {
               await run('COMMIT'); transactionStarted = false;
               return { approved: false, not_draft: true };
           }
           if (definition.status === 'draft') {
               await run(`UPDATE post_call_workflow_definitions SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
                   WHERE workflow_id = ? AND version = ? AND status = 'draft'`, [actorId, workflowId, version]);
           }
           await run(`INSERT INTO call_e_result_workflow_action_approvals (workflow_id, version, business_id, approved_by, request_hash)
               VALUES (?, ?, ?, ?, ?)`, [workflowId, version, businessId, actorId, requestHash]);
           await run('COMMIT'); transactionStarted = false;
           return { approved: true, idempotent_replay: false };
       } catch (error) {
           if (transactionStarted) { try { await run('ROLLBACK'); } catch (_) { /* Preserve original transaction failure. */ } }
           throw error;
       } finally { release(); }
   }

   async getCallEResultWorkflowActionApproval(workflowId, version, businessId) {
       return new Promise((resolve, reject) => this.db.get(
           `SELECT workflow_id, version, business_id, approved_by, created_at FROM call_e_result_workflow_action_approvals
            WHERE workflow_id = ? AND version = ? AND business_id = ?`,
           [String(workflowId || ''), Number(version), String(businessId || '')],
           (error, row) => error ? reject(error) : resolve(row || null),
       ));
   }

   async listApprovedPostCallWorkflowDefinitions(triggerEvent, businessId = null) {
       const scoped = triggerEvent === 'call_e_result_ready';
       if ((scoped && !businessId) || (!scoped && businessId)) return [];
       const scopeClause = scoped ? 'business_id = ?' : 'business_id IS NULL';
       const params = scoped
           ? [triggerEvent, businessId, triggerEvent, businessId]
           : [triggerEvent, triggerEvent];
       const rows = await new Promise((resolve, reject) => {
           this.db.all(
               `SELECT d.* FROM post_call_workflow_definitions d
                INNER JOIN (
                    SELECT workflow_id, MAX(version) AS version
                    FROM post_call_workflow_definitions
                    WHERE status = 'approved' AND trigger_event = ? AND ${scopeClause}
                    GROUP BY workflow_id
                ) latest ON latest.workflow_id = d.workflow_id AND latest.version = d.version
                WHERE d.status = 'approved' AND d.trigger_event = ? AND d.${scopeClause}
                ORDER BY d.workflow_id ASC`,
               params,
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
       if (!scoped) return rows;
       const eligible = [];
       for (const row of rows) {
           let hasActions = false;
           try { hasActions = JSON.parse(row.definition_json || '{}').steps?.some((step) => step.type === 'action') === true; } catch (_) { hasActions = true; }
           if (!hasActions || await this.getCallEResultWorkflowActionApproval(row.workflow_id, row.version, businessId)) eligible.push(row);
       }
       return eligible;
   }

   async createPostCallWorkflowRun(run = {}) {
       const insertSql = `INSERT OR IGNORE INTO post_call_workflow_runs (
           run_id, workflow_id, workflow_version, business_id, trigger_event, trigger_reference, idempotency_key,
           status, current_step_id, payload_json, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
       await new Promise((resolve, reject) => {
           this.db.run(insertSql, [
               run.run_id,
               run.workflow_id,
               run.workflow_version,
               run.business_id || null,
               run.trigger_event,
               run.trigger_reference || null,
               run.idempotency_key,
               run.current_step_id,
               run.payload_json,
               run.expires_at,
           ], function (err) { err ? reject(err) : resolve(); });
       });
       const row = await new Promise((resolve, reject) => {
           this.db.get(
               'SELECT * FROM post_call_workflow_runs WHERE idempotency_key = ?',
               [run.idempotency_key],
               (err, result) => err ? reject(err) : resolve(result || null),
           );
       });
       return { row, created: row?.run_id === run.run_id };
   }

   async getPostCallWorkflowRun(runId) {
       return new Promise((resolve, reject) => {
           this.db.get(
               'SELECT * FROM post_call_workflow_runs WHERE run_id = ?',
               [runId],
               (err, row) => err ? reject(err) : resolve(row || null),
           );
       });
   }

   async listPostCallWorkflowRuns(filters = {}) {
       const where = [];
       const params = [];
       if (filters.business_id) { where.push('business_id = ?'); params.push(String(filters.business_id)); }
       if (filters.trigger_event) { where.push('trigger_event = ?'); params.push(String(filters.trigger_event)); }
       if (filters.workflow_id) { where.push('workflow_id = ?'); params.push(filters.workflow_id); }
       if (filters.trigger_reference) { where.push('trigger_reference = ?'); params.push(filters.trigger_reference); }
       if (filters.status) { where.push('status = ?'); params.push(filters.status); }
       const limit = Number.isSafeInteger(Number(filters.limit))
           ? Math.max(1, Math.min(200, Number(filters.limit)))
           : 50;
       params.push(limit);
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT run_id, workflow_id, workflow_version, business_id, trigger_event, trigger_reference, status,
                       current_step_id, error_code, next_run_at, started_at, completed_at,
                       canceled_by, expires_at, created_at, updated_at
                FROM post_call_workflow_runs
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY created_at DESC LIMIT ?`,
               params,
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
   }

   async listPostCallWorkflowStepRuns(runId) {
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT step_id, step_type, action_type, status, error_code, approved_by,
                       started_at, completed_at
                FROM post_call_workflow_step_runs WHERE run_id = ? ORDER BY started_at ASC`,
               [runId],
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
   }

   async updatePostCallWorkflowRun(runId, patch = {}, options = {}) {
       const allowed = new Set([
           'status', 'current_step_id', 'error_code', 'next_run_at', 'runner_id', 'payload_json',
           'lease_expires_at', 'started_at', 'completed_at',
       ]);
       const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
       if (!entries.length) return 0;
       const fields = entries.map(([key]) => `${key} = ?`);
       fields.push('updated_at = CURRENT_TIMESTAMP');
       const values = entries.map(([, value]) => value ?? null);
       let where = 'run_id = ?';
       values.push(runId);
       if (options.runner_id) {
           where += ' AND status = \'running\' AND runner_id = ?';
           values.push(options.runner_id);
       }
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET ${fields.join(', ')} WHERE ${where}`,
               values,
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async claimNextPostCallWorkflowRun(runnerId, leaseSeconds = 90) {
       const candidates = await new Promise((resolve, reject) => {
           this.db.all(
               `SELECT run_id FROM post_call_workflow_runs
                WHERE status IN ('queued', 'waiting')
                  AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)
                ORDER BY created_at ASC LIMIT 20`,
               (err, rows) => err ? reject(err) : resolve(rows || []),
           );
       });
       for (const candidate of candidates) {
           const changed = await new Promise((resolve, reject) => {
               this.db.run(
                   `UPDATE post_call_workflow_runs
                    SET status = 'running', runner_id = ?,
                        lease_expires_at = datetime('now', ?),
                        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE run_id = ? AND status IN ('queued', 'waiting')
                      AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)`,
                   [runnerId, `+${Math.max(30, Math.min(300, Number(leaseSeconds) || 90))} seconds`, candidate.run_id],
                   function (err) { err ? reject(err) : resolve(this.changes || 0); },
               );
           });
           if (!changed) continue;
           return this.getPostCallWorkflowRun(candidate.run_id);
       }
       return null;
   }

   async heartbeatPostCallWorkflowRun(runId, runnerId, leaseSeconds = 90) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs
                SET lease_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND status = 'running' AND runner_id = ?`,
               [`+${Math.max(30, Math.min(300, Number(leaseSeconds) || 90))} seconds`, runId, runnerId],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async recoverStalePostCallWorkflowRuns() {
       const changed = await new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs
                SET status = 'needs_review', error_code = 'worker_interrupted',
                    payload_json = '{}', runner_id = NULL, lease_expires_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE status = 'running' AND lease_expires_at <= CURRENT_TIMESTAMP`,
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
       await new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_step_runs
                SET status = 'needs_review', error_code = COALESCE(error_code, 'worker_interrupted')
                WHERE status = 'running' AND run_id IN (
                    SELECT run_id FROM post_call_workflow_runs WHERE status = 'needs_review'
                )`,
               (err) => err ? reject(err) : resolve(),
           );
       });
       return changed;
   }

   async expirePostCallWorkflowRuns() {
       const changed = await new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs
                SET status = 'needs_review', error_code = 'workflow_run_expired',
                    payload_json = '{}', runner_id = NULL, lease_expires_at = NULL,
                    completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE status IN ('queued', 'waiting', 'waiting_approval')
                  AND expires_at <= CURRENT_TIMESTAMP`,
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
       if (changed) {
           await new Promise((resolve, reject) => {
               this.db.run(
                   `UPDATE post_call_workflow_step_runs
                    SET status = 'needs_review', error_code = 'workflow_run_expired', completed_at = CURRENT_TIMESTAMP
                    WHERE status IN ('waiting', 'waiting_approval') AND run_id IN (
                        SELECT run_id FROM post_call_workflow_runs
                        WHERE status = 'needs_review' AND error_code = 'workflow_run_expired'
                    )`,
                   (err) => err ? reject(err) : resolve(),
               );
           });
       }
       return changed;
   }

   async startPostCallWorkflowStep(step = {}) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `INSERT OR IGNORE INTO post_call_workflow_step_runs (
                   run_id, step_id, next_step_id, step_type, action_type, status, idempotency_key,
                   started_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
               [step.run_id, step.step_id, step.next_step_id || null, step.step_type, step.action_type || null, step.status || 'running', step.idempotency_key || null],
               function (err) { err ? reject(err) : resolve(this.changes === 1); },
=======
   async createPostCallWorkflowRun(run = {}) {
       const now = new Date().toISOString();
       await new Promise((resolve, reject) => {
           this.db.run(
               `INSERT OR IGNORE INTO post_call_workflow_runs (
                   run_id, workflow_id, workflow_version, idempotency_key, trigger_event,
                   status, current_step_id, payload_json, state_json, created_by, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
               [run.run_id, run.workflow_id, run.workflow_version, run.idempotency_key,
                   run.trigger_event, run.current_step_id, run.payload_json, run.state_json,
                   run.created_by, now, now],
               (err) => err ? reject(err) : resolve(),
           );
       });
       return this.getPostCallWorkflowRunByIdempotencyKey(run.idempotency_key);
   }

   async getPostCallWorkflowRun(runId, businessId = undefined) {
       return new Promise((resolve, reject) => {
           const scoped = businessId !== undefined;
           this.db.get(
               `SELECT run.* FROM post_call_workflow_runs AS run
                JOIN post_call_workflow_definitions AS definition
                  ON definition.workflow_id = run.workflow_id AND definition.version = run.workflow_version
                WHERE run.run_id = ?${scoped ? ' AND definition.business_id IS ?' : ''}`,
               scoped ? [runId, businessId] : [runId],
               (err, row) => err ? reject(err) : resolve(row || null));
       });
   }

   async getPostCallWorkflowRunByIdempotencyKey(key) {
       return new Promise((resolve, reject) => {
           this.db.get('SELECT * FROM post_call_workflow_runs WHERE idempotency_key = ?', [key],
               (err, row) => err ? reject(err) : resolve(row || null));
       });
   }

   async listPostCallWorkflowRuns(limit = 100, businessId = undefined) {
       const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
       const scoped = businessId !== undefined;
       return new Promise((resolve, reject) => {
           this.db.all(
               `SELECT run.* FROM post_call_workflow_runs AS run
                JOIN post_call_workflow_definitions AS definition
                  ON definition.workflow_id = run.workflow_id AND definition.version = run.workflow_version
                ${scoped ? 'WHERE definition.business_id IS ?' : ''}
                ORDER BY run.created_at DESC LIMIT ?`,
               scoped ? [businessId, safeLimit] : [safeLimit],
               (err, rows) => err ? reject(err) : resolve(rows || []));
       });
   }

   async claimPostCallWorkflowRun(runId, ownerId, leaseExpiresAt) {
       const now = new Date().toISOString();
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = 'running', updated_at = ?, next_run_at = NULL,
                   execution_owner = ?, lease_expires_at = ?
                WHERE run_id = ? AND (status = 'queued' OR (status = 'waiting' AND next_run_at <= ?))`,
               [now, ownerId, leaseExpiresAt, runId, now], function (err) { err ? reject(err) : resolve(this.changes || 0); },
>>>>>>> 95a068c (updated)
           );
       });
   }

<<<<<<< HEAD
   async finishPostCallWorkflowStep(runId, stepId, patch = {}) {
       const allowed = new Set(['status', 'result_json', 'error_code', 'approved_by']);
       const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
       if (!entries.length) return 0;
       const assignments = entries.map(([key]) => `${key} = ?`);
       assignments.push('completed_at = CURRENT_TIMESTAMP');
       const values = entries.map(([, value]) => value ?? null);
       values.push(runId, stepId);
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_step_runs SET ${assignments.join(', ')} WHERE run_id = ? AND step_id = ?`,
               values,
=======
   async savePostCallWorkflowRun(runId, update = {}) {
       const now = new Date().toISOString();
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = ?, current_step_id = ?, state_json = ?,
                   error_code = ?, next_run_at = ?, updated_at = ?, execution_owner = ?,
                   lease_expires_at = ?,
                   completed_at = CASE WHEN ? IN ('completed', 'failed', 'canceled', 'needs_review') THEN ? ELSE NULL END
                WHERE run_id = ? AND status = 'running' AND execution_owner = ?`,
               [update.status, update.current_step_id || null, update.state_json, update.error_code || null,
                   update.next_run_at || null, now, update.execution_owner || null,
                   update.lease_expires_at || null, update.status, now, runId, update.lock_owner],
>>>>>>> 95a068c (updated)
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

<<<<<<< HEAD
   async approvePostCallWorkflowRunStep(runId, stepId, approvedBy, nextStepId) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_step_runs
                SET status = 'approved', approved_by = ?, completed_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND step_id = ? AND status = 'waiting_approval'
                  AND next_step_id = ?
                  AND EXISTS (
                    SELECT 1 FROM post_call_workflow_runs
                    WHERE run_id = ? AND status = 'waiting_approval' AND current_step_id = ?
                  )`,
               [approvedBy, runId, stepId, nextStepId, runId, stepId],
=======
   async renewPostCallWorkflowRunLease(runId, ownerId, leaseExpiresAt) {
       const now = new Date().toISOString();
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET lease_expires_at = ?, updated_at = ?
                WHERE run_id = ? AND status = 'running' AND execution_owner = ?`,
               [leaseExpiresAt, now, runId, ownerId],
>>>>>>> 95a068c (updated)
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

<<<<<<< HEAD
   async cancelPostCallWorkflowRun(runId, actor) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs
                SET status = 'canceled', error_code = NULL, payload_json = '{}', canceled_by = ?, runner_id = NULL,
                    lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND status IN ('queued', 'waiting', 'waiting_approval')`,
               [actor || 'admin_token', runId],
=======
   async reconcileExpiredPostCallWorkflowRuns({ now = new Date().toISOString(), staleBefore = now } = {}) {
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = 'needs_review', error_code = 'execution_interrupted',
                   execution_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
                WHERE status = 'running' AND (
                    (lease_expires_at IS NOT NULL AND julianday(lease_expires_at) <= julianday(?))
                    OR (lease_expires_at IS NULL AND julianday(updated_at) <= julianday(?))
                )`,
               [now, now, now, staleBefore],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async approvePostCallWorkflowRun(runId, stepId, stateJson, nextStepId, businessId = undefined) {
       const now = new Date().toISOString();
       const scoped = businessId !== undefined;
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = 'queued', current_step_id = ?, state_json = ?, updated_at = ?
                WHERE run_id = ? AND status = 'awaiting_approval' AND current_step_id = ?${scoped ? " AND EXISTS (SELECT 1 FROM post_call_workflow_definitions AS definition WHERE definition.workflow_id = post_call_workflow_runs.workflow_id AND definition.version = post_call_workflow_runs.workflow_version AND definition.business_id IS ?)" : ''}`,
               scoped ? [nextStepId, stateJson, now, runId, stepId, businessId] : [nextStepId, stateJson, now, runId, stepId],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async queuePostCallWorkflowEmailRetry(runId, stepId, expectedUpdatedAt, stateJson, businessId = undefined) {
       const now = new Date().toISOString();
       const scoped = businessId !== undefined;
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = 'queued', state_json = ?, error_code = NULL,
                   next_run_at = NULL, execution_owner = NULL, lease_expires_at = NULL,
                   completed_at = NULL, updated_at = ?
                WHERE run_id = ? AND status = 'failed' AND current_step_id = ? AND updated_at = ?${scoped ? " AND EXISTS (SELECT 1 FROM post_call_workflow_definitions AS definition WHERE definition.workflow_id = post_call_workflow_runs.workflow_id AND definition.version = post_call_workflow_runs.workflow_version AND definition.business_id IS ?)" : ''}`,
               scoped ? [stateJson, now, runId, stepId, expectedUpdatedAt, businessId] : [stateJson, now, runId, stepId, expectedUpdatedAt],
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async cancelPostCallWorkflowRun(runId, businessId = undefined) {
       const now = new Date().toISOString();
       const scoped = businessId !== undefined;
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = 'canceled', updated_at = ?, completed_at = ?
                WHERE run_id = ? AND status IN ('queued', 'waiting', 'awaiting_approval')${scoped ? " AND EXISTS (SELECT 1 FROM post_call_workflow_definitions AS definition WHERE definition.workflow_id = post_call_workflow_runs.workflow_id AND definition.version = post_call_workflow_runs.workflow_version AND definition.business_id IS ?)" : ''}`,
               scoped ? [now, now, runId, businessId] : [now, now, runId], function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async reviewPostCallWorkflowRun(runId, status, decision, actor, stateJson, businessId = undefined) {
       const now = new Date().toISOString();
       const scoped = businessId !== undefined;
       return new Promise((resolve, reject) => {
           this.db.run(
               `UPDATE post_call_workflow_runs SET status = ?, error_code = ?, state_json = ?,
                   reviewed_by = ?, review_decision = ?, reviewed_at = ?, updated_at = ?, completed_at = ?,
                   execution_owner = NULL, lease_expires_at = NULL
                WHERE run_id = ? AND status = 'needs_review'${scoped ? " AND EXISTS (SELECT 1 FROM post_call_workflow_definitions AS definition WHERE definition.workflow_id = post_call_workflow_runs.workflow_id AND definition.version = post_call_workflow_runs.workflow_version AND definition.business_id IS ?)" : ''}`,
               scoped ? [status, status === 'failed' ? 'operator_confirmed_failure' : null, stateJson, actor, decision,
                   now, now, now, runId, businessId] : [status, status === 'failed' ? 'operator_confirmed_failure' : null, stateJson, actor, decision,
                   now, now, now, runId],
>>>>>>> 95a068c (updated)
               function (err) { err ? reject(err) : resolve(this.changes || 0); },
           );
       });
   }

   async listPostCallAutomationRules(filters = {}) {
       const where = [];
       const params = [];
       if (Object.prototype.hasOwnProperty.call(filters, 'enabled')) {
           where.push('enabled = ?');
           params.push(filters.enabled ? 1 : 0);
       }
       if (filters.trigger_event) {
           where.push('trigger_event = ?');
           params.push(filters.trigger_event);
       }
       const safeLimit = Number.isFinite(Number(filters.limit))
           ? Math.max(1, Math.min(200, Math.floor(Number(filters.limit))))
           : 100;
       params.push(safeLimit);
       const sql = `
           SELECT * FROM post_call_automation_rules
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY priority ASC, updated_at DESC
           LIMIT ?
       `;
       return new Promise((resolve, reject) => {
           this.db.all(sql, params, (err, rows) => {
               if (err) {
                   console.error('Error listing post-call automation rules:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async deletePostCallAutomationRule(ruleId) {
       return new Promise((resolve, reject) => {
           this.db.run(
               'DELETE FROM post_call_automation_rules WHERE rule_id = ?',
               [ruleId],
               function (err) {
                   if (err) {
                       console.error('Error deleting post-call automation rule:', err);
                       reject(err);
                   } else {
                       resolve(this.changes || 0);
                   }
               },
           );
       });
   }

   async recordPostCallAutomationRun(run = {}) {
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO post_call_automation_runs (
                   run_id, rule_id, call_sid, trigger_event, status, actions_json, result_json, error, idempotency_key,
                   payload_json, retry_of_run_id, attempt, created_at, updated_at, completed_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
               ON CONFLICT(run_id) DO UPDATE SET
                   status = excluded.status,
                   actions_json = excluded.actions_json,
                   result_json = excluded.result_json,
                   error = excluded.error,
                   payload_json = excluded.payload_json,
                   retry_of_run_id = excluded.retry_of_run_id,
                   attempt = excluded.attempt,
                   updated_at = CURRENT_TIMESTAMP,
                   completed_at = excluded.completed_at
           `;
           const completedAt = ['completed', 'failed'].includes(String(run.status || '').toLowerCase())
               ? new Date().toISOString()
               : null;
           this.db.run(
               sql,
               [
                   run.run_id,
                   run.rule_id,
                   run.call_sid || null,
                   run.trigger_event,
                   run.status,
                   run.actions_json || null,
                   run.result_json || null,
                   run.error || null,
                   run.idempotency_key || null,
                   run.payload_json || null,
                   run.retry_of_run_id || null,
                   Number.isFinite(Number(run.attempt)) ? Math.max(1, Math.floor(Number(run.attempt))) : 1,
                   completedAt,
               ],
               (err) => {
                   if (err) {
                       console.error('Error recording post-call automation run:', err);
                       reject(err);
                   } else {
                       if (run.rule_id && run.status === 'completed') {
                           this.db.run(
                               'UPDATE post_call_automation_rules SET last_run_at = CURRENT_TIMESTAMP WHERE rule_id = ?',
                               [run.rule_id],
                               (updateErr) => {
                                   if (updateErr) {
                                       console.error('Error updating post-call automation rule last_run_at:', updateErr);
                                       reject(updateErr);
                                   } else {
                                       resolve(true);
                                   }
                               },
                           );
                       } else {
                           resolve(true);
                       }
                   }
               },
           );
       });
   }

   async getPostCallAutomationRun(runId) {
       if (!runId) return null;
       return new Promise((resolve, reject) => {
           this.db.get(
               'SELECT * FROM post_call_automation_runs WHERE run_id = ?',
               [runId],
               (err, row) => {
                   if (err) {
                       console.error('Error fetching post-call automation run:', err);
                       reject(err);
                   } else {
                       resolve(row || null);
                   }
               },
           );
       });
   }

   async listPostCallAutomationRuns(filters = {}) {
       const where = [];
       const params = [];
       if (filters.call_sid) {
           where.push('call_sid = ?');
           params.push(filters.call_sid);
       }
       if (filters.rule_id) {
           where.push('rule_id = ?');
           params.push(filters.rule_id);
       }
       if (filters.status) {
           where.push('status = ?');
           params.push(String(filters.status).toLowerCase());
       }
       if (filters.trigger_event) {
           where.push('trigger_event = ?');
           params.push(filters.trigger_event);
       }
       if (filters.retry_of_run_id) {
           where.push('retry_of_run_id = ?');
           params.push(filters.retry_of_run_id);
       }
       const safeLimit = Number.isFinite(Number(filters.limit))
           ? Math.max(1, Math.min(200, Math.floor(Number(filters.limit))))
           : 100;
       params.push(safeLimit);
       const sql = `
           SELECT * FROM post_call_automation_runs
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at DESC
           LIMIT ?
       `;
       return new Promise((resolve, reject) => {
           this.db.all(sql, params, (err, rows) => {
               if (err) {
                   console.error('Error listing post-call automation runs:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async getPostCallAutomationRunByIdempotency(idempotencyKey) {
       if (!idempotencyKey) return null;
       return new Promise((resolve, reject) => {
           this.db.get(
               'SELECT * FROM post_call_automation_runs WHERE idempotency_key = ?',
               [idempotencyKey],
               (err, row) => {
                   if (err) {
                       console.error('Error fetching post-call automation idempotency record:', err);
                       reject(err);
                   } else {
                       resolve(row || null);
                   }
               },
           );
       });
   }

   async upsertCrmContactSyncRecord(record = {}) {
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO crm_contact_sync_records (
                   provider, local_contact_id, external_contact_id, email, phone, status, payload_json, created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT(provider, local_contact_id) DO UPDATE SET
                   external_contact_id = excluded.external_contact_id,
                   email = excluded.email,
                   phone = excluded.phone,
                   status = excluded.status,
                   payload_json = excluded.payload_json,
                   updated_at = CURRENT_TIMESTAMP
           `;
           this.db.run(
               sql,
               [
                   record.provider,
                   record.local_contact_id,
                   record.external_contact_id,
                   record.email || null,
                   record.phone || null,
                   record.status || null,
                   record.payload_json || null,
               ],
               function (err) {
                   if (err) {
                       console.error('Error upserting CRM contact sync record:', err);
                       reject(err);
                   } else {
                       resolve(this.changes || 0);
                   }
               },
           );
       });
   }

   async recordCrmActivitySyncEvent(event = {}) {
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO crm_activity_sync_events (
                   provider, external_contact_id, activity_id, activity_type, status, payload_json
               )
               VALUES (?, ?, ?, ?, ?, ?)
           `;
           this.db.run(
               sql,
               [
                   event.provider,
                   event.external_contact_id || null,
                   event.activity_id || null,
                   event.activity_type || null,
                   event.status || null,
                   event.payload_json || null,
               ],
               function (err) {
                   if (err) {
                       console.error('Error recording CRM activity sync event:', err);
                       reject(err);
                   } else {
                       resolve(this.lastID);
                   }
               },
           );
       });
   }

   // Save Email message
   async saveEmailMessage(messageData) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO email_messages (
               message_id, to_email, from_email, subject, html, text,
               template_id, variables_json, variables_hash, metadata_json,
               status, provider, tenant_id, bulk_job_id, scheduled_at, max_retries
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
           this.db.run(sql, [
               messageData.message_id,
               messageData.to_email,
               messageData.from_email || null,
               messageData.subject || null,
               messageData.html || null,
               messageData.text || null,
               messageData.template_id || null,
               messageData.variables_json || null,
               messageData.variables_hash || null,
               messageData.metadata_json || null,
               messageData.status || 'queued',
               messageData.provider || null,
               messageData.tenant_id || null,
               messageData.bulk_job_id || null,
               messageData.scheduled_at || null,
               messageData.max_retries || 5
           ], function (err) {
               if (err) {
                   console.error('Error saving email message:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   async getEmailMessage(messageId) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_messages WHERE message_id = ?`;
           this.db.get(sql, [messageId], (err, row) => {
               if (err) {
                   console.error('Error fetching email message:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async getEmailMessageByProviderId(providerMessageId) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_messages WHERE provider_message_id = ?`;
           this.db.get(sql, [providerMessageId], (err, row) => {
               if (err) {
                   console.error('Error fetching email message by provider id:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async listEmailEvents(messageId) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_events WHERE message_id = ? ORDER BY timestamp ASC`;
           this.db.all(sql, [messageId], (err, rows) => {
               if (err) {
                   console.error('Error fetching email events:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async addEmailEvent(messageId, eventType, metadata = null, provider = null) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO email_events (message_id, event_type, provider, metadata)
               VALUES (?, ?, ?, ?)`;
           this.db.run(sql, [
               messageId,
               eventType,
               provider || null,
               metadata ? JSON.stringify(metadata) : null
           ], function (err) {
               if (err) {
                   console.error('Error adding email event:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   async saveEmailProviderEvent(event = {}) {
       const eventKey = String(event.event_key || event.eventKey || '').trim();
       if (!eventKey) {
           return false;
       }
       return new Promise((resolve, reject) => {
           const sql = `INSERT OR IGNORE INTO email_provider_events (
               event_key, message_id, provider, event_type, reason, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)`;
           this.db.run(
               sql,
               [
                   eventKey,
                   event.message_id || null,
                   event.provider || null,
                   event.event_type || null,
                   event.reason || null,
                   event.payload_json || null,
               ],
               function (err) {
                   if (err) {
                       console.error('Error saving email provider event:', err);
                       reject(err);
                   } else {
                       resolve((this.changes || 0) > 0);
                   }
               },
           );
       });
   }

   async cleanupExpiredEmailProviderEvents(daysToKeep = 14) {
       const safeDays = Math.max(1, Number(daysToKeep) || 14);
       return new Promise((resolve, reject) => {
           const sql = `DELETE FROM email_provider_events WHERE created_at < datetime('now', ?)`;
           this.db.run(sql, [`-${safeDays} days`], function (err) {
               if (err) {
                   console.error('Error cleaning email provider events:', err);
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async updateEmailMessageStatus(messageId, updates = {}) {
       return new Promise((resolve, reject) => {
           const fields = [];
           const params = [];
           const setField = (name, value) => {
               fields.push(`${name} = ?`);
               params.push(value);
           };
           if (updates.status) setField('status', updates.status);
           if (Object.prototype.hasOwnProperty.call(updates, 'failure_reason')) setField('failure_reason', updates.failure_reason);
           if (Object.prototype.hasOwnProperty.call(updates, 'provider_message_id')) setField('provider_message_id', updates.provider_message_id);
           if (Object.prototype.hasOwnProperty.call(updates, 'provider_response')) setField('provider_response', updates.provider_response);
           if (Object.prototype.hasOwnProperty.call(updates, 'last_attempt_at')) setField('last_attempt_at', updates.last_attempt_at);
           if (Object.prototype.hasOwnProperty.call(updates, 'next_attempt_at')) setField('next_attempt_at', updates.next_attempt_at);
           if (Object.prototype.hasOwnProperty.call(updates, 'retry_count')) setField('retry_count', updates.retry_count);
           if (Object.prototype.hasOwnProperty.call(updates, 'sent_at')) setField('sent_at', updates.sent_at);
           if (Object.prototype.hasOwnProperty.call(updates, 'delivered_at')) setField('delivered_at', updates.delivered_at);
           if (Object.prototype.hasOwnProperty.call(updates, 'failed_at')) setField('failed_at', updates.failed_at);
           if (Object.prototype.hasOwnProperty.call(updates, 'suppressed_reason')) setField('suppressed_reason', updates.suppressed_reason);
           if (Object.prototype.hasOwnProperty.call(updates, 'queue_lock_token')) setField('queue_lock_token', updates.queue_lock_token);
           if (Object.prototype.hasOwnProperty.call(updates, 'queue_lock_expires_at_ms')) setField('queue_lock_expires_at_ms', updates.queue_lock_expires_at_ms);
           fields.push('updated_at = CURRENT_TIMESTAMP');
           params.push(messageId);
           const sql = `UPDATE email_messages SET ${fields.join(', ')} WHERE message_id = ?`;
           this.db.run(sql, params, function (err) {
               if (err) {
                   console.error('Error updating email message:', err);
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
   }

   async getPendingEmailMessages(limit = 10) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_messages
               WHERE status IN ('queued', 'retry')
               AND (scheduled_at IS NULL OR scheduled_at <= CURRENT_TIMESTAMP)
               AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
               ORDER BY created_at ASC
               LIMIT ?`;
           this.db.all(sql, [limit], (err, rows) => {
               if (err) {
                   console.error('Error fetching pending email messages:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async claimPendingEmailMessages(limit = 10, options = {}) {
       await this.ensureEmailQueueColumns();
       const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
       const leaseMs = Math.max(1000, Number(options.leaseMs) || 60000);
       const staleSendingMs = Math.max(15000, Number(options.staleSendingMs) || leaseMs * 2);
       const nowMs = Date.now();
       const expiresAtMs = nowMs + leaseMs;
       const token = `emailq_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;

       const sqlClaim = `
           UPDATE email_messages
           SET queue_lock_token = ?, queue_lock_expires_at_ms = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id IN (
               SELECT id
               FROM email_messages
               WHERE (
                   (
                       status IN ('queued', 'retry')
                       AND (scheduled_at IS NULL OR scheduled_at <= CURRENT_TIMESTAMP)
                       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
                   )
                   OR (
                       status = 'sending'
                       AND last_attempt_at IS NOT NULL
                       AND (strftime('%s', 'now') - strftime('%s', last_attempt_at)) * 1000 >= ?
                   )
               )
               AND (queue_lock_expires_at_ms IS NULL OR queue_lock_expires_at_ms <= ?)
               ORDER BY created_at ASC
               LIMIT ?
           )
       `;

       await new Promise((resolve, reject) => {
           this.db.run(sqlClaim, [token, expiresAtMs, staleSendingMs, nowMs, safeLimit], (err) => {
               if (err) {
                   console.error('Error claiming pending email messages:', err);
                   reject(err);
               } else {
                   resolve();
               }
           });
       });

       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_messages WHERE queue_lock_token = ? ORDER BY created_at ASC`;
           this.db.all(sql, [token], (err, rows) => {
               if (err) {
                   console.error('Error fetching claimed email messages:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async releaseEmailMessageClaim(messageId, lockToken = null) {
       await this.ensureEmailQueueColumns();
       if (!messageId) {
           return 0;
       }
       return new Promise((resolve, reject) => {
           const hasToken = typeof lockToken === 'string' && lockToken.length > 0;
           const sql = hasToken
               ? `UPDATE email_messages
                   SET queue_lock_token = NULL, queue_lock_expires_at_ms = NULL, updated_at = CURRENT_TIMESTAMP
                   WHERE message_id = ? AND queue_lock_token = ?`
               : `UPDATE email_messages
                   SET queue_lock_token = NULL, queue_lock_expires_at_ms = NULL, updated_at = CURRENT_TIMESTAMP
                   WHERE message_id = ?`;
           const params = hasToken ? [messageId, lockToken] : [messageId];
           this.db.run(sql, params, function (err) {
               if (err) {
                   console.error('Error releasing email message claim:', err);
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async createEmailBulkJob(jobData) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO email_bulk_jobs (
               job_id, status, total, queued, sending, sent, failed, delivered, bounced, complained, suppressed, tenant_id, template_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
           this.db.run(sql, [
               jobData.job_id,
               jobData.status || 'queued',
               jobData.total || 0,
               jobData.queued || 0,
               jobData.sending || 0,
               jobData.sent || 0,
               jobData.failed || 0,
               jobData.delivered || 0,
               jobData.bounced || 0,
               jobData.complained || 0,
               jobData.suppressed || 0,
               jobData.tenant_id || null,
               jobData.template_id || null
           ], function (err) {
               if (err) {
                   console.error('Error creating email bulk job:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   async updateEmailBulkJob(jobId, updates = {}) {
       return new Promise((resolve, reject) => {
           const fields = [];
           const params = [];
           const setField = (name, value) => {
               fields.push(`${name} = ?`);
               params.push(value);
           };
           Object.entries(updates).forEach(([key, value]) => {
               setField(key, value);
           });
           fields.push('updated_at = CURRENT_TIMESTAMP');
           params.push(jobId);
           const sql = `UPDATE email_bulk_jobs SET ${fields.join(', ')} WHERE job_id = ?`;
           this.db.run(sql, params, function (err) {
               if (err) {
                   console.error('Error updating email bulk job:', err);
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
   }

  async getEmailBulkJob(jobId) {
      return new Promise((resolve, reject) => {
          const sql = `SELECT * FROM email_bulk_jobs WHERE job_id = ?`;
          this.db.get(sql, [jobId], (err, row) => {
              if (err) {
                  console.error('Error fetching email bulk job:', err);
                  reject(err);
              } else {
                  resolve(row || null);
              }
          });
      });
  }

  async getEmailBulkJobs({ limit = 10, offset = 0 } = {}) {
      return new Promise((resolve, reject) => {
          const sql = `SELECT job_id, status, total, queued, sending, sent, failed, delivered, bounced, complained, suppressed, template_id, created_at, updated_at, completed_at
                       FROM email_bulk_jobs
                       ORDER BY created_at DESC
                       LIMIT ? OFFSET ?`;
          this.db.all(sql, [limit, offset], (err, rows) => {
              if (err) {
                  console.error('Error fetching email bulk jobs:', err);
                  reject(err);
              } else {
                  resolve(rows || []);
              }
          });
      });
  }

  async getEmailBulkStats({ hours = 24 } = {}) {
      return new Promise((resolve, reject) => {
          const window = `-${Math.max(hours, 1)} hours`;
          const sql = `SELECT
                           COUNT(*) as total_jobs,
                           COALESCE(SUM(total), 0) as total_recipients,
                           COALESCE(SUM(sent), 0) as sent,
                           COALESCE(SUM(failed), 0) as failed,
                           COALESCE(SUM(delivered), 0) as delivered,
                           COALESCE(SUM(bounced), 0) as bounced,
                           COALESCE(SUM(complained), 0) as complained,
                           COALESCE(SUM(suppressed), 0) as suppressed
                       FROM email_bulk_jobs
                       WHERE created_at >= datetime('now', ?)`;
          this.db.get(sql, [window], (err, row) => {
              if (err) {
                  console.error('Error fetching email bulk stats:', err);
                  reject(err);
              } else {
                  resolve(row || null);
              }
          });
      });
  }

   normalizeEmailTemplateRow(row = {}) {
       if (!row || typeof row !== 'object') return null;
       const lifecycle = String(row.lifecycle_state || 'draft').trim().toLowerCase();
       const lifecycleState = ['draft', 'review', 'approved', 'live'].includes(lifecycle)
           ? lifecycle
           : 'draft';
       const parsedVersion = Number(row.version);
       const version = Number.isFinite(parsedVersion) && parsedVersion > 0
           ? Math.max(1, Math.floor(parsedVersion))
           : 1;
       return {
           ...row,
           version,
           lifecycle_state: lifecycleState,
           submitted_for_review_at: row.submitted_for_review_at || null,
           reviewed_at: row.reviewed_at || null,
           reviewed_by: row.reviewed_by || null,
           review_note: row.review_note || null,
           live_at: row.live_at || null,
           live_by: row.live_by || null,
           is_live: lifecycleState === 'live',
       };
   }

   async getEmailTemplate(templateId) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_templates WHERE template_id = ?`;
           this.db.get(sql, [templateId], (err, row) => {
               if (err) {
                   console.error('Error fetching email template:', err);
                   reject(err);
               } else {
                   resolve(row ? this.normalizeEmailTemplateRow(row) : null);
               }
           });
       });
   }

   async listEmailTemplates(limit = 50) {
       const safeLimit = Number.isFinite(Number(limit))
           ? Math.max(1, Math.min(200, Math.floor(Number(limit))))
           : 50;
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT template_id, subject, html, text, required_vars, version,
                      lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                      created_at, updated_at
               FROM email_templates
               ORDER BY updated_at DESC
               LIMIT ?
           `;
           this.db.all(sql, [safeLimit], (err, rows) => {
               if (err) {
                   console.error('Error listing email templates:', err);
                   reject(err);
               } else {
                   resolve((rows || []).map((row) => this.normalizeEmailTemplateRow(row)).filter(Boolean));
               }
           });
       });
   }

   async createEmailTemplate(payload) {
       const {
           template_id,
           subject = '',
           html = '',
           text = '',
           required_vars = null,
           version = 1,
           lifecycle_state = 'draft',
           submitted_for_review_at = null,
           reviewed_at = null,
           reviewed_by = null,
           review_note = null,
           live_at = null,
           live_by = null,
       } = payload || {};
       const parsedVersion = Number(version);
       const normalizedVersion = Number.isFinite(parsedVersion) && parsedVersion > 0
           ? Math.max(1, Math.floor(parsedVersion))
           : 1;
       const lifecycle = String(lifecycle_state || 'draft').trim().toLowerCase();
       const lifecycleState = ['draft', 'review', 'approved', 'live'].includes(lifecycle)
           ? lifecycle
           : 'draft';
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO email_templates (
                   template_id, subject, html, text, required_vars, version,
                   lifecycle_state, submitted_for_review_at, reviewed_at, reviewed_by, review_note, live_at, live_by,
                   created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           `;
           this.db.run(
               sql,
               [
                   template_id,
                   subject,
                   html,
                   text,
                   required_vars,
                   normalizedVersion,
                   lifecycleState,
                   submitted_for_review_at,
                   reviewed_at,
                   reviewed_by,
                   review_note,
                   live_at,
                   live_by,
               ],
               function (err) {
                   if (err) {
                       console.error('Error creating email template:', err);
                       reject(err);
                   } else {
                       resolve(this.changes);
                   }
               }
           );
       });
   }

   async updateEmailTemplate(templateId, payload) {
       const fields = [];
       const values = [];
       const mapping = {
           subject: 'subject',
           html: 'html',
           text: 'text',
           required_vars: 'required_vars'
       };
       Object.entries(mapping).forEach(([key, column]) => {
           if (payload[key] !== undefined) {
               fields.push(`${column} = ?`);
               values.push(payload[key]);
           }
       });
       if (!fields.length) {
           return 0;
       }
       fields.push('version = COALESCE(version, 1) + 1');
       fields.push('updated_at = CURRENT_TIMESTAMP');
       values.push(templateId);
       return new Promise((resolve, reject) => {
           const sql = `UPDATE email_templates SET ${fields.join(', ')} WHERE template_id = ?`;
           this.db.run(sql, values, function (err) {
               if (err) {
                   console.error('Error updating email template:', err);
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
   }

   async deleteEmailTemplate(templateId) {
       return new Promise((resolve, reject) => {
           this.db.run('DELETE FROM email_templates WHERE template_id = ?', [templateId], function (err) {
               if (err) {
                   console.error('Error deleting email template:', err);
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
   }

   async listEmailTemplateVersions(templateId, limit = 20) {
       const safeLimit = Number.isFinite(Number(limit))
           ? Math.max(1, Math.min(100, Math.floor(Number(limit))))
           : 20;
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT id, template_id, version, snapshot, reason, created_by, created_at
               FROM email_template_versions
               WHERE template_id = ?
               ORDER BY version DESC
               LIMIT ?
           `;
           this.db.all(sql, [templateId, safeLimit], (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async getEmailTemplateVersion(templateId, version) {
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT id, template_id, version, snapshot, reason, created_by, created_at
               FROM email_template_versions
               WHERE template_id = ? AND version = ?
               LIMIT 1
           `;
           this.db.get(sql, [templateId, version], (err, row) => {
               if (err) {
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async saveEmailTemplateVersion(templateId, version, snapshot, options = {}) {
       const safeVersion = Number.isFinite(Number(version))
           ? Math.max(1, Math.floor(Number(version)))
           : 1;
       const reason = options.reason ? String(options.reason).slice(0, 120) : null;
       const createdBy = options.created_by ? String(options.created_by).slice(0, 120) : null;
       const serializedSnapshot = typeof snapshot === 'string'
           ? snapshot
           : JSON.stringify(snapshot || {});
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO email_template_versions (
                   template_id, version, snapshot, reason, created_by, created_at
               )
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(template_id, version) DO UPDATE SET
                   snapshot = excluded.snapshot,
                   reason = excluded.reason,
                   created_by = excluded.created_by,
                   created_at = CURRENT_TIMESTAMP
           `;
           this.db.run(sql, [templateId, safeVersion, serializedSnapshot, reason, createdBy], function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async setEmailTemplateLifecycle(templateId, updates = {}) {
       const fields = [];
       const values = [];
       const mapping = {
           lifecycle_state: 'lifecycle_state',
           submitted_for_review_at: 'submitted_for_review_at',
           reviewed_at: 'reviewed_at',
           reviewed_by: 'reviewed_by',
           review_note: 'review_note',
           live_at: 'live_at',
           live_by: 'live_by',
       };
       Object.entries(mapping).forEach(([key, column]) => {
           if (!Object.prototype.hasOwnProperty.call(updates, key)) return;
           let value = updates[key];
           if (key === 'lifecycle_state') {
               const normalized = String(value || '').trim().toLowerCase();
               value = ['draft', 'review', 'approved', 'live'].includes(normalized)
                   ? normalized
                   : 'draft';
           } else if (key === 'review_note') {
               value = value === null || value === undefined ? null : String(value).slice(0, 500);
           } else {
               value = value === null || value === undefined ? null : String(value);
           }
           fields.push(`${column} = ?`);
           values.push(value);
       });
       if (!fields.length) {
           return 0;
       }
       fields.push('updated_at = CURRENT_TIMESTAMP');
       values.push(templateId);
       return new Promise((resolve, reject) => {
           const sql = `UPDATE email_templates SET ${fields.join(', ')} WHERE template_id = ?`;
           this.db.run(sql, values, function (err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async promoteEmailTemplateLive(templateId, actor = null) {
       const safeActor = actor === null || actor === undefined ? null : String(actor).slice(0, 120);
       return new Promise((resolve, reject) => {
           const dbConn = this.db;
           dbConn.serialize(() => {
               dbConn.run('BEGIN TRANSACTION');
               dbConn.run(
                   `UPDATE email_templates
                    SET lifecycle_state = 'approved',
                        live_at = NULL,
                        live_by = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE lifecycle_state = 'live' AND template_id != ?`,
                   [templateId],
                   (demoteErr) => {
                       if (demoteErr) {
                           dbConn.run('ROLLBACK');
                           reject(demoteErr);
                           return;
                       }
                       dbConn.run(
                           `UPDATE email_templates
                            SET lifecycle_state = 'live',
                                live_at = CURRENT_TIMESTAMP,
                                live_by = ?,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE template_id = ?`,
                           [safeActor, templateId],
                           function (promoteErr) {
                               if (promoteErr) {
                                   dbConn.run('ROLLBACK');
                                   reject(promoteErr);
                                   return;
                               }
                               if (this.changes === 0) {
                                   dbConn.run('ROLLBACK');
                                   resolve(0);
                                   return;
                               }
                               const promotedChanges = this.changes;
                               dbConn.run('COMMIT', (commitErr) => {
                                   if (commitErr) {
                                       dbConn.run('ROLLBACK');
                                       reject(commitErr);
                                   } else {
                                       resolve(promotedChanges);
                                   }
                               });
                           },
                       );
                   },
               );
           });
       });
   }

   async reserveEmailIdempotency(idempotencyKey, requestHash, bulkJobId = null) {
       const key = String(idempotencyKey || '').trim();
       if (!key) {
           throw new Error('Idempotency key is required');
       }
       const hash = requestHash || null;
       const dbInstance = this;
       return new Promise((resolve, reject) => {
           const sql = `INSERT OR IGNORE INTO email_idempotency (
               idempotency_key, message_id, bulk_job_id, request_hash
           ) VALUES (?, NULL, ?, ?)`;
           this.db.run(sql, [key, bulkJobId || null, hash], function (insertErr) {
               if (insertErr) {
                   console.error('Error reserving email idempotency key:', insertErr);
                   reject(insertErr);
                   return;
               }
               const inserted = (this.changes || 0) > 0;
               dbInstance.getEmailIdempotency(key)
                   .then((record) => {
                       resolve({ inserted, record });
                   })
                   .catch(reject);
           });
       });
   }

   async finalizeEmailIdempotency(idempotencyKey, messageId = null, bulkJobId = null, requestHash = null) {
       const key = String(idempotencyKey || '').trim();
       if (!key) {
           throw new Error('Idempotency key is required');
       }
       return new Promise((resolve, reject) => {
           const sql = `
               INSERT INTO email_idempotency (idempotency_key, message_id, bulk_job_id, request_hash)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(idempotency_key) DO UPDATE SET
                   message_id = COALESCE(email_idempotency.message_id, excluded.message_id),
                   bulk_job_id = COALESCE(email_idempotency.bulk_job_id, excluded.bulk_job_id),
                   request_hash = COALESCE(email_idempotency.request_hash, excluded.request_hash)
           `;
           this.db.run(
               sql,
               [key, messageId || null, bulkJobId || null, requestHash || null],
               function (err) {
                   if (err) {
                       console.error('Error finalizing email idempotency key:', err);
                       reject(err);
                   } else {
                       resolve((this.changes || 0) > 0);
                   }
               },
           );
       });
   }

   async clearPendingEmailIdempotency(idempotencyKey) {
       const key = String(idempotencyKey || '').trim();
       if (!key) {
           return 0;
       }
       return new Promise((resolve, reject) => {
           const sql = `
               DELETE FROM email_idempotency
               WHERE idempotency_key = ?
                 AND message_id IS NULL
           `;
           this.db.run(sql, [key], function (err) {
               if (err) {
                   console.error('Error clearing pending email idempotency:', err);
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async saveEmailIdempotency(idempotencyKey, messageId, bulkJobId, requestHash) {
       return this.finalizeEmailIdempotency(
           idempotencyKey,
           messageId || null,
           bulkJobId || null,
           requestHash || null,
       );
   }

   async getEmailIdempotency(idempotencyKey) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT * FROM email_idempotency WHERE idempotency_key = ?`;
           this.db.get(sql, [idempotencyKey], (err, row) => {
               if (err) {
                   console.error('Error fetching email idempotency:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async isEmailSuppressed(email) {
       return new Promise((resolve, reject) => {
           const sql = `SELECT reason FROM email_suppression WHERE email = ?`;
           this.db.get(sql, [email], (err, row) => {
               if (err) {
                   console.error('Error checking email suppression:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async setEmailSuppression(email, reason = null, source = null) {
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO email_suppression (email, reason, source, created_at, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT(email) DO UPDATE SET
               reason = excluded.reason,
               source = excluded.source,
               updated_at = CURRENT_TIMESTAMP`;
           this.db.run(sql, [email, reason, source], function (err) {
               if (err) {
                   console.error('Error setting email suppression:', err);
                   reject(err);
               } else {
                   resolve(true);
               }
           });
       });
   }

   async clearEmailSuppression(email) {
       return new Promise((resolve, reject) => {
           const sql = `DELETE FROM email_suppression WHERE email = ?`;
           this.db.run(sql, [email], function (err) {
               if (err) {
                   console.error('Error clearing email suppression:', err);
                   reject(err);
               } else {
                   resolve(true);
               }
           });
       });
   }

   async insertEmailDlq(messageId, reason, payload = null) {
       await this.ensureEmailDlqColumns();
       return new Promise((resolve, reject) => {
           const sql = `INSERT INTO email_dlq (message_id, reason, payload, status, updated_at)
               VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP)`;
           this.db.run(sql, [messageId, reason || null, payload ? JSON.stringify(payload) : null], function (err) {
               if (err) {
                   console.error('Error inserting email DLQ:', err);
                   reject(err);
               } else {
                   resolve(this.lastID);
               }
           });
       });
   }

   async listEmailDlq({ status = null, limit = 20, offset = 0 } = {}) {
       await this.ensureEmailDlqColumns();
       const clauses = [];
       const params = [];
       if (status && String(status).toLowerCase() !== 'all') {
           clauses.push('d.status = ?');
           params.push(String(status).toLowerCase());
       }
       const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
       const sql = `
           SELECT
               d.*,
               m.to_email,
               m.subject,
               m.provider,
               m.status AS message_status
           FROM email_dlq d
           LEFT JOIN email_messages m ON m.message_id = d.message_id
           ${where}
           ORDER BY d.created_at DESC
           LIMIT ? OFFSET ?
       `;
       params.push(Math.min(100, Math.max(1, Number(limit) || 20)));
       params.push(Math.max(0, Number(offset) || 0));
       return new Promise((resolve, reject) => {
           this.db.all(sql, params, (err, rows) => {
               if (err) {
                   console.error('Error listing email DLQ:', err);
                   reject(err);
               } else {
                   resolve(rows || []);
               }
           });
       });
   }

   async getEmailDlqEntry(dlqId) {
       await this.ensureEmailDlqColumns();
       return new Promise((resolve, reject) => {
           const sql = `
               SELECT
                   d.*,
                   m.to_email,
                   m.subject,
                   m.provider,
                   m.status AS message_status
               FROM email_dlq d
               LEFT JOIN email_messages m ON m.message_id = d.message_id
               WHERE d.id = ?
           `;
           this.db.get(sql, [dlqId], (err, row) => {
               if (err) {
                   console.error('Error fetching email DLQ entry:', err);
                   reject(err);
               } else {
                   resolve(row || null);
               }
           });
       });
   }

   async countOpenEmailDlq() {
       await this.ensureEmailDlqColumns();
       return new Promise((resolve, reject) => {
           const sql = `SELECT COUNT(*) AS total FROM email_dlq WHERE status = 'open'`;
           this.db.get(sql, [], (err, row) => {
               if (err) {
                   console.error('Error counting open email DLQ rows:', err);
                   reject(err);
               } else {
                   resolve(Number(row?.total) || 0);
               }
           });
       });
   }

   async markEmailDlqReplayed(dlqId, replayError = null) {
       await this.ensureEmailDlqColumns();
       const now = new Date().toISOString();
       const status = replayError ? 'open' : 'replayed';
       return new Promise((resolve, reject) => {
           const sql = `
               UPDATE email_dlq
               SET replay_count = replay_count + 1,
                   status = ?,
                   replayed_at = ?,
                   last_replay_error = ?,
                   updated_at = ?
               WHERE id = ?
           `;
           this.db.run(sql, [status, now, replayError || null, now, dlqId], function(err) {
               if (err) {
                   console.error('Error marking email DLQ replay:', err);
                   reject(err);
               } else {
                   resolve(this.changes || 0);
               }
           });
       });
   }

   async incrementEmailMetric(metricType) {
       return new Promise((resolve, reject) => {
           const date = new Date().toISOString().slice(0, 10);
           const sqlSelect = 'SELECT total_count FROM email_metrics WHERE date = ? AND metric_type = ?';
           this.db.get(sqlSelect, [date, metricType], (err, row) => {
               if (err) {
                   console.error('Email metrics select error:', err);
                   reject(err);
                   return;
               }
               if (row) {
                   const sqlUpdate = `UPDATE email_metrics 
                       SET total_count = total_count + 1, updated_at = CURRENT_TIMESTAMP
                       WHERE date = ? AND metric_type = ?`;
                   this.db.run(sqlUpdate, [date, metricType], function (updateErr) {
                       if (updateErr) {
                           console.error('Email metrics update error:', updateErr);
                           reject(updateErr);
                       } else {
                           resolve(true);
                       }
                   });
               } else {
                   const sqlInsert = `INSERT INTO email_metrics (date, metric_type, total_count)
                       VALUES (?, ?, 1)`;
                   this.db.run(sqlInsert, [date, metricType], function (insertErr) {
                       if (insertErr) {
                           console.error('Email metrics insert error:', insertErr);
                           reject(insertErr);
                       } else {
                           resolve(true);
                       }
                   });
               }
           });
       });
   }

   async getEmailMetricCount(metricType) {
       return new Promise((resolve, reject) => {
           const date = new Date().toISOString().slice(0, 10);
           const sql = `SELECT total_count FROM email_metrics WHERE date = ? AND metric_type = ?`;
           this.db.get(sql, [date, metricType], (err, row) => {
               if (err) {
                   console.error('Email metrics fetch error:', err);
                   reject(err);
               } else {
                   resolve(row ? row.total_count : 0);
               }
           });
       });
   }

   // Comprehensive cleanup with enhanced metrics
   async cleanupOldRecords(daysToKeep = 30) {
       const tables = [
           { name: 'call_states', dateField: 'timestamp' },
           { name: 'service_health_logs', dateField: 'timestamp' },
           { name: 'call_metrics', dateField: 'timestamp' },
           { name: 'notification_metrics', dateField: 'created_at' },
           { name: 'email_provider_events', dateField: 'created_at' },
           { name: 'email_idempotency', dateField: 'created_at' },
           { name: 'gpt_tool_audit', dateField: 'created_at' },
           { name: 'gpt_tool_idempotency', dateField: 'updated_at' },
           { name: 'gpt_memory_facts', dateField: 'last_seen_at' },
           { name: 'provider_event_idempotency', dateField: 'created_at' },
           { name: 'outbound_call_idempotency', dateField: 'updated_at' },
           { name: 'call_script_mutation_idempotency', dateField: 'updated_at' },
           { name: 'vonage_call_mappings', dateField: 'updated_at' },
           { name: 'call_runtime_state', dateField: 'updated_at' }
       ];
       
       let totalCleaned = 0;
       const cleanupResults = {};
       
       for (const table of tables) {
           const cleaned = await new Promise((resolve, reject) => {
               const sql = `DELETE FROM ${table.name} 
                   WHERE ${table.dateField} < datetime('now', '-${daysToKeep} days')`;
               
               this.db.run(sql, function(err) {
                   if (err) {
                       reject(err);
                   } else {
                       resolve(this.changes);
                   }
               });
           });
           
           cleanupResults[table.name] = cleaned;
           totalCleaned += cleaned;
           
           if (cleaned > 0) {
               console.log(`🧹 Cleaned ${cleaned} old records from ${table.name}`);
           }
       }

       const jobsCleaned = await new Promise((resolve, reject) => {
           const sql = `
               DELETE FROM call_jobs
               WHERE status IN ('completed', 'failed')
                 AND updated_at < datetime('now', '-${daysToKeep} days')
           `;
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       cleanupResults.call_jobs = jobsCleaned;
       totalCleaned += jobsCleaned;

       const callDlqCleaned = await new Promise((resolve, reject) => {
           const sql = `
               DELETE FROM call_job_dlq
               WHERE status = 'replayed'
                 AND updated_at < datetime('now', '-${daysToKeep} days')
           `;
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       cleanupResults.call_job_dlq = callDlqCleaned;
       totalCleaned += callDlqCleaned;

       const emailDlqCleaned = await new Promise((resolve, reject) => {
           const sql = `
               DELETE FROM email_dlq
               WHERE status = 'replayed'
                 AND updated_at < datetime('now', '-${daysToKeep} days')
           `;
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       cleanupResults.email_dlq = emailDlqCleaned;
       totalCleaned += emailDlqCleaned;
       
       // Clean up old successful webhook notifications (keep for 7 days)
       const webhooksCleaned = await new Promise((resolve, reject) => {
           const sql = `DELETE FROM webhook_notifications 
               WHERE status = 'sent' 
               AND created_at < datetime('now', '-7 days')`;
           
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       
       cleanupResults.webhook_notifications = webhooksCleaned;
       totalCleaned += webhooksCleaned;
       
       if (webhooksCleaned > 0) {
           console.log(`🧹 Cleaned ${webhooksCleaned} old successful webhook notifications`);
       }
       
       // Clean up old user sessions (keep for 90 days)
       const sessionsCleaned = await new Promise((resolve, reject) => {
           const sql = `DELETE FROM user_sessions 
               WHERE last_activity < datetime('now', '-90 days')`;
           
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       
       cleanupResults.user_sessions = sessionsCleaned;
       totalCleaned += sessionsCleaned;
       
       if (sessionsCleaned > 0) {
           console.log(`🧹 Cleaned ${sessionsCleaned} old user sessions`);
       }

       const memoryCleaned = await new Promise((resolve, reject) => {
           const sql = `DELETE FROM gpt_call_memory
               WHERE summary_updated_at < datetime('now', '-${daysToKeep} days')`;
           this.db.run(sql, function(err) {
               if (err) {
                   reject(err);
               } else {
                   resolve(this.changes);
               }
           });
       });
       cleanupResults.gpt_call_memory = memoryCleaned;
       totalCleaned += memoryCleaned;
       
       // Log cleanup operation
       await this.logServiceHealth('database', 'cleanup_completed', {
           total_cleaned: totalCleaned,
           days_kept: daysToKeep,
           breakdown: cleanupResults
       });
       
       console.log(`✅ Enhanced cleanup completed: ${totalCleaned} total records cleaned`);
       
       return {
           total_cleaned: totalCleaned,
           breakdown: cleanupResults,
           days_kept: daysToKeep
       };
   }

   // Database maintenance and optimization
   async optimizeDatabase() {
       return new Promise((resolve, reject) => {
           console.log('🔧 Running database optimization...');
           
           // Run VACUUM to reclaim space and defragment
           this.db.run('VACUUM', (err) => {
               if (err) {
                   console.error('❌ Database VACUUM failed:', err);
                   reject(err);
               } else {
                   // Run ANALYZE to update query planner statistics
                   this.db.run('ANALYZE', (analyzeErr) => {
                       if (analyzeErr) {
                           console.error('❌ Database ANALYZE failed:', analyzeErr);
                           reject(analyzeErr);
                       } else {
                           console.log('✅ Database optimization completed');
                           resolve(true);
                       }
                   });
               }
           });
       });
   }

   // Get database size and performance metrics
   async getDatabaseMetrics() {
       return new Promise((resolve, reject) => {
           const fs = require('fs');
           
           // Get file size
           let fileSize = 0;
           try {
               const stats = fs.statSync(this.dbPath);
               fileSize = stats.size;
           } catch (e) {
               console.warn('Could not get database file size:', e.message);
           }
           
           // Get table counts
           const sql = `
               SELECT 
                   'calls' as table_name,
                   COUNT(*) as row_count
               FROM calls
               UNION ALL
               SELECT 'call_transcripts', COUNT(*) FROM call_transcripts
               UNION ALL
               SELECT 'transcripts', COUNT(*) FROM transcripts
               UNION ALL
               SELECT 'call_states', COUNT(*) FROM call_states
               UNION ALL
               SELECT 'webhook_notifications', COUNT(*) FROM webhook_notifications
               UNION ALL
               SELECT 'notification_metrics', COUNT(*) FROM notification_metrics
               UNION ALL
               SELECT 'service_health_logs', COUNT(*) FROM service_health_logs
               UNION ALL
               SELECT 'call_metrics', COUNT(*) FROM call_metrics
               UNION ALL
               SELECT 'user_sessions', COUNT(*) FROM user_sessions
               UNION ALL
               SELECT 'sms_messages', COUNT(*) FROM sms_messages
               UNION ALL
               SELECT 'bulk_sms_operations', COUNT(*) FROM bulk_sms_operations
           `;
           
           this.db.all(sql, [], (err, rows) => {
               if (err) {
                   reject(err);
               } else {
                   const metrics = {
                       file_size_bytes: fileSize,
                       file_size_mb: (fileSize / (1024 * 1024)).toFixed(2),
                       table_counts: {},
                       total_rows: 0
                   };
                   
                   rows.forEach(row => {
                       metrics.table_counts[row.table_name] = row.row_count;
                       metrics.total_rows += row.row_count;
                   });
                   
                   resolve(metrics);
               }
           });
       });
   }

   // Enhanced close method with cleanup
   async close() {
       if (this.db) {
           return new Promise((resolve) => {
               // Log database shutdown
               this.logServiceHealth('database', 'shutdown_initiated', {
                   timestamp: new Date().toISOString()
               }).then(() => {
                   this.db.close((err) => {
                       if (err) {
                           console.error('Error closing enhanced database:', err);
                       } else {
                           console.log('✅ Enhanced database connection closed');
                       }
                       resolve();
                   });
               }).catch(() => {
                   // If logging fails, still close the database
                   this.db.close((err) => {
                       if (err) {
                           console.error('Error closing enhanced database:', err);
                       } else {
                           console.log('✅ Enhanced database connection closed');
                       }
                       resolve();
                   });
               });
           });
       }
   }

   // Health check method
   async healthCheck() {
       return new Promise((resolve, reject) => {
           if (!this.isInitialized) {
               reject(new Error('Database not initialized'));
               return;
           }
           
           // Simple query to test database connectivity
           this.db.get('SELECT 1 as test', [], (err) => {
               if (err) {
                   reject(err);
               } else {
                   resolve({
                       status: 'healthy',
                       initialized: this.isInitialized,
                       timestamp: new Date().toISOString()
                   });
               }
           });
       });
   }
}

module.exports = EnhancedDatabase;
