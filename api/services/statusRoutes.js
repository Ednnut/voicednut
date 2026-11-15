const { EXECUTION_STATUSES, safeExecutionReference } = require("./executionContext");

const EXECUTION_STEP_STATUSES = new Set(["started", "completed", "failed", "skipped", "requires_attention"]);
const EXECUTION_RESULTS = new Set(["accepted", "rejected", "pending", "not_applicable", "unknown"]);
const EXECUTION_FAILURE_CLASSES = new Set(["retryable", "non_retryable", "ambiguous"]);

function safeIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function normalizeExecutionProgress(states = [], createdState = null) {
  const recentStates = Array.isArray(states) ? states : [];
  const contextState = recentStates.find((entry) =>
    entry?.data?.execution_context && typeof entry.data.execution_context === "object" && !Array.isArray(entry.data.execution_context));
  const rawContext = contextState?.data?.execution_context || createdState?.execution_context;
  if (!rawContext) return null;
  const context = {
    internal_execution_id: safeExecutionReference(rawContext.internal_execution_id),
    request_id: safeExecutionReference(rawContext.request_id),
    internal_call_id: safeExecutionReference(rawContext.internal_call_id),
    organization_id: safeExecutionReference(rawContext.organization_id),
    business_id: safeExecutionReference(rawContext.business_id),
    actor_id: safeExecutionReference(rawContext.actor_id),
    agent_id: safeExecutionReference(rawContext.agent_id),
    agent_version: Number.isSafeInteger(rawContext.agent_version) && rawContext.agent_version > 0
      ? rawContext.agent_version
      : null,
    provider: safeExecutionReference(rawContext.provider)?.toLowerCase() || null,
    provider_call_id: safeExecutionReference(rawContext.provider_call_id),
    workflow_id: safeExecutionReference(rawContext.workflow_id),
    campaign_id: safeExecutionReference(rawContext.campaign_id),
    execution_type: safeExecutionReference(rawContext.execution_type),
    status: EXECUTION_STATUSES.includes(rawContext.status) ? rawContext.status : null,
    current_stage: safeExecutionReference(rawContext.current_stage),
    created_at: safeIsoTimestamp(rawContext.created_at),
    updated_at: safeIsoTimestamp(rawContext.updated_at),
    error_classification: EXECUTION_FAILURE_CLASSES.has(rawContext.error_classification) ? rawContext.error_classification : null,
    idempotency_reference: /^sha256:[a-f0-9]{64}$/.test(String(rawContext.idempotency_reference || ""))
      ? rawContext.idempotency_reference
      : null,
  };
  const steps = recentStates
    .filter((entry) => entry?.state === "execution_step" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data))
    .slice(0, 20)
    .map(({ data }) => ({
      execution_id: safeExecutionReference(data.execution_id),
      correlation_id: safeExecutionReference(data.correlation_id),
      call_id: safeExecutionReference(data.call_id),
      step_name: safeExecutionReference(data.step_name),
      status: EXECUTION_STEP_STATUSES.has(data.status) ? data.status : null,
      started_at: safeIsoTimestamp(data.started_at),
      completed_at: safeIsoTimestamp(data.completed_at),
      result: EXECUTION_RESULTS.has(data.result) ? data.result : null,
      error_classification: EXECUTION_FAILURE_CLASSES.has(data.error_classification) ? data.error_classification : null,
      retry_count: Number.isSafeInteger(data.retry_count) && data.retry_count >= 0 ? Math.min(data.retry_count, 1000) : 0,
      related_entity: safeExecutionReference(data.related_entity),
    }))
    .reverse();
  return { context, steps };
}

