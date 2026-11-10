const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerCartesiaSpeechRoutes } = require('../services/cartesiaSpeechRoutes');

describe('Cartesia speech routes', () => {
  function createApp() {
    const app = express();
    const operations = [];
    const requireAdmin = (req, res, next) => {
      if (req.get('x-admin') !== 'authorized') return res.status(403).json({ success: false });
      return next();
    };
    registerCartesiaSpeechRoutes(app, {
      requireAdminToken: requireAdmin,
      service: {
        async listVoices(query) {
          operations.push(['voices', query]);
          return { data: [{ id: 'voice_1', name: 'Example' }], hasMore: false, nextPage: null };
        },
        async transcribeAudio(input) {
          operations.push(['transcribe', input]);
          return { text: 'fake transcript', requestId: 'test_req', language: 'en', duration: 1 };
        },
      },
    });
    return { app, operations };
  }

  it('requires admin authorization before listing provider voice data', async () => {
    const { app, operations } = createApp();
    const denied = await request(app).get('/admin/cartesia/speech/voices');
    assert.equal(denied.status, 403);
    assert.equal(operations.length, 0);
    const allowed = await request(app).get('/admin/cartesia/speech/voices?limit=5').set('x-admin', 'authorized');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data[0].id, 'voice_1');
    assert.equal(operations[0][1].limit, '5');
  });

  it('accepts only bounded raw audio uploads after authorization and returns normalized transcription', async () => {
    const { app, operations } = createApp();
    const denied = await request(app)
      .post('/admin/cartesia/speech/transcriptions')
      .set('content-type', 'audio/wav')
      .send(Buffer.from('fake audio'));
    assert.equal(denied.status, 403);
    assert.equal(operations.length, 0);

    const allowed = await request(app)
      .post('/admin/cartesia/speech/transcriptions?language=en&word_timestamps=true')
      .set('x-admin', 'authorized')
      .set('content-type', 'audio/wav')
      .send(Buffer.from('fake audio'));
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body.transcript, { text: 'fake transcript', requestId: 'test_req', language: 'en', duration: 1 });
    assert.equal(operations[0][1].mimeType, 'audio/wav');
    assert.equal(operations[0][1].wordTimestamps, true);
  });

  it('rejects malformed timestamp flags and provider failures without forwarding details', async () => {
    const app = express();
    registerCartesiaSpeechRoutes(app, {
      requireAdminToken: (_req, _res, next) => next(),
      service: {
        async listVoices() { throw Object.assign(new Error('secret provider payload'), { statusCode: 502 }); },
        async transcribeAudio() { throw Object.assign(new Error('provider detail'), { statusCode: 502 }); },
      },
    });
    const malformed = await request(app)
      .post('/admin/cartesia/speech/transcriptions?word_timestamps=yes')
      .set('content-type', 'audio/wav')
      .send(Buffer.from('audio'));
    assert.equal(malformed.status, 400);
    const failed = await request(app).get('/admin/cartesia/speech/voices');
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.includes('secret provider payload'), false);
  });

  it('rejects unsupported content types before the speech service receives the upload', async () => {
    const app = express();
    let called = false;
    registerCartesiaSpeechRoutes(app, {
      requireAdminToken: (_req, _res, next) => next(),
      service: {
        async listVoices() { return { data: [], hasMore: false, nextPage: null }; },
        async transcribeAudio() { called = true; return {}; },
      },
    });
    const response = await request(app)
      .post('/admin/cartesia/speech/transcriptions')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('audio'));
    assert.equal(response.status, 415);
    assert.equal(called, false);
  });
});
