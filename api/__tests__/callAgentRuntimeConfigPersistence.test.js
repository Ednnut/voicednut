const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('call agent runtime configuration persistence', () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-agent-config-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) { /* temp DB cleanup */ }
    });
  });

  it('round trips agent configuration through create, list, update, and read', async () => {
    const config = {
      schema_version: 1,
      approved_tools: ['lookupInformation'],
      tool_timeout_ms: 8000,
    };
    const id = await db.createCallTemplate({
      name: 'Persisted agent',
      prompt: 'You provide appointment information.',
      first_message: 'Hello, I can help with an appointment.',
      agent_config: config,
    });
    assert.deepEqual(JSON.parse((await db.getCallTemplateById(id)).agent_config_json), config);
    assert.deepEqual(JSON.parse((await db.getCallTemplates())[0].agent_config_json), config);

    const updated = { ...config, approved_tools: [], tool_timeout_ms: 12000 };
    assert.equal(await db.updateCallTemplate(id, { agent_config: updated }), 1);
    assert.deepEqual(JSON.parse((await db.getCallTemplateById(id)).agent_config_json), updated);
  });

  it('round trips schema-v5 handoff policy and creates only one durable handoff session per call', async () => {
    const config = {
      schema_version: 5,
      approved_tools: ['route_to_agent'],
      handoff_policy: {
        enabled: true,
        destination_e164: '+15555550123',
        confirmation: 'dtmf_1',
      },
    };
    const templateId = await db.createCallTemplate({
      name: 'Handoff policy test',
      prompt: 'Help the caller and offer a live representative when asked.',
      first_message: 'Hello.',
      agent_config: config,
    });
    assert.deepEqual(
      JSON.parse((await db.getCallTemplateById(templateId)).agent_config_json),
      config,
    );

    await new Promise((resolve, reject) => {
      db.db.run(
        'INSERT INTO calls (call_sid, phone_number) VALUES (?, ?)',
        ['CA_HANDOFF_TEST', '+15005550006'],
        (error) => error ? reject(error) : resolve(),
      );
    });
    assert.equal(await db.createCallHandoffSession('CA_HANDOFF_TEST', '+15555550123', Date.now() + 30000), true);
    assert.equal(await db.createCallHandoffSession('CA_HANDOFF_TEST', '+15555550124', Date.now() + 30000), false);
    assert.equal((await db.getCallHandoffSession('CA_HANDOFF_TEST')).state, 'awaiting_confirmation');
    const claims = await Promise.all([
      db.transitionCallHandoffSession(
        'CA_HANDOFF_TEST', 'awaiting_confirmation', 'dispatching',
        { require_unexpired: true, now: Date.now() },
      ),
      db.transitionCallHandoffSession(
        'CA_HANDOFF_TEST', 'awaiting_confirmation', 'dispatching',
        { require_unexpired: true, now: Date.now() },
      ),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal((await db.getCallHandoffSession('CA_HANDOFF_TEST')).destination_e164, '');
  });

  it('round trips schema-v6 Deepgram settings without a database migration', async () => {
    const config = {
      schema_version: 6,
      approved_tools: ['lookupInformation'],
      voice_agent_settings: {
        language: 'es',
        listen_model: 'flux-general-multi',
        think_provider: 'google',
        think_model: 'gemini-2.5-flash',
      },
    };
    const templateId = await db.createCallTemplate({
      name: 'Spanish Deepgram agent',
      prompt: 'Help the caller with an appointment.',
      first_message: 'Hola.',
      voice_model: 'aura-2-celeste-es',
      agent_config: config,
    });
    const stored = await db.getCallTemplateById(templateId);
    assert.deepEqual(JSON.parse(stored.agent_config_json), config);
    assert.equal(stored.voice_model, 'aura-2-celeste-es');
  });

  it('reapplies the additive config column migration to an older template schema', async () => {
    await new Promise((resolve, reject) => {
      db.db.run('ALTER TABLE call_templates DROP COLUMN agent_config_json', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await db.ensureTemplateColumns(['agent_config_json']);
    const columns = await new Promise((resolve, reject) => {
      db.db.all('PRAGMA table_info(call_templates)', (error, rows) => {
        if (error) reject(error);
        else resolve(rows || []);
      });
    });
    assert.ok(columns.some((column) => column.name === 'agent_config_json'));
  });
});