function createGetCallStatusHandler(ctx = {}) {
  const {
    isSafeId,
    normalizeCallRecordForApi,
    buildDigitSummary,
    webhookService,
  } = ctx;

  return async function handleGetCallStatus(req, res) {
    try {
      const db =
        typeof ctx.getDb === "function"
          ? ctx.getDb()
          : ctx.db;
      const { callSid } = req.params;
      if (!isSafeId(callSid, { max: 128 })) {
        return res.status(400).json({ error: "Invalid call identifier" });
      }
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }
      const requesterChatId = String(
        req.headers?.["x-telegram-chat-id"] ||
          req.query?.telegram_chat_id ||
          req.query?.chat_id ||
          "",
      ).trim();
      if (
        requesterChatId &&
        String(call.user_chat_id || "") !== requesterChatId
      ) {
        return res.status(403).json({ error: "Not authorized for this call" });
      }
      const createdState = await db
        .getLatestCallState(callSid, "call_created")
        .catch(() => null);
      const normalizedCall = normalizeCallRecordForApi({
        ...call,
        call_created_state: createdState || null,
      });
      if (!normalizedCall.digit_summary) {
        const digitEvents = await db.getCallDigits(callSid).catch(() => []);
        const digitSummary = buildDigitSummary(digitEvents);
        normalizedCall.digit_summary = digitSummary.summary;
        normalizedCall.digit_count = digitSummary.count;
      }

      const recentStates = await db.getCallStates(callSid, { limit: 15 });
      const executionStates = typeof db.getCallExecutionStates === "function"
        ? await db.getCallExecutionStates(callSid, { limit: 40 }).catch(() => recentStates)
        : recentStates;

      const notificationStatus = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT notification_type, status, created_at, sent_at, delivery_time_ms, error_message 
           FROM webhook_notifications 
           WHERE call_sid = ? 
           ORDER BY created_at DESC`,
          [callSid],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        );
      });

      let timingMetrics = {};
      if (normalizedCall.created_at) {
        const now = new Date();
        const created = new Date(normalizedCall.created_at);
        timingMetrics.total_elapsed = Math.round((now - created) / 1000);

        if (normalizedCall.started_at) {
          const started = new Date(normalizedCall.started_at);
          timingMetrics.time_to_answer = Math.round((started - created) / 1000);
        }

        if (normalizedCall.ended_at) {
          const ended = new Date(normalizedCall.ended_at);
          timingMetrics.call_duration =
            normalizedCall.duration ||
            Math.round(
              (ended -
                new Date(
                  normalizedCall.started_at || normalizedCall.created_at,
                )) /
                1000,
            );
        }

        if (normalizedCall.ring_duration) {
          timingMetrics.ring_duration = normalizedCall.ring_duration;
        }
      }

      return res.json({
        call: {
          ...normalizedCall,
          timing_metrics: timingMetrics,
        },
        recent_states: recentStates,
        execution_progress: normalizeExecutionProgress(executionStates, createdState),
        live_console:
          webhookService &&
          typeof webhookService.getLiveConsoleSnapshot === "function"
            ? webhookService.getLiveConsoleSnapshot(callSid)
            : null,
        notification_status: notificationStatus,
        webhook_service_status: webhookService.getCallStatusStats(),
        enhanced_tracking: true,
      });
    } catch (error) {
      console.error("Error fetching enhanced call status:", error);
      return res.status(500).json({ error: "Failed to fetch call status" });
    }
  };
}

function createSystemStatusHandler(ctx = {}) {
  const {
    getProviderReadiness,
    appVersion,
    getCurrentProvider,
    getCurrentSmsProvider,
    getCurrentEmailProvider,
    callConfigurations,
    getProviderCompatibilityReport,
    getCallCanaryState,
  } = ctx;

  return async function handleSystemStatus(req, res) {
    try {
      const readiness = getProviderReadiness();
      return res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: appVersion,
        active_provider: {
          call: getCurrentProvider(),
          sms: getCurrentSmsProvider(),
          email: getCurrentEmailProvider(),
        },
        providers: readiness,
        provider_compatibility:
          typeof getProviderCompatibilityReport === "function"
            ? getProviderCompatibilityReport()
            : null,
        active_calls: callConfigurations.size,
        call_canary:
          typeof getCallCanaryState === "function"
            ? getCallCanaryState()
            : null,
      });
    } catch (error) {
      return res.status(500).json({
        status: "error",
        timestamp: new Date().toISOString(),
        error: "Failed to compute status",
      });
    }
  };
}

function createProviderCompatibilityHandler(ctx = {}) {
  const { getProviderCompatibilityReport } = ctx;
  return async function handleProviderCompatibility(_req, res) {
    try {
      if (typeof getProviderCompatibilityReport !== "function") {
        return res.status(503).json({
          success: false,
          error: "Provider compatibility report is unavailable",
        });
      }
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        compatibility: getProviderCompatibilityReport(),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Failed to compute provider compatibility report",
      });
    }
  };
}

function createProviderRecommendationHandler(ctx = {}) {
  const { getProviderRecommendation } = ctx;
  return function handleProviderRecommendation(req, res) {
    if (typeof getProviderRecommendation !== "function") {
      return res.status(503).json({
        success: false,
        error: { code: "provider_recommendation_unavailable", message: "Provider recommendations are unavailable" },
        request_id: req.requestId || null,
      });
    }
    const operation = String(req.query?.operation || "outbound_call.create").trim().toLowerCase();
    const preferredProvider = String(req.query?.preferred_provider || "").trim().toLowerCase() || null;
    const rawCapabilities = req.query?.required_capabilities ?? req.query?.capability ?? [];
    const requiredCapabilities = (Array.isArray(rawCapabilities) ? rawCapabilities : [rawCapabilities])
      .flatMap((value) => String(value || "").split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (operation.length > 80 || (preferredProvider && preferredProvider.length > 80) || requiredCapabilities.length > 8) {
      return res.status(400).json({
        success: false,
        error: { code: "provider_recommendation_input_invalid", message: "Provider recommendation input is invalid" },
        request_id: req.requestId || null,
      });
    }
    try {
      const recommendation = getProviderRecommendation({ operation, preferredProvider, requiredCapabilities });
      return res.json({ success: true, request_id: req.requestId || null, ...recommendation });
    } catch (error) {
      const code = ["provider_operation_unknown", "provider_operation_not_recommendable", "provider_capability_limit_exceeded", "provider_capability_unknown"]
        .includes(error?.code) ? error.code : "provider_recommendation_failed";
      const status = code === "provider_recommendation_failed" ? 500 : 400;
      return res.status(status).json({
        success: false,
        error: { code, message: status === 400 ? error.message : "Provider recommendation failed" },
        request_id: req.requestId || null,
      });
    }
  };
}

function isSqliteCorruptionError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  return (
    message.includes("database disk image is malformed") ||
    message.includes("file is not a database")
  );
}

function buildDegradedHealthPayload(error, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const dbCorrupt = isSqliteCorruptionError(error);
  const message = String(error?.message || "health_check_failed");
  return {
    status: dbCorrupt ? "degraded" : "unhealthy",
    timestamp,
    enhanced_features: true,
    error: message,
    code: dbCorrupt ? "database_corrupt" : "health_check_failed",
    services: {
      database: {
        connected: false,
        error: message,
      },
      webhook_service: {
        status: "error",
        reason: dbCorrupt
          ? "Database corruption detected"
          : "Database connection failed",
      },
    },
  };
}

function createHealthHandler(ctx = {}) {
  const {
    config,
    verifyHmacSignature,
    hasAdminToken,
    webhookService,
    refreshInboundDefaultScript,
    getInboundHealthContext,
    supportedProviders,
    providerHealth,
    getProviderReadiness,
    isProviderDegraded,
    getProviderHealthScore,
    pruneExpiredKeypadProviderOverrides,
    keypadProviderOverrides,
    callConfigurations,
    functionEngine,
    callFunctionSystems,
    getCallCanaryState,
  } = ctx;

  return async function handleHealth(req, res) {
    const timestamp = new Date().toISOString();
    const isReadinessProbe = req.path === "/ready";
    try {
      const db =
        typeof ctx.getDb === "function"
          ? ctx.getDb()
          : ctx.db;
      if (!isReadinessProbe) {
        if (!db) {
          return res.json({
            status: "degraded",
            timestamp,
            public: true,
            readiness: "degraded",
            enhanced_features: true,
            services: {
              database: {
                connected: false,
                error: "Database unavailable",
              },
            },
          });
        }
        try {
          await db.healthCheck();
          return res.json({
            status: "healthy",
            timestamp,
            public: true,
            readiness: "ready",
          });
        } catch (error) {
          const payload = buildDegradedHealthPayload(error, { timestamp });
          if (isSqliteCorruptionError(error)) {
            console.error(
              "Public health check detected database corruption:",
              error?.message || error,
            );
          } else {
            console.error("Public health check error:", error);
          }
          return res.json({
            ...payload,
            public: true,
            readiness: "degraded",
          });
        }
      }

      const hmacSecret = config.apiAuth?.hmacSecret;
      const hmacOk = hmacSecret ? verifyHmacSignature(req).ok : false;
      const adminOk = hasAdminToken(req);
      if (!hmacOk && !adminOk) {
        return res.status(401).json({
          status: "unauthorized",
          timestamp,
          error: "Unauthorized",
        });
      }
      if (!db) {
        return res.status(503).json({
          status: "unhealthy",
          timestamp,
          enhanced_features: true,
          error: "Database unavailable",
        });
      }

      const calls = await db.getCallsWithTranscripts(1);
      const webhookHealth = await webhookService.healthCheck();
      const callStats = webhookService.getCallStatusStats();
      const notificationMetrics = await db.getNotificationAnalytics(1);
      await refreshInboundDefaultScript();
      const { inboundDefaultSummary, inboundEnvSummary } =
        getInboundHealthContext();
      const providerHealthSummary = supportedProviders.reduce((acc, provider) => {
        const health = providerHealth.get(provider) || {};
        acc[provider] = {
          configured: Boolean(getProviderReadiness()[provider]),
          degraded: isProviderDegraded(provider),
          circuit_state: health.circuitState || "closed",
          health_score:
            typeof getProviderHealthScore === "function"
              ? getProviderHealthScore(provider)
              : Number.isFinite(Number(health.score))
                ? Number(health.score)
                : null,
          consecutive_errors: Number(health.consecutiveErrors) || 0,
          consecutive_successes: Number(health.consecutiveSuccesses) || 0,
          last_error_at: health.lastErrorAt || null,
          last_success_at: health.lastSuccessAt || null,
        };
        return acc;
      }, {});
      pruneExpiredKeypadProviderOverrides();
      const keypadOverrideSummary = [...keypadProviderOverrides.entries()].map(
        ([scopeKey, override]) => ({
          scope_key: scopeKey,
          provider: override?.provider || null,
          expires_at: override?.expiresAt
            ? new Date(override.expiresAt).toISOString()
            : null,
        }),
      );

      const recentHealthLogs = await new Promise((resolve, reject) => {
        db.db.all(
          `
          SELECT service_name, status, COUNT(*) as count
          FROM service_health_logs 
          WHERE timestamp >= datetime('now', '-1 hour')
          GROUP BY service_name, status
          ORDER BY service_name
        `,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        );
      });

      return res.json({
        status: "healthy",
        timestamp,
        enhanced_features: true,
        services: {
          database: {
            connected: true,
            recent_calls: calls.length,
          },
          webhook_service: webhookHealth,
          call_tracking: callStats,
          notification_system: {
            total_today: notificationMetrics.total_notifications,
            success_rate: notificationMetrics.overall_success_rate + "%",
            avg_delivery_time:
              notificationMetrics.breakdown.length > 0
                ? notificationMetrics.breakdown[0].avg_delivery_time + "ms"
                : "N/A",
          },
          provider_failover: providerHealthSummary,
          keypad_guard: {
            enabled: config.keypadGuard?.enabled === true,
            active_overrides: keypadOverrideSummary.length,
            overrides: keypadOverrideSummary,
          },
        },
        active_calls: callConfigurations.size,
        adaptation_engine: {
          available_scripts: functionEngine
            ? functionEngine.getBusinessAnalysis().availableTemplates.length
            : 0,
          active_function_systems: callFunctionSystems.size,
        },
        call_canary:
          typeof getCallCanaryState === "function"
            ? getCallCanaryState()
            : null,
        inbound_defaults: inboundDefaultSummary,
        inbound_env_defaults: inboundEnvSummary,
        system_health: recentHealthLogs,
      });
    } catch (error) {
      console.error("Enhanced health check error:", error);
      const payload = buildDegradedHealthPayload(error, { timestamp });
      return res.status(503).json(payload);
    }
  };
}

function parseWindowMinutes(rawValue, fallback = 60) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(1440, Number(fallback) || 60));
  return Math.max(1, Math.min(1440, parsed));
}

function createGptObservabilityHandler(ctx = {}) {
  const { config, verifyHmacSignature, hasAdminToken } = ctx;

  return async function handleGptObservability(req, res) {
    try {
      const db =
        typeof ctx.getDb === "function"
          ? ctx.getDb()
          : ctx.db;
      if (!db) {
        return res.status(500).json({
          success: false,
          error: "Database unavailable",
        });
      }

      const hmacSecret = config.apiAuth?.hmacSecret;
      const hmacOk = hmacSecret ? verifyHmacSignature(req).ok : false;
      const adminOk = hasAdminToken(req);
      if (!hmacOk && !adminOk) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
        });
      }

      const requestedWindow = parseWindowMinutes(
        req.query?.window_minutes,
        config.openRouter?.alerting?.windowMinutes || 60,
      );
      const summary = await db.getGptObservabilitySummary(requestedWindow);
      const thresholds = {
        tool_failure_rate:
          Number(config.openRouter?.alerting?.toolFailureRate) ||
          Number(config.openRouter?.slo?.toolFailureRate) ||
          0.35,
        circuit_open_count:
          Number(config.openRouter?.alerting?.circuitOpenCount) || 2,
        slo_degraded_count:
          Number(config.openRouter?.alerting?.sloDegradedCount) || 1,
      };
      const alerts = [];
      const failureRate = Number(summary?.tool_execution?.failure_rate) || 0;
      const circuitOpenCount = Number(summary?.circuits?.open) || 0;
      const sloDegradedCount = Number(summary?.slo?.degraded) || 0;

      if (failureRate > thresholds.tool_failure_rate) {
        alerts.push({
          code: "tool_failure_rate_high",
          severity: "high",
          current: failureRate,
          threshold: thresholds.tool_failure_rate,
        });
      }
      if (circuitOpenCount >= thresholds.circuit_open_count) {
        alerts.push({
          code: "circuit_open_events_high",
          severity: "high",
          current: circuitOpenCount,
          threshold: thresholds.circuit_open_count,
        });
      }
      if (sloDegradedCount >= thresholds.slo_degraded_count) {
        alerts.push({
          code: "slo_degraded_events",
          severity: "medium",
          current: sloDegradedCount,
          threshold: thresholds.slo_degraded_count,
        });
      }

      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        window_minutes: requestedWindow,
        thresholds,
        alerts,
        summary,
      });
    } catch (error) {
      console.error("Error fetching GPT observability summary:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch GPT observability summary",
      });
    }
  };
}

function createAnomalyObservabilityHandler(ctx = {}) {
  const { config, hasAdminToken } = ctx;
  return async function handleAnomalyObservability(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db || typeof db.getPlatformAnomalyMetrics !== "function") {
        return res.status(503).json({ success: false, error: "Anomaly observability is unavailable" });
      }
      const adminOk = typeof hasAdminToken === "function" && hasAdminToken(req);
      // HMAC-authenticated routes have already passed the global request middleware.
      // Re-verifying here would consume a strict replay key twice for one request.
      if (!config.apiAuth?.hmacSecret && !adminOk) return res.status(401).json({ success: false, error: "Unauthorized" });

      const windowMinutes = parseWindowMinutes(req.query?.window_minutes, 60);
      const metrics = await db.getPlatformAnomalyMetrics(windowMinutes);
      let apiAuthFailures = { window_minutes: windowMinutes, total: 0, by_reason: {}, scope: "unavailable" };
      try {
        if (typeof ctx.flushApiAuthFailureMetrics === "function") await ctx.flushApiAuthFailureMetrics();
        if (typeof ctx.getApiAuthFailureMetrics === "function") apiAuthFailures = await ctx.getApiAuthFailureMetrics(windowMinutes);
      } catch (_) {
        apiAuthFailures = typeof ctx.getLocalApiAuthFailureMetrics === "function"
          ? ctx.getLocalApiAuthFailureMetrics(windowMinutes)
          : apiAuthFailures;
      }
      const configured = config.anomalyDetection || {};
      const threshold = (value, fallback, min = 1, max = 1000000) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
      };
      const thresholds = {
        call_volume_min_current: threshold(configured.callVolumeMinCurrent, 25, 1, 1000000),
        call_volume_growth_factor: threshold(configured.callVolumeGrowthFactor, 3, 1.1, 100),
        provider_open_count: threshold(configured.providerOpenCount, 1, 1, 10),
        provider_call_failures: threshold(configured.providerFailureCount, 5, 1, 100000),
        dispatch_retry_count: threshold(configured.dispatchRetryCount, 5, 1, 100000),
        campaign_dispatches_today: threshold(configured.campaignDispatchCount, 100, 1, 1000000),
        webhook_failure_count: threshold(configured.webhookFailureCount, 5, 1, 100000),
        workflow_failure_count: threshold(configured.workflowFailureCount, 3, 1, 100000),
        workflow_retry_count: threshold(configured.workflowRetryCount, 10, 1, 100000),
        authorization_alert_count: threshold(configured.authAlertCount, 3, 1, 100000),
        api_authentication_failures: threshold(configured.apiAuthFailureCount, 10, 1, 100000),
        miniapp_authentication_failures: threshold(configured.miniAppAuthFailureCount, 10, 1, 100000),
        admin_token_authentication_failures: threshold(configured.adminAuthFailureCount, 10, 1, 100000),
        webhook_authentication_failures: threshold(configured.webhookAuthFailureCount, 10, 1, 100000),
      };
      const alerts = [];
      const currentCalls = Number(metrics.calls?.current_window) || 0;
      const previousCalls = Number(metrics.calls?.previous_window) || 0;
      const volumeBaseline = Math.max(1, previousCalls);
      if (currentCalls >= thresholds.call_volume_min_current && currentCalls >= volumeBaseline * thresholds.call_volume_growth_factor) {
        alerts.push({ code: "call_volume_surge", severity: "medium", current: currentCalls, previous_window: previousCalls,
          threshold: thresholds.call_volume_min_current, growth_factor: thresholds.call_volume_growth_factor });
      }
      if ((Number(metrics.provider_open_count) || 0) >= thresholds.provider_open_count) {
        alerts.push({ code: "provider_circuit_open", severity: "high", current: Number(metrics.provider_open_count) || 0,
          threshold: thresholds.provider_open_count, providers: metrics.open_providers || [] });
      }
      const providerFailureCount = Number(metrics.provider_call_error_count) || 0;
      if (providerFailureCount >= thresholds.provider_call_failures) {
        alerts.push({ code: "provider_call_failures", severity: "high", current: providerFailureCount,
          threshold: thresholds.provider_call_failures, providers: metrics.provider_call_errors || [] });
      }
      const apiAuthFailureCount = Number(apiAuthFailures?.total) || 0;
      if (apiAuthFailureCount >= thresholds.api_authentication_failures) {
        alerts.push({ code: "api_authentication_failures", severity: "high", current: apiAuthFailureCount,
          threshold: thresholds.api_authentication_failures, by_reason: apiAuthFailures.by_reason || {} });
      }
      const miniAppAuthFailures = apiAuthFailures?.miniapp_session || { total: 0, by_reason: {} };
      const miniAppAuthFailureCount = Number(miniAppAuthFailures.total) || 0;
      if (miniAppAuthFailureCount >= thresholds.miniapp_authentication_failures) {
        alerts.push({ code: "miniapp_authentication_failures", severity: "high", current: miniAppAuthFailureCount,
          threshold: thresholds.miniapp_authentication_failures, by_reason: miniAppAuthFailures.by_reason || {} });
      }
      const adminTokenFailures = apiAuthFailures?.admin_token || { total: 0, by_reason: {} };
      const adminTokenFailureCount = Number(adminTokenFailures.total) || 0;
      if (adminTokenFailureCount >= thresholds.admin_token_authentication_failures) {
        alerts.push({ code: "admin_token_authentication_failures", severity: "high", current: adminTokenFailureCount,
          threshold: thresholds.admin_token_authentication_failures, by_reason: adminTokenFailures.by_reason || {} });
      }
      const webhookAuthFailures = apiAuthFailures?.webhook_auth || { total: 0, by_reason: {} };
      const webhookAuthFailureCount = Number(webhookAuthFailures.total) || 0;
      if (webhookAuthFailureCount >= thresholds.webhook_authentication_failures) {
        alerts.push({ code: "webhook_authentication_failures", severity: "high", current: webhookAuthFailureCount,
          threshold: thresholds.webhook_authentication_failures, by_reason: webhookAuthFailures.by_reason || {} });
      }
      const countRules = [
        ["call_dispatch_retries", "dispatch_retry_count", "dispatch_retry_count", "high"],
        ["campaign_consumption_high", "campaign_dispatches_today", "campaign_dispatches_today", "medium"],
        ["outgoing_webhook_failures", "webhook_failure_count", "webhook_failure_count", "high"],
        ["workflow_failures_high", "workflow_failure_count", "workflow_failure_count", "medium"],
        ["workflow_retries_high", "workflow_retry_count", "workflow_retry_count", "medium"],
        ["authorization_failure_alerts", "authorization_alert_count", "authorization_alert_count", "high"],
      ];
      for (const [code, metricName, thresholdName, severity] of countRules) {
        const current = Number(metrics[metricName]) || 0;
        if (current >= thresholds[thresholdName]) alerts.push({ code, severity, current, threshold: thresholds[thresholdName] });
      }
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        window_minutes: windowMinutes,
        informational_only: true,
        thresholds,
        alerts,
        summary: { ...metrics, api_hmac_auth_failures: apiAuthFailures,
          miniapp_session_auth_failures: miniAppAuthFailures, admin_token_auth_failures: adminTokenFailures,
          webhook_auth_failures: webhookAuthFailures },
        data_notes: {
          provider_failures: "Includes latest provider diagnostic circuit snapshots and failed/error call rows with a persisted error code grouped by selected provider. It excludes failures without a local call error record.",
          campaign_consumption: "Counts CALL-E recipients with a local call ID dispatched during the current UTC day; active reservations are reported separately.",
          authorization_failures: "The authorization_failure_alerts metric counts configured Mini App threshold-alert events. Mini App session denials are separately reason-bucketed without user, route, token, or request identifiers.",
          api_authentication_failures: "Counts global HMAC middleware rejections only; bypass webhook routes and webhook signature failures are excluded. Counts are batched from each API process into shared SQLite buckets; at most the latest flush interval can be missing after abrupt process termination.",
          miniapp_authentication_failures: "Counts missing, invalid, revoked, replayed, or unauthorized Mini App sessions/init data across processes sharing the SQLite file. Counts are reason-bucketed, omit user, route, token, and request identifiers, and are retained up to 24 hours.",
          admin_token_authentication_failures: "Counts missing or invalid admin-token attempts at centrally guarded routes across processes sharing SQLite. Token values, route names, and request identifiers are omitted; counts are retained up to 24 hours.",
          webhook_authentication_failures: "Counts rejected webhook authentication verifiers across guarded webhook routes as a single fixed reason. Provider, route, signature, request, and payload values are omitted; counts are retained up to 24 hours.",
          workflow_retries: "Counts durable post-call workflow event rows with more than one processing attempt in the selected window. It does not count action-level retries performed by external systems.",
        },
      });
    } catch (error) {
      console.error("Error fetching platform anomaly summary:", error);
      return res.status(500).json({ success: false, error: "Failed to fetch platform anomaly summary" });
    }
  };
}

function registerStatusRoutes(app, ctx = {}) {
  const requireOutboundAuthorization =
    typeof ctx.requireOutboundAuthorization === "function"
      ? ctx.requireOutboundAuthorization
      : (_req, _res, next) => next();
  const handleGetCallStatus = createGetCallStatusHandler(ctx);
  const handleSystemStatus = createSystemStatusHandler(ctx);
  const handleProviderCompatibility = createProviderCompatibilityHandler(ctx);
  const handleProviderRecommendation = createProviderRecommendationHandler(ctx);
  const handleHealth = createHealthHandler(ctx);
  const handleGptObservability = createGptObservabilityHandler(ctx);
  const handleAnomalyObservability = createAnomalyObservabilityHandler(ctx);
  const requireAdminToken = typeof ctx.requireAdminToken === "function"
    ? ctx.requireAdminToken
    : (_req, _res, next) => next();

  app.get("/api/calls/:callSid/status", requireOutboundAuthorization, handleGetCallStatus);
  app.get("/api/observability/gpt", requireOutboundAuthorization, handleGptObservability);
  app.get("/api/observability/anomalies", requireOutboundAuthorization, handleAnomalyObservability);
  app.get("/status/provider-compat", requireOutboundAuthorization, handleProviderCompatibility);
  app.get("/admin/provider/recommendation", requireAdminToken, handleProviderRecommendation);
  app.get("/ready", handleHealth);
  app.get("/status", handleSystemStatus);
  app.get("/health", handleHealth);
}

module.exports = {
  registerStatusRoutes,
  __testables: {
    createHealthHandler,
    createGetCallStatusHandler,
    createProviderRecommendationHandler,
    createAnomalyObservabilityHandler,
    normalizeExecutionProgress,
  },
};
