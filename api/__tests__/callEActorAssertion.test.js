'use strict';

const assert = require('node:assert/strict');
const { verifyCallEActorAssertion } = require('../services/callEActorAssertion');
const { createCallEActorAssertionHeaders } = require('../../bot/utils/callEActorAssertion');

function requestFixture({ actorId = '7001', claimedActorId = actorId, path = '/api/call-e/missions?business_id=biz&actor_id=7001', body, method = 'GET', timestamp = String(Date.now()), secret = 'actor-assertion-test-secret-'.padEnd(40, 'x') } = {}) {
  const requestBody = method === 'GET' ? undefined : body || { actor_id: claimedActorId, business_id: 'biz' };
  const url = `https://api.example${path.split('?')[0]}`;
  const params = Object.fromEntries(new URLSearchParams(path.split('?')[1] || ''));
  const assertionHeaders = createCallEActorAssertionHeaders({
    actorId,
    method,
    url,
    params,
    body: requestBody,
    secret,
    timestamp: Number(timestamp),
  });
  return {
    secret,
    req: {
      method,
      originalUrl: path,
      url: path,
      headers: {
        ...assertionHeaders,
        ...(method === 'GET' ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(requestBody))) }),
      },
      query: method === 'GET' ? { actor_id: claimedActorId } : {},
      body: requestBody,
    },
  };
}

describe('CALL-E actor assertion', () => {
  it('accepts a fresh actor claim bound to the request path and body', () => {
    const fixture = requestFixture({ method: 'POST', path: '/api/call-e/missions/mission_1/review', body: { actor_id: '7001', decision: 'approve' } });
    assert.deepEqual(verifyCallEActorAssertion(fixture.req, { secret: fixture.secret }), { ok: true, actorId: '7001' });
  });

  it('accepts the verified Telegram identity field on the shared outbound call route', () => {
    const fixture = requestFixture({
      method: 'POST',
      path: '/outbound-call',
      body: { user_chat_id: '7001', number: '+14155550123' },
    });
    assert.deepEqual(verifyCallEActorAssertion(fixture.req, { secret: fixture.secret }), { ok: true, actorId: '7001' });
  });

  it('binds raw audio uploads to the signed actor, query scope, and exact bytes', () => {
    const secret = 'actor-assertion-test-secret-'.padEnd(40, 'x');
    const body = Buffer.from('mock audio bytes');
    const url = 'https://api.example/api/cartesia/studio/voices/clone?actor_id=7001&name=Support&language=en';
    const headers = createCallEActorAssertionHeaders({ actorId: '7001', method: 'POST', url, body, secret });
    const req = {
      method: 'POST', originalUrl: '/api/cartesia/studio/voices/clone?actor_id=7001&name=Support&language=en',
      headers: { ...headers, 'content-length': String(body.length) },
      query: { actor_id: '7001', name: 'Support', language: 'en' }, body,
    };
    assert.deepEqual(verifyCallEActorAssertion(req, { secret }), { ok: true, actorId: '7001' });
    req.body = Buffer.from('different audio bytes');
    assert.equal(verifyCallEActorAssertion(req, { secret }).code, 'call_e_actor_assertion_invalid');
  });

  it('rejects an actor claim that differs from the request actor', () => {
    const fixture = requestFixture({ claimedActorId: '7002' });
    assert.equal(verifyCallEActorAssertion(fixture.req, { secret: fixture.secret }).code, 'call_e_actor_assertion_invalid');
  });

  it('rejects signatures replayed against a changed request path or body', () => {
    const fixture = requestFixture({ method: 'POST', body: { actor_id: '7001', decision: 'approve' } });
    fixture.req.originalUrl = '/api/call-e/missions/mission_2/review';
    assert.equal(verifyCallEActorAssertion(fixture.req, { secret: fixture.secret }).code, 'call_e_actor_assertion_invalid');

    const bodyFixture = requestFixture({ method: 'POST', body: { actor_id: '7001', decision: 'approve' } });
    bodyFixture.req.body.decision = 'reject';
    assert.equal(verifyCallEActorAssertion(bodyFixture.req, { secret: bodyFixture.secret }).code, 'call_e_actor_assertion_invalid');
  });

  it('rejects expired claims and missing server secrets', () => {
    const old = requestFixture({ timestamp: String(Date.now() - 400000) });
    assert.equal(verifyCallEActorAssertion(old.req, { secret: old.secret }).code, 'call_e_actor_assertion_expired');
    assert.equal(verifyCallEActorAssertion(old.req, { secret: '' }).status, 503);
  });
});
