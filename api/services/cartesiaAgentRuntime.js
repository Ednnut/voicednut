"use strict";

const DEFAULT_VERSION = "2026-08-14";
const { cartesiaWebSocketBaseUrl } = require("./cartesiaEndpoints");
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const AUDIO_FORMATS = new Set(["pcm_16000", "pcm_24000", "pcm_44100", "mulaw_8000"]);
const DOWNSTREAM_EVENT_TYPES = new Set([
  "session_ready", "audio_output", "audio_output_clear",
  "turn_started", "turn_output_text_delta", "turn_ended", "error",
]);

function runtimeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return Buffer.byteLength(String(value));
}

function parseJson(raw, direction) {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) throw runtimeError("cartesia_agent_message_too_large", `${direction} message exceeds the 1 MiB limit`, 413);
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") :
    ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8") :
      raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : String(raw);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch {
    throw runtimeError("cartesia_agent_message_invalid", `${direction} message must be a JSON object`, 400);
  }
}

function sendJson(socket, event) {
  if (socket?.readyState !== undefined && socket.readyState !== 1) return false;
  socket.send(JSON.stringify(event));
  return true;
}

function closeSocket(socket, code = 1000, reason = "session completed") {
  try {
    if (socket && (socket.readyState === undefined || socket.readyState < 2)) socket.close(code, reason);
  } catch { /* cleanup is best effort */ }
}

/**
 * Bridges an already-authenticated VOICEDNUT WebSocket to a Cartesia Managed Agent.
 * The caller must authenticate/authorize before invoking handle(), resolve agentId
 * from trusted configuration, and pass that identity as actor.
 */
