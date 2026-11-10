"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const {
  CartesiaLineAgentSession,
  DEFAULT_CARTESIA_API_VERSION,
} = require("../services/cartesiaLineAgentSession");

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }

  receive(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}
FakeWebSocket.instances = [];

describe("Cartesia hosted Line agent session", () => {
  beforeEach(() => { FakeWebSocket.instances = []; });

  it("uses the versioned server WebSocket contract and waits for session_ready", async () => {
    const session = new CartesiaLineAgentSession({
      apiKey: "server-only-test-key",
      agentId: "agent_test-123",
      WebSocketImpl: FakeWebSocket,
    });
    session.on("error", () => {});
    const readyPromise = session.connect();
    const socket = FakeWebSocket.instances[0];

    assert.equal(socket.url, `wss://api.cartesia.ai/v1/agents/websocket/agent_test-123?cartesia_version=${DEFAULT_CARTESIA_API_VERSION}`);
    assert.deepEqual(socket.options.headers, { "X-API-Key": "server-only-test-key" });
    assert.equal(socket.url.includes("server-only-test-key"), false);
    socket.open();
    assert.deepEqual(socket.sent[0], {
      type: "session_create",
      audio: {
        input_format: "mulaw_8000",
        output_delivery: "speaking_pace",
        continuous_input: true,
      },
    });
    socket.receive({
      type: "session_ready",
      call_id: "ac_test",
      agent_id: "agent_test-123",
      agent_version_id: "av_test",
      audio: { input_format: "mulaw_8000", output_delivery: "speaking_pace" },
    });

    assert.deepEqual(await readyPromise, {
      callId: "ac_test",
      agentId: "agent_test-123",
      agentVersionId: "av_test",
    });
    session.close();
  });

  it("sends and receives bounded base64 audio, barge-in, and turn events", async () => {
    const session = new CartesiaLineAgentSession({ apiKey: "key", agentId: "agent", WebSocketImpl: FakeWebSocket });
    session.on("error", () => {});
    const readyPromise = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "session_ready", call_id: "ac_test", agent_id: "agent" });
    await readyPromise;

    assert.equal(session.sendAudio(Buffer.from([1, 2, 3])), true);
    assert.deepEqual(socket.sent.at(-1), { type: "audio_input", audio: "AQID" });
    assert.equal(session.sendAudioBase64("not-base64"), false);
    assert.equal(session.sendAudio(Buffer.alloc(128 * 1024 + 1)), false);

    const audioEvents = [];
    const textEvents = [];
    let clears = 0;
    session.on("audio", (event) => audioEvents.push(event));
    session.on("conversationText", (event) => textEvents.push(event));
    session.on("clear", () => { clears += 1; });
    socket.receive({ type: "audio_output", audio: "AQID" });
    socket.receive({ type: "audio_output_clear" });
    socket.receive({ type: "turn_ended", role: "assistant", turn: 2, text: "Hello." });
    assert.equal(audioEvents[0].bytes.toString("hex"), "010203");
    assert.equal(clears, 1);
    assert.deepEqual(textEvents[0], { role: "assistant", content: "Hello.", turn: 2 });
    session.close();
  });

  it("allows only matching one-time client tool results and bounds their size", async () => {
    const session = new CartesiaLineAgentSession({ apiKey: "key", agentId: "agent", WebSocketImpl: FakeWebSocket });
    session.on("error", () => {});
    const readyPromise = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "session_ready", call_id: "ac_test", agent_id: "agent" });
    await readyPromise;

    let toolRequest;
    session.on("functionCallRequest", (payload) => { toolRequest = payload; });
    socket.receive({
      type: "client_tool_call",
      tool_call_id: "tool_1",
      tool_name: "lookup_order",
      parameters: { order_id: "123" },
      expects_response: true,
    });
    assert.deepEqual(toolRequest, {
      id: "tool_1",
      name: "lookup_order",
      arguments: { order_id: "123" },
      expectsResponse: true,
    });
    assert.equal(session.respondFunctionCall({ id: "wrong", content: "no" }), false);
    assert.equal(session.respondFunctionCall({ id: "tool_1", content: "found" }), true);
    assert.deepEqual(socket.sent.at(-1), {
      type: "client_tool_result",
      tool_call_id: "tool_1",
      result: "found",
      is_error: false,
    });
    assert.equal(session.respondFunctionCall({ id: "tool_1", content: "duplicate" }), false);

    socket.receive({
      type: "client_tool_call",
      tool_call_id: "tool_2",
      tool_name: "lookup_order",
      parameters: {},
      expects_response: true,
    });
    assert.equal(session.respondFunctionCall({ id: "tool_2", content: "x".repeat(16 * 1024 + 1) }), true);
    assert.equal(socket.sent.at(-1).result, "tool_result_too_large");
    assert.equal(socket.sent.at(-1).is_error, true);
    session.close();
  });

  it("sanitizes provider error messages and exposes supported DTMF controls", async () => {
    const session = new CartesiaLineAgentSession({ apiKey: "key", agentId: "agent", WebSocketImpl: FakeWebSocket });
    const errors = [];
    session.on("error", (error) => errors.push(error));
    const readyPromise = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "session_ready", call_id: "ac_test", agent_id: "agent" });
    await readyPromise;

    assert.equal(session.sendDtmf("5"), true);
    assert.deepEqual(socket.sent.at(-1), { type: "dtmf_input", digit: "5" });
    assert.equal(session.sendDtmf("bad"), false);
    socket.receive({ type: "error", code: "bad-event", message: "contains a private value", fatal: false });
    assert.equal(errors.at(-1).message, "bad-event");
    assert.equal(errors.at(-1).retryable, true);
    assert.doesNotMatch(errors.at(-1).message, /private value/);
    session.close();
  });

  it("rejects invalid configuration before opening a connection", () => {
    assert.throws(() => new CartesiaLineAgentSession({ apiKey: "key", agentId: "agent", inputFormat: "mulaw_16000" }), /input_format_unsupported/);
    assert.throws(() => new CartesiaLineAgentSession({ apiKey: "key", agentId: "agent", apiVersion: "latest" }), /api_version_invalid/);
    assert.equal(FakeWebSocket.instances.length, 0);
  });
});
