"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CartesiaAgentRuntime, createCartesiaAgentRuntime, __testables } = require("../services/cartesiaAgentRuntime");

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.readyState = FakeSocket.OPEN;
    FakeSocket.instances.push(this);
  }
  send(value) { this.sent.push(value); }
  close(code, reason) {
    if (this.readyState >= 2) return;
    this.closeArgs = [code, reason];
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason || ""));
  }
  message(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
}

function makeSession(options = {}) {
  FakeSocket.instances = [];
  const client = new FakeSocket("client");
  FakeSocket.instances = [];
  const runtime = createCartesiaAgentRuntime({
    WebSocket: FakeSocket,
    apiKey: "secret-test-key",
    connectTimeoutMs: 20000,
    idleTimeoutMs: 20000,
    sessionTimeoutMs: 30000,
    ...options,
  });
  const session = runtime.handle({ clientSocket: client, actor: { id: "operator_1" }, agentId: "agent_1", audio: { input_format: "pcm_24000" } });
  return { client, upstream: FakeSocket.instances[0], session };
}

function event(socket, value) {
  return socket.sent.map((raw) => JSON.parse(raw)).find((item) => item.type === value);
}

describe("Cartesia Managed Agent runtime", () => {
  it("connects using server authentication and starts a documented audio session", () => {
    const { upstream } = makeSession();
    assert.equal(upstream.url, "wss://api.cartesia.ai/v1/agents/websocket/agent_1?cartesia_version=2026-08-14");
    assert.deepEqual(upstream.options.headers, { "X-API-Key": "secret-test-key" });
    assert.equal(upstream.options.maxPayload, __testables.MAX_MESSAGE_BYTES);
    upstream.emit("open");
    assert.deepEqual(JSON.parse(upstream.sent[0]), {
      type: "session_create",
      audio: { input_format: "pcm_24000", output_delivery: "speaking_pace" },
    });
  });

  it("waits for session_ready and relays audio, barge-in, and turn events", () => {
    const { client, upstream, session } = makeSession();
    upstream.emit("open");
    const input = Buffer.from("pcm audio").toString("base64");
    client.emit("message", Buffer.from(JSON.stringify({ type: "audio_input", audio: input })));
    assert.equal(upstream.sent.some((raw) => JSON.parse(raw).type === "audio_input"), false);
    upstream.message({ type: "session_ready", call_id: "ac_call_1", agent_version_id: "av_1" });
    assert.equal(session.ready, true);
    assert.equal(session.callId, "ac_call_1");
    client.emit("message", Buffer.from(JSON.stringify({ type: "audio_input", audio: input })));
    assert.deepEqual(JSON.parse(upstream.sent.at(-1)), { type: "audio_input", audio: input });
    upstream.message({ type: "audio_output", audio: input });
    upstream.message({ type: "audio_output_clear" });
    upstream.message({ type: "turn_ended", text: "Hello" });
    assert.deepEqual(client.sent.map((raw) => JSON.parse(raw).type), ["session_ready", "audio_output", "audio_output_clear", "turn_ended"]);
    session.close();
  });

  it("executes only registered client tools and returns bounded documented results without forwarding calls", async () => {
    let invocation;
    const { client, upstream, session } = makeSession({ toolHandlers: {
      lookup_order: async (params, context) => {
        invocation = { params, context };
        return { status: "shipped" };
      },
    } });
    upstream.emit("open");
    upstream.message({ type: "session_ready", call_id: "ac_call_2" });
    upstream.message({ type: "client_tool_call", tool_call_id: "tool_call_1", tool_name: "lookup_order", parameters: { order_id: "o_1" }, expects_response: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(invocation.params, { order_id: "o_1" });
    assert.deepEqual(invocation.context, { actor: { id: "operator_1" }, agentId: "agent_1", callId: "ac_call_2", toolCallId: "tool_call_1" });
    assert.equal(JSON.parse(client.sent[0]).type, "session_ready");
    assert.deepEqual(event(upstream, "client_tool_result"), {
      type: "client_tool_result", tool_call_id: "tool_call_1", result: JSON.stringify({ status: "shipped" }), is_error: false,
    });
    session.close();
  });

  it("returns a generic tool error for unregistered tools and never leaks handler secrets", async () => {
    const { upstream, session } = makeSession();
    upstream.emit("open");
    upstream.message({ type: "session_ready", call_id: "ac_call_3" });
    upstream.message({ type: "client_tool_call", tool_call_id: "tool_call_2", tool_name: "delete_account", parameters: {}, expects_response: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(event(upstream, "client_tool_result"), {
      type: "client_tool_result", tool_call_id: "tool_call_2", result: "The requested action could not be completed.", is_error: true,
    });
    session.close();
  });

  it("rejects malformed client events and oversized payloads with sanitized protocol errors", () => {
    const { client, upstream } = makeSession();
    upstream.emit("open");
    client.emit("message", Buffer.from(JSON.stringify({ type: "client_tool_result", tool_call_id: "x" })));
    assert.equal(event(client, "error").code, "cartesia_agent_input_invalid");
    assert.doesNotMatch(JSON.stringify(client.sent), /secret-test-key/);

    const next = makeSession();
    next.client.emit("message", Buffer.alloc(__testables.MAX_MESSAGE_BYTES + 1));
    assert.equal(event(next.client, "error").code, "cartesia_agent_message_too_large");
  });

  it("does not expose credentials in upstream failure events and cleans up both sockets", () => {
    const { client, upstream, session } = makeSession();
    upstream.emit("error", new Error("secret-test-key leaked"));
    assert.equal(event(client, "error").code, "cartesia_agent_upstream_unavailable");
    assert.equal(client.closeArgs[0], 1011);
    assert.equal(upstream.closeArgs[0], 1011);
    session.close();
  });

  it("sanitizes Cartesia error event details before forwarding them", () => {
    const { client, upstream, session } = makeSession();
    upstream.message({ type: "error", message: "secret-test-key in provider detail", fatal: false });
    assert.deepEqual(event(client, "error"), {
      type: "error", code: "cartesia_agent_provider_error", message: "Cartesia could not process the agent session.", fatal: false,
    });
    assert.doesNotMatch(JSON.stringify(client.sent), /secret-test-key/);
    session.close();
  });

  it("requires an authenticated actor and valid resolved agent before connecting", () => {
    FakeSocket.instances = [];
    const runtime = new CartesiaAgentRuntime({ WebSocket: FakeSocket, apiKey: "key" });
    const client = new FakeSocket("client");
    FakeSocket.instances = [];
    assert.throws(() => runtime.handle({ clientSocket: client, agentId: "agent_1" }), { code: "cartesia_agent_actor_required" });
    assert.equal(FakeSocket.instances.length, 0);
  });

  it("supports caller-resolved agent identity with the public connect API", () => {
    const runtime = createCartesiaAgentRuntime({ WebSocket: FakeSocket, apiKey: "key", tools: {} });
    const client = new FakeSocket("client");
    FakeSocket.instances = [];
    const session = runtime.connect({ clientSocket: client, actor: { id: "operator_2" }, agentId: "agent_resolved" });
    assert.match(FakeSocket.instances[0].url, /\/agent_resolved\?/);
    session.close();
  });
});