class CartesiaAgentRuntime {
  constructor(options = {}) {
    this.WebSocket = options.WebSocket || require("ws");
    this.apiKey = String(options.apiKey || "").trim();
    this.agentId = String(options.agentId || "").trim();
    this.apiVersion = String(options.apiVersion || DEFAULT_VERSION).trim();
    this.websocketBaseUrl = cartesiaWebSocketBaseUrl(options.apiBaseUrl);
    this.connectTimeoutMs = Math.max(1000, Math.min(30000, Number(options.connectTimeoutMs) || 10000));
    this.idleTimeoutMs = Math.max(1000, Math.min(120000, Number(options.idleTimeoutMs) || 120000));
    this.sessionTimeoutMs = Math.max(this.idleTimeoutMs, Math.min(4 * 60 * 60 * 1000, Number(options.sessionTimeoutMs) || 30 * 60 * 1000));
    const handlers = options.toolHandlers || options.tools || {};
    this.toolHandlers = handlers instanceof Map ? handlers : new Map(Object.entries(handlers));
    if (!this.apiKey) throw runtimeError("cartesia_agent_not_configured", "Cartesia agent runtime is not configured", 503);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) throw runtimeError("cartesia_agent_version_invalid", "Cartesia API version is invalid", 500);
  }

  connect({ clientSocket, actor, agentId = this.agentId, audio = {} } = {}) {
      const { WebSocket, apiKey, apiVersion, connectTimeoutMs, idleTimeoutMs, sessionTimeoutMs, toolHandlers } = this;
      if (!actor || typeof actor !== "object" || !actor.id) throw runtimeError("cartesia_agent_actor_required", "An authenticated actor is required", 401);
      const resolvedAgentId = String(agentId || "").trim();
      if (!ID_PATTERN.test(resolvedAgentId)) throw runtimeError("cartesia_agent_id_invalid", "A valid authorized Cartesia agent is required", 400);
      if (!clientSocket || typeof clientSocket.on !== "function") throw runtimeError("cartesia_agent_client_socket_required", "A client WebSocket is required", 400);
      const inputFormat = String(audio.input_format || "pcm_16000");
      if (!AUDIO_FORMATS.has(inputFormat)) throw runtimeError("cartesia_agent_audio_format_invalid", "Unsupported Cartesia input audio format", 400);
      const outputDelivery = audio.output_delivery === "as_available" ? "as_available" : "speaking_pace";
      const continuousInput = audio.continuous_input === true;

      const params = new URLSearchParams({ cartesia_version: apiVersion });
      const url = `${this.websocketBaseUrl}/v1/agents/websocket/${encodeURIComponent(resolvedAgentId)}?${params}`;
      let upstream;
      try { upstream = new WebSocket(url, { headers: { "X-API-Key": apiKey }, maxPayload: MAX_MESSAGE_BYTES }); }
      catch { throw runtimeError("cartesia_agent_upstream_unavailable", "Cartesia agent connection could not be started", 502); }

      let ready = false;
      let closed = false;
      let lastActivity = Date.now();
      let callId = null;
      const seenToolCalls = new Set();
      const safeCloseClient = (code, reason) => closeSocket(clientSocket, code, reason);
      const cleanup = (code = 1000, reason = "session completed") => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearInterval(idleTimer);
        clearTimeout(sessionTimer);
        closeSocket(upstream, code, reason);
        safeCloseClient(code, reason);
      };
      const fail = (code, message, status = 502) => {
        if (closed) return;
        try { sendJson(clientSocket, { type: "error", code, message }); } catch { /* socket may already be gone */ }
        cleanup(status === 1008 ? 1008 : 1011, message);
      };
      const touch = () => { lastActivity = Date.now(); };
      const connectTimer = setTimeout(() => fail("cartesia_agent_connect_timeout", "Cartesia agent connection timed out", 504), connectTimeoutMs);
      connectTimer.unref?.();
      const idleTimer = setInterval(() => {
        if (!closed && Date.now() - lastActivity >= idleTimeoutMs) fail("cartesia_agent_idle_timeout", "Cartesia agent session timed out due to inactivity", 504);
      }, Math.min(1000, idleTimeoutMs));
      idleTimer.unref?.();
      const sessionTimer = setTimeout(() => fail("cartesia_agent_session_timeout", "Cartesia agent session reached its time limit", 504), sessionTimeoutMs);
      sessionTimer.unref?.();

      upstream.on("open", () => {
        if (closed) return;
        touch();
        try {
          upstream.send(JSON.stringify({
            type: "session_create",
            audio: { input_format: inputFormat, output_delivery: outputDelivery, ...(continuousInput ? { continuous_input: true } : {}) },
          }));
        } catch { fail("cartesia_agent_session_start_failed", "Cartesia agent session could not be started"); }
      });

      upstream.on("message", (raw) => {
        if (closed) return;
        touch();
        let event;
        try { event = parseJson(raw, "Cartesia"); }
        catch (error) { return fail(error.code, error.message, error.status); }
        if (event.type === "session_ready") {
          if (ready || !ID_PATTERN.test(String(event.call_id || ""))) return fail("cartesia_agent_session_invalid", "Cartesia returned an invalid session response");
          ready = true;
          callId = String(event.call_id);
          clearTimeout(connectTimer);
        }
        if (event.type === "client_tool_call") {
          void dispatchTool(event).catch(() => fail("cartesia_agent_tool_dispatch_failed", "Cartesia client tool could not be completed"));
          return;
        }
        if (event.type === "error") {
          try {
            sendJson(clientSocket, {
              type: "error",
              code: "cartesia_agent_provider_error",
              message: "Cartesia could not process the agent session.",
              ...(typeof event.fatal === "boolean" ? { fatal: event.fatal } : {}),
            });
          } catch { cleanup(1011, "provider error delivery failed"); }
          return;
        }
        if (DOWNSTREAM_EVENT_TYPES.has(event.type)) {
          try { sendJson(clientSocket, event); }
          catch { cleanup(1011, "client delivery failed"); }
        }
      });

      clientSocket.on("message", (raw) => {
        if (closed) return;
        touch();
        let event;
        try { event = parseJson(raw, "Client"); }
        catch (error) { return fail(error.code, error.message, error.status); }
        if (event.type !== "audio_input" || typeof event.audio !== "string" || !event.audio.length ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.audio)) {
          return fail("cartesia_agent_input_invalid", "Only valid base64 audio_input events are accepted", 1008);
        }
        // Cartesia requires the client to wait for session_ready; discard early audio
        // rather than closing an otherwise healthy session on startup races.
        if (!ready) return;
        if (byteLength(raw) > MAX_MESSAGE_BYTES) return fail("cartesia_agent_message_too_large", "Client message exceeds the 1 MiB limit", 413);
        try { upstream.send(JSON.stringify({ type: "audio_input", audio: event.audio })); }
        catch { fail("cartesia_agent_upstream_unavailable", "Cartesia agent connection is unavailable"); }
      });

      clientSocket.on("close", () => cleanup());
      clientSocket.on("error", () => cleanup(1011, "client connection failed"));
      upstream.on("close", () => cleanup());
      upstream.on("error", () => fail("cartesia_agent_upstream_unavailable", "Cartesia agent connection is unavailable"));

      async function dispatchTool(event) {
        if (!event || typeof event.tool_call_id !== "string" || !ID_PATTERN.test(event.tool_call_id) ||
            typeof event.tool_name !== "string" || !ID_PATTERN.test(event.tool_name) ||
            !event.parameters || typeof event.parameters !== "object" || Array.isArray(event.parameters)) {
          throw runtimeError("cartesia_agent_tool_call_invalid", "Cartesia sent an invalid client tool call", 502);
        }
        if (seenToolCalls.has(event.tool_call_id)) return;
        if (seenToolCalls.size >= 1000) throw runtimeError("cartesia_agent_tool_limit", "Session tool-call limit reached", 429);
        seenToolCalls.add(event.tool_call_id);
        try {
          const handler = toolHandlers.get(event.tool_name);
          if (typeof handler !== "function") throw runtimeError("cartesia_agent_tool_unavailable", "Tool is not enabled", 403);
          let toolTimer;
          const result = await Promise.race([
            Promise.resolve().then(() => handler(event.parameters, { actor, agentId: resolvedAgentId, callId, toolCallId: event.tool_call_id })),
            new Promise((_, reject) => {
              toolTimer = setTimeout(() => reject(runtimeError("cartesia_agent_tool_timeout", "Tool execution timed out", 504)), Math.min(120000, idleTimeoutMs));
              toolTimer.unref?.();
            }),
          ]).finally(() => clearTimeout(toolTimer));
          if (event.expects_response === true && !closed) {
            const resultText = typeof result === "string" ? result : JSON.stringify(result ?? null);
            if (Buffer.byteLength(resultText) > MAX_TOOL_RESULT_BYTES) throw runtimeError("cartesia_agent_tool_result_too_large", "Tool result exceeds the 16 KiB limit", 413);
            upstream.send(JSON.stringify({ type: "client_tool_result", tool_call_id: event.tool_call_id, result: resultText, is_error: false }));
          }
        } catch {
          if (event.expects_response === true && !closed) {
            upstream.send(JSON.stringify({ type: "client_tool_result", tool_call_id: event.tool_call_id, result: "The requested action could not be completed.", is_error: true }));
          }
        } finally {
        }
      }

      return {
        close: cleanup,
        get callId() { return callId; },
        get ready() { return ready; },
      };
  }

  handle(connection) { return this.connect(connection); }
}

function createCartesiaAgentRuntime(options = {}) {
  return new CartesiaAgentRuntime(options);
}

module.exports = {
  CartesiaAgentRuntime,
  createCartesiaAgentRuntime,
  __testables: { MAX_MESSAGE_BYTES, MAX_TOOL_RESULT_BYTES, parseJson },
};
