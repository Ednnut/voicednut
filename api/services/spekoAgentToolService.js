const crypto = require("node:crypto");
const { connectorPackTools } = require("../functions/connectorPacks");
const { verifySpekoAgentToolWebhook } = require("../adapters/spekoWebhookSecurity");

const TOOL_TIMEOUT_MS = 3500;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 8 * 1024;
const ALLOWED_TOOL_NAMES = new Set([
  "kb_search",
  "runbook_lookup",
  "policy_lookup",
  "product_doc_lookup",
]);
const ALLOWED_ENVELOPE_KEYS = new Set([
  "tool",
  "args",
  "idempotency_key",
  "session_id",
  "tool_call_id",
]);

const toolSchemas = new Map(
  connectorPackTools
    .filter((entry) => {
      const name = String(entry?.function?.name || "");
      const connector = entry?.function?.connector || {};
      return ALLOWED_TOOL_NAMES.has(name) && connector.class === "read";
    })
    .map((entry) => [entry.function.name, entry.function.parameters]),
);

function fail(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function validateJsonValue(value, schema, path = "args", depth = 0) {
  if (depth > 12) throw fail("speko_tool_arguments_too_deep");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw fail("speko_tool_schema_invalid", 500);
  }
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw fail("speko_tool_arguments_invalid");
    }
    const properties = schema.properties || {};
    const keys = Object.keys(value);
    if (keys.some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) {
      throw fail("speko_tool_arguments_unknown_property");
    }
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        throw fail("speko_tool_arguments_missing_property");
      }
    }
    for (const [key, child] of Object.entries(value)) {
      validateJsonValue(child, properties[key], `${path}.${key}`, depth + 1);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw fail("speko_tool_arguments_invalid");
    for (const [index, child] of value.entries()) {
      validateJsonValue(child, schema.items, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw fail("speko_tool_arguments_invalid");
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw fail("speko_tool_arguments_invalid");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw fail("speko_tool_arguments_invalid");
    }
  } else if (type === "integer") {
    if (!Number.isSafeInteger(value)) throw fail("speko_tool_arguments_invalid");
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw fail("speko_tool_arguments_invalid");
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") throw fail("speko_tool_arguments_invalid");
  } else if (type === "null") {
    if (value !== null) throw fail("speko_tool_arguments_invalid");
  } else {
    throw fail("speko_tool_schema_unsupported", 500);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw fail("speko_tool_arguments_invalid");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw fail("speko_tool_arguments_invalid");
    }
  }
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    throw fail("speko_tool_arguments_invalid");
  }
}

function validateToolEnvelope(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("speko_tool_payload_invalid");
  }
  if (Object.keys(payload).some((key) => !ALLOWED_ENVELOPE_KEYS.has(key))) {
    throw fail("speko_tool_payload_invalid");
  }
  const toolName = String(payload.tool || "");
  if (!ALLOWED_TOOL_NAMES.has(toolName) || !toolSchemas.has(toolName)) {
    throw fail("speko_tool_not_allowed", 403);
  }
  const sessionId = String(payload.session_id || "");
  const toolCallId = String(payload.tool_call_id || "");
  const idempotencyKey = String(payload.idempotency_key || "");
  if (
    !sessionId || sessionId.length > 256 ||
    !toolCallId || toolCallId.length > 256 ||
    !idempotencyKey || idempotencyKey.length > 600 ||
    idempotencyKey !== `${sessionId}:${toolCallId}`
  ) {
    throw fail("speko_tool_payload_invalid");
  }
  validateJsonValue(payload.args, toolSchemas.get(toolName));
  return { toolName, sessionId, idempotencyKey };
}

function isTerminalCall(call) {
  const status = String(call?.status || call?.call_status || "").trim().toLowerCase();
  return ["completed", "failed", "busy", "no-answer", "canceled", "cancelled", "ended"].includes(status);
}

function createSpekoAgentToolHandler(ctx = {}) {
  return async function handleSpekoAgentTool(req, res) {
    const spekoConfig = ctx.config?.speko || {};
    const secret = String(spekoConfig.agentToolWebhookSecret || "");
    if (spekoConfig.agentToolsEnabled !== true || spekoConfig.enabled !== true) {
      return res.status(404).json({ error: "speko_agent_tools_disabled" });
    }
    if (Buffer.byteLength(String(req.rawBody || ""), "utf8") > MAX_REQUEST_BYTES) {
      return res.status(413).json({ error: "speko_tool_payload_too_large" });
    }
    if (!verifySpekoAgentToolWebhook({
      secret,
      headers: req.headers,
      rawBody: req.rawBody,
      toleranceSeconds: spekoConfig.webhookToleranceSeconds,
    })) {
      return res.status(401).json({ error: "invalid_speko_tool_signature" });
    }

    let payload;
    try {
      payload = JSON.parse(String(req.rawBody || ""));
    } catch (_error) {
      return res.status(400).json({ error: "speko_tool_payload_invalid" });
    }

    let envelope;
    try {
      envelope = validateToolEnvelope(payload);
      const webhookId = String(req.headers?.["webhook-id"] || "");
      if (!webhookId || webhookId !== envelope.idempotencyKey) {
        throw fail("speko_tool_idempotency_mismatch");
      }
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.code || "speko_tool_payload_invalid" });
    }

    if (typeof ctx.resolveSessionCall !== "function" || typeof ctx.shouldProcessToolCall !== "function") {
      return res.status(503).json({ error: "speko_tool_runtime_unavailable" });
    }

    let call;
    try {
      call = await ctx.resolveSessionCall(envelope.sessionId);
    } catch (_error) {
      return res.status(503).json({ error: "speko_tool_call_lookup_failed" });
    }
    if (!call || String(call.provider || "").toLowerCase() !== "speko" || isTerminalCall(call)) {
      return res.status(403).json({ error: "speko_tool_session_not_authorized" });
    }

    let reserved = false;
    try {
      reserved = await ctx.shouldProcessToolCall(envelope.idempotencyKey);
    } catch (_error) {
      return res.status(503).json({ error: "speko_tool_idempotency_unavailable" });
    }
    if (!reserved) {
      return res.status(200).json({ status: "duplicate", idempotency_key: envelope.idempotencyKey });
    }

    let timeoutId;
    try {
      if (typeof ctx.executeTool !== "function") throw fail("speko_tool_runtime_unavailable", 503);
      const timeout = new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(fail("speko_tool_timeout", 503)), TOOL_TIMEOUT_MS);
      });
      const result = await Promise.race([
        ctx.executeTool({
          call,
          callSid: call.call_sid,
          tool: envelope.toolName,
          args: payload.args,
        }),
        timeout,
      ]);
      const serialized = JSON.stringify(result === undefined ? null : result);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
        throw fail("speko_tool_result_too_large", 502);
      }
      console.info("speko_agent_tool_completed", {
        tool: envelope.toolName,
        call_id_hash: crypto.createHash("sha256").update(call.call_sid).digest("hex").slice(0, 12),
        idempotency_key_present: true,
      });
      return res.status(200).json(JSON.parse(serialized));
    } catch (error) {
      await ctx.releaseToolCall?.(envelope.idempotencyKey).catch(() => {});
      console.warn("speko_agent_tool_failed", {
        tool: envelope.toolName,
        code: error?.code || "speko_tool_execution_failed",
      });
      return res.status(error.status || 503).json({
        error: error.code || "speko_tool_execution_failed",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

module.exports = {
  ALLOWED_TOOL_NAMES,
  createSpekoAgentToolHandler,
  validateJsonValue,
  validateToolEnvelope,
};
