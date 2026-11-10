"use strict";

const EventEmitter = require("node:events");
const WebSocket = require("ws");

const CARTESIA_LINE_AGENT_WS_BASE_URL = "wss://api.cartesia.ai/v1/agents/websocket";
const DEFAULT_CARTESIA_API_VERSION = "2026-08-14";
const MAX_CARTESIA_AGENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_CLIENT_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 128 * 1024;
const MAX_PENDING_TOOL_CALLS = 64;
const VALID_INPUT_FORMATS = new Set([
  "pcm_16000",
  "pcm_24000",
  "pcm_44100",
  "mulaw_8000",
]);
const VALID_OUTPUT_DELIVERY = new Set(["speaking_pace", "as_available"]);
const VALID_DTMF = /^[0-9*#]$/;

function requiredText(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`cartesia_line_${fieldName}_required`);
  return text;
}

function safeProviderError(event) {
  const code = String(event?.code || "cartesia_line_runtime_error")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
  const error = new Error(code || "cartesia_line_runtime_error");
  error.code = code || "cartesia_line_runtime_error";
  error.retryable = event?.fatal === false;
  return error;
}

function parseJsonFrame(frame) {
  try {
    const text = Buffer.isBuffer(frame) ? frame.toString("utf8") : String(frame);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validBase64(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").byteLength <= MAX_AUDIO_CHUNK_BYTES;
}

class CartesiaLineAgentSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apiKey = requiredText(options.apiKey, "api_key");
    this.agentId = requiredText(options.agentId, "agent_id");
    this.apiVersion = String(options.apiVersion || DEFAULT_CARTESIA_API_VERSION).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) {
      throw new Error("cartesia_line_api_version_invalid");
    }

    this.inputFormat = String(options.inputFormat || "mulaw_8000").trim();
    if (!VALID_INPUT_FORMATS.has(this.inputFormat)) {
      throw new Error("cartesia_line_input_format_unsupported");
    }
    this.outputDelivery = String(options.outputDelivery || "speaking_pace").trim();
    if (!VALID_OUTPUT_DELIVERY.has(this.outputDelivery)) {
      throw new Error("cartesia_line_output_delivery_unsupported");
    }
    this.continuousInput = options.continuousInput !== false;
    this.connectTimeoutMs = Math.max(1000, Math.min(9000, Number(options.connectTimeoutMs) || 8000));
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.connection = null;
    this.connected = false;
    this.closed = false;
    this.callId = null;
    this.agentVersionId = null;
    this.pendingToolCalls = new Set();
    this.connectTimer = null;
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  get url() {
    const agentId = encodeURIComponent(this.agentId);
    return `${CARTESIA_LINE_AGENT_WS_BASE_URL}/${agentId}?cartesia_version=${encodeURIComponent(this.apiVersion)}`;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.closed) return Promise.reject(new Error("cartesia_line_session_closed"));

    this.connectPromise = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.connectTimer = setTimeout(() => {
        this.failConnect(new Error("cartesia_line_session_ready_timeout"));
      }, this.connectTimeoutMs);

      try {
        this.connection = new this.WebSocketImpl(this.url, {
          headers: { "X-API-Key": this.apiKey },
          maxPayload: MAX_CARTESIA_AGENT_MESSAGE_BYTES,
          perMessageDeflate: false,
        });
      } catch {
        this.failConnect(new Error("cartesia_line_connection_failed"));
        return;
      }

      this.connection.on("open", () => {
        this.sendMessage({
          type: "session_create",
          audio: {
            input_format: this.inputFormat,
            output_delivery: this.outputDelivery,
            continuous_input: this.continuousInput,
          },
        });
      });
      this.connection.on("message", (frame) => this.handleFrame(frame));
      this.connection.on("error", () => {
        const error = new Error("cartesia_line_connection_error");
        this.emit("error", error);
        this.failConnect(error);
      });
      this.connection.on("close", (code, reason) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.closed = true;
        this.clearConnectTimer();
        if (!wasConnected) this.failConnect(new Error("cartesia_line_session_closed_before_ready"));
        this.emit("close", { code: Number(code) || 0 });
      });
    });

    return this.connectPromise;
  }

  clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  failConnect(error) {
    this.clearConnectTimer();
    if (this.rejectConnect) {
      const reject = this.rejectConnect;
      this.rejectConnect = null;
      this.resolveConnect = null;
      reject(error);
    }
  }

  sendMessage(message) {
    if (!this.connection || this.connection.readyState !== this.WebSocketImpl.OPEN) return false;
    try {
      this.connection.send(JSON.stringify(message));
      return true;
    } catch {
      this.emit("error", new Error("cartesia_line_send_failed"));
      return false;
    }
  }

  handleFrame(frame) {
    const event = parseJsonFrame(frame);
    if (!event || typeof event.type !== "string") {
      this.emit("error", new Error("cartesia_line_invalid_event"));
      return;
    }

    switch (event.type) {
      case "session_ready": {
        const validCallId = typeof event.call_id === "string" && event.call_id.length > 0 && event.call_id.length <= 200;
        const validAgentVersionId = typeof event.agent_version_id === "string" &&
          event.agent_version_id.length > 0 && event.agent_version_id.length <= 200;
        const validAudio = event.audio && typeof event.audio === "object" &&
          !Array.isArray(event.audio) && event.audio.input_format === this.inputFormat;
        if (this.connected || !validCallId || event.agent_id !== this.agentId || !validAgentVersionId || !validAudio) {
          const error = new Error("cartesia_line_invalid_session_ready");
          error.code = "cartesia_line_invalid_session_ready";
          this.failConnect(error);
          this.emit("error", error);
          this.connection?.close(1008, "invalid session ready");
          return;
        }
        this.connected = true;
        this.callId = event.call_id;
        this.agentVersionId = event.agent_version_id;
        this.clearConnectTimer();
        const resolve = this.resolveConnect;
        this.resolveConnect = null;
        this.rejectConnect = null;
        resolve?.({ callId: this.callId, agentId: event.agent_id, agentVersionId: this.agentVersionId });
        this.emit("ready", { callId: this.callId, agentId: event.agent_id, agentVersionId: this.agentVersionId });
        return;
      }
      case "audio_output": {
        if (!this.connected || !validBase64(event.audio)) {
          this.emit("error", new Error("cartesia_line_audio_output_invalid"));
          return;
        }
        this.emit("audio", { base64: event.audio, bytes: Buffer.from(event.audio, "base64") });
        return;
      }
      case "audio_output_clear":
        this.emit("clear");
        return;
      case "turn_started":
        if (event.role === "user") this.emit("userStartedSpeaking", event.turn);
        if (event.role === "assistant") this.emit("agentStartedSpeaking", event.turn);
        return;
      case "turn_output_text_delta":
        this.emit("conversationTextDelta", {
          role: event.role,
          content: String(event.text || ""),
          turn: event.turn,
        });
        return;
      case "turn_ended":
        this.emit("conversationText", { role: event.role, content: String(event.text || ""), turn: event.turn });
        return;
      case "client_tool_call": {
        const id = String(event.tool_call_id || "").trim();
        const name = String(event.tool_name || "").trim();
        if (!id || !name || !event.parameters || typeof event.parameters !== "object" || Array.isArray(event.parameters)) {
          this.emit("error", new Error("cartesia_line_client_tool_call_invalid"));
          return;
        }
        if (event.expects_response === true) {
          if (this.pendingToolCalls.size >= MAX_PENDING_TOOL_CALLS) {
            this.emit("error", new Error("cartesia_line_too_many_pending_tool_calls"));
            return;
          }
          this.pendingToolCalls.add(id);
        }
        this.emit("functionCallRequest", {
          id,
          name,
          arguments: event.parameters,
          expectsResponse: event.expects_response === true,
        });
        return;
      }
      case "error":
        this.emit("error", safeProviderError(event));
        if (event.fatal === true) this.connection?.close(1000, "provider session error");
        return;
      default:
        this.emit("unhandledEvent", { type: event.type });
    }
  }

  sendAudioBase64(base64) {
    if (!this.connected || !validBase64(base64)) return false;
    return this.sendMessage({ type: "audio_input", audio: base64 });
  }

  sendAudio(bytes) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return false;
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AUDIO_CHUNK_BYTES) return false;
    return this.sendAudioBase64(buffer.toString("base64"));
  }

  sendDtmf(digit) {
    const normalized = String(digit || "");
    if (!this.connected || !VALID_DTMF.test(normalized)) return false;
    return this.sendMessage({ type: "dtmf_input", digit: normalized });
  }

  respondFunctionCall({ id, content, isError = false } = {}) {
    const toolCallId = String(id || "").trim();
    if (!this.connected || !toolCallId || !this.pendingToolCalls.has(toolCallId)) return false;
    const result = String(content ?? "");
    if (Buffer.byteLength(result, "utf8") > MAX_CLIENT_TOOL_RESULT_BYTES) {
      return this.sendMessage({ type: "client_tool_result", tool_call_id: toolCallId, result: "tool_result_too_large", is_error: true })
        ? (this.pendingToolCalls.delete(toolCallId), true)
        : false;
    }
    const sent = this.sendMessage({ type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError === true });
    if (sent) this.pendingToolCalls.delete(toolCallId);
    return sent;
  }

  close() {
    this.clearConnectTimer();
    this.closed = true;
    this.connected = false;
    this.pendingToolCalls.clear();
    if (this.connection && this.connection.readyState < this.WebSocketImpl.CLOSING) {
      this.connection.close(1000, "session completed");
    }
  }
}

module.exports = {
  CARTESIA_LINE_AGENT_WS_BASE_URL,
  DEFAULT_CARTESIA_API_VERSION,
  MAX_CLIENT_TOOL_RESULT_BYTES,
  CartesiaLineAgentSession,
};
