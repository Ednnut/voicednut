const assert = require('node:assert/strict');
const { StreamService } = require('../routes/stream');

function harness(options) {
  const sent = [];
  const ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) };
  const stream = new StreamService(ws, { audioTickIntervalMs: 100000, ...options });
  stream.setStreamSid('stream-test');
  return { stream, sent };
}

describe('StreamService chunk ordering', () => {
  it('sends chunks in order and advances only when a response is complete', () => {
    const { stream, sent } = harness();
    stream.bufferChunk(0, 'a');
    stream.bufferChunk(1, 'c', true);
    stream.bufferChunk(0, 'b', true);
    assert.deepEqual(sent.filter((event) => event.event === 'media').map((event) => event.media.payload), ['a', 'b', 'c']);
    assert.equal(stream.expectedAudioIndex, 2);
    stream.close();
  });

  it('drops highest out-of-order responses when its bounded buffer fills', () => {
    const { stream, sent } = harness({ maxBufferedChunks: 1 });
    stream.bufferChunk(2, 'drop', true);
    stream.bufferChunk(1, 'keep', true);
    stream.bufferChunk(0, 'first', true);
    assert.deepEqual(sent.filter((event) => event.event === 'media').map((event) => event.media.payload), ['first', 'keep']);
    stream.close();
  });

  it('flush discards pending response chunks and resets sequencing', () => {
    const { stream, sent } = harness();
    stream.bufferChunk(1, 'stale', true);
    stream.flush();
    stream.bufferChunk(0, 'fresh', true);
    assert.deepEqual(sent.filter((event) => event.event === 'media').map((event) => event.media.payload), ['fresh']);
    stream.close();
  });

  it('preserves the active monotonic index across a barge-in flush', () => {
    const { stream, sent } = harness();
    stream.bufferChunk(0, 'played', true);
    stream.bufferChunk(1, 'interrupted');
    stream.flush();
    stream.bufferChunk(1, 'after-clear', true);
    assert.deepEqual(sent.filter((event) => event.event === 'media').map((event) => event.media.payload), ['played', 'interrupted', 'after-clear']);
    stream.close();
  });
});
