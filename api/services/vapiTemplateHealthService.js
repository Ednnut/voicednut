'use strict';

const { mapCallTemplateToVapiAssistant } = require('../adapters/vapiTemplateAdapter');
const { MAPPING_METADATA_KEY, buildAssistantSyncPayload } = require('./vapiTemplateSyncService');

const MAX_HEALTH_MAPPINGS = 20;
const MAX_REMOTE_HEALTH_CHECKS = 5;

function healthError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeVersion(value) {
  const version = String(value || '').trim();
  return version && version.length <= 40 ? version : null;
}

function isSameMapping(assistant, mapping) {
  const marker = assistant?.metadata?.[MAPPING_METADATA_KEY];
  return Boolean(marker &&
    Number(marker.templateId) === Number(mapping.template_id) &&
    Number(marker.templateVersion) === Number(mapping.template_version) &&
    String(marker.configFingerprint || '').toLowerCase() === String(mapping.config_fingerprint || '').toLowerCase());
}

function remoteUpdatedAfterSync(remoteUpdatedAt, lastSyncedAt) {
  const parseTimestamp = (value) => {
    const timestamp = String(value || '').trim();
    if (!timestamp) return Number.NaN;
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
      ? `${timestamp.replace(' ', 'T').replace(/(\.\d{1,3})\d+$/, '$1')}Z`
      : timestamp;
    return Date.parse(normalized);
  };
  const remoteTime = parseTimestamp(remoteUpdatedAt);
  const syncedTime = parseTimestamp(lastSyncedAt);
  return Number.isFinite(remoteTime) && Number.isFinite(syncedTime) && remoteTime > syncedTime + 1000;
}

function readHealthRow(mapping, template, remoteStatus, remoteAssistant = null, remoteError = null) {
  const current = Number(mapping.template_version) === Number(template.version || 1);
  const flags = [];
  if (!current) flags.push('template_version_outdated');
  if (mapping.compatibility_status !== 'compatible') flags.push('template_incompatible');
  if (mapping.mapping_status !== 'provisioned') flags.push('assistant_not_provisioned');
  if (mapping.sync_status !== 'synced') flags.push(`sync_${String(mapping.sync_status || 'unknown')}`);
  const ownershipMatches = remoteAssistant ? isSameMapping(remoteAssistant, mapping) : false;
  if (remoteAssistant && !ownershipMatches) flags.push('assistant_mapping_metadata_mismatch');
  if (remoteAssistant && String(remoteAssistant.latestVersion || '') !== String(mapping.vapi_assistant_version || '')) {
    flags.push('published_version_changed');
  }
  const updatedAfterSync = remoteAssistant
    ? remoteUpdatedAfterSync(remoteAssistant.updatedAt, mapping.last_synced_at)
    : false;
  if (updatedAfterSync) flags.push('remote_updated_after_sync');
  if (remoteStatus === 'missing') flags.push('assistant_missing');
  if (remoteStatus === 'unavailable') flags.push('remote_check_unavailable');
  const canResync = Boolean(
    current && String(template.lifecycle_state || '').toLowerCase() === 'live' &&
    mapping.compatibility_status === 'compatible' && mapping.mapping_status === 'provisioned' &&
    ['synced', 'failed', 'unknown'].includes(String(mapping.sync_status || '')) &&
    remoteStatus === 'available' && ownershipMatches,
  );
  return {
    mapping_id: Number(mapping.id),
    template_version: Number(mapping.template_version),
    current_template: current,
    config_fingerprint: String(mapping.config_fingerprint || '').slice(0, 16),
    compatibility_status: String(mapping.compatibility_status || 'unknown'),
    mapping_status: String(mapping.mapping_status || 'unknown'),
    sync_status: String(mapping.sync_status || 'unknown'),
    assistant_id: String(mapping.vapi_assistant_id || '').slice(0, 200) || null,
    synced_assistant_version: safeVersion(mapping.vapi_assistant_version),
    last_synced_at: mapping.last_synced_at || null,
    remote_status: remoteStatus,
    remote_assistant_version: safeVersion(remoteAssistant?.latestVersion),
    remote_updated_at: remoteAssistant?.updatedAt || null,
    remote_error_code: remoteError,
    drift_flags: flags,
    resync_available: canResync,
  };
}

class VapiTemplateHealthService {
  constructor(options = {}) {
    this.db = options.db;
    this.client = options.client;
    this.serverConfiguration = options.serverConfiguration || null;
  }

  async getTemplate(templateId) {
    const id = Number(templateId);
    if (!Number.isSafeInteger(id) || id <= 0) throw healthError('vapi_template_id_invalid', 'A valid template ID is required');
    if (typeof this.db?.getCallTemplateById !== 'function') throw healthError('vapi_health_unavailable', 'Vapi mapping storage is unavailable', 503);
    const template = await this.db.getCallTemplateById(id);
    if (!template) throw healthError('vapi_template_not_found', 'Call template was not found', 404);
    return template;
  }

  async getHealth(templateId) {
    const template = await this.getTemplate(templateId);
    const records = typeof this.db?.listVapiTemplateMappings === 'function'
      ? await this.db.listVapiTemplateMappings(Number(template.id))
      : [];
    const mappings = (Array.isArray(records) ? records : []).slice(0, MAX_HEALTH_MAPPINGS);
    const clientReady = Boolean(this.client && this.client.isConfigured());
    const currentMappings = mappings.filter((mapping) =>
      Number(mapping.template_version) === Number(template.version || 1) && String(mapping.vapi_assistant_id || '').trim());
    const remoteRows = new Map();
    if (clientReady) {
      await Promise.all(currentMappings.slice(0, MAX_REMOTE_HEALTH_CHECKS).map(async (mapping) => {
        try {
          const assistant = await this.client.getAssistant(mapping.vapi_assistant_id);
          remoteRows.set(Number(mapping.id), assistant?.id === mapping.vapi_assistant_id
            ? { status: 'available', assistant }
            : { status: 'unavailable', error: 'vapi_assistant_id_mismatch' });
        } catch (error) {
          remoteRows.set(Number(mapping.id), {
            status: Number(error?.status) === 404 ? 'missing' : 'unavailable',
            error: Number(error?.status) === 404 ? 'vapi_assistant_not_found' : String(error?.code || 'vapi_remote_check_failed').slice(0, 80),
          });
        }
      }));
    }
    const checks = mappings.map((mapping) => {
      const current = Number(mapping.template_version) === Number(template.version || 1);
      const remote = remoteRows.get(Number(mapping.id));
      const status = remote?.status || (!clientReady && current && mapping.vapi_assistant_id ? 'unavailable' : 'not_checked');
      return readHealthRow(mapping, template, status, remote?.assistant || null,
        remote?.error || (status === 'unavailable' && !clientReady ? 'vapi_not_configured' : null));
    });
    return {
      template_id: Number(template.id),
      template_version: Number(template.version) || 1,
      lifecycle_state: String(template.lifecycle_state || 'draft'),
      remote_check_configured: clientReady,
      mappings: checks,
      truncated: Array.isArray(records) && records.length > mappings.length,
      remote_checks_limited: currentMappings.length > MAX_REMOTE_HEALTH_CHECKS,
    };
  }

  async resync(templateId, mappingId) {
    const template = await this.getTemplate(templateId);
    if (!this.client || !this.client.isConfigured()) throw healthError('vapi_not_configured', 'Vapi synchronization is not configured', 503);
    if (String(template.lifecycle_state || '').toLowerCase() !== 'live') {
      throw healthError('vapi_template_not_live', 'Only a live template can be resynchronized', 409);
    }
    if (typeof this.db?.getVapiTemplateMappingById !== 'function') throw healthError('vapi_mapping_unavailable', 'Vapi mapping storage is unavailable', 503);
    const mapping = await this.db.getVapiTemplateMappingById(mappingId);
    if (!mapping || Number(mapping.template_id) !== Number(template.id)) throw healthError('vapi_mapping_not_found', 'Vapi mapping was not found for this template', 404);
    if (Number(mapping.template_version) !== Number(template.version || 1) ||
        mapping.compatibility_status !== 'compatible' || mapping.mapping_status !== 'provisioned' ||
        !['synced', 'failed', 'unknown'].includes(String(mapping.sync_status || ''))) {
      throw healthError('vapi_mapping_not_resyncable', 'This mapping is not eligible for resynchronization', 409);
    }
    const templateIdNumber = Number(template.id);
    const templateVersion = Number(template.version) || 1;
    const fingerprint = String(mapping.config_fingerprint || '').toLowerCase();
    const assistantId = String(mapping.vapi_assistant_id || '').trim();
    if (!assistantId || !/^[a-f0-9]{64}$/.test(fingerprint)) throw healthError('vapi_mapping_invalid', 'The Vapi mapping is incomplete', 409);

    const assistant = await this.client.getAssistant(assistantId);
    if (String(assistant?.id || '') !== assistantId || !isSameMapping(assistant, mapping)) {
      throw healthError('vapi_assistant_mapping_mismatch', 'The mapped Vapi assistant ownership could not be verified', 409);
    }
    const remoteModel = assistant.model && typeof assistant.model === 'object' ? assistant.model : {};
    const remoteVoice = assistant.voice && typeof assistant.voice === 'object' ? assistant.voice : {};
    const model = {
      provider: String(remoteModel.provider || '').trim(),
      model: String(remoteModel.model || '').trim(),
      ...(Array.isArray(remoteModel.messages) ? { messages: remoteModel.messages } : {}),
    };
    const voice = {
      provider: String(remoteVoice.provider || '').trim(),
      voiceId: String(remoteVoice.voiceId || '').trim(),
    };
    const preview = mapCallTemplateToVapiAssistant({
      ...template,
      configuration: { vapi: { model, voice } },
    }, { serverConfiguration: this.serverConfiguration });
    if (!preview.compatible) throw healthError('vapi_template_incompatible', 'The current template cannot be mapped safely to the Vapi assistant', 409);

    const expected = { templateId: templateIdNumber, templateVersion, configFingerprint: fingerprint };
    const claimed = await this.db.claimVapiTemplateSync(templateIdNumber, templateVersion, fingerprint);
    if (!claimed) throw healthError('vapi_sync_in_progress', 'A sync is already in progress for this mapping', 409);
    let mutationSent = false;
    try {
      mutationSent = true;
      const updated = await this.client.updateAssistant(assistantId,
        buildAssistantSyncPayload(template, preview, expected, assistant, this.serverConfiguration));
      const resultingVersion = safeVersion(updated?.latestVersion) || safeVersion(assistant.latestVersion);
      const persisted = await this.db.completeVapiTemplateSync({
        template_id: templateIdNumber,
        template_version: templateVersion,
        config_fingerprint: fingerprint,
        vapi_assistant_id: assistantId,
        vapi_assistant_version: resultingVersion,
      });
      if (!persisted) throw healthError('vapi_sync_persistence_failed', 'Vapi resync completed but local status could not be finalized', 500);
      return { mapping_id: Number(mapping.id), assistant_id: assistantId, assistant_version: resultingVersion, sync_status: 'synced' };
    } catch (error) {
      await this.db.failVapiTemplateSync({
        template_id: templateIdNumber,
        template_version: templateVersion,
        config_fingerprint: fingerprint,
        sync_status: mutationSent && (!Number.isFinite(error?.status) || error.status >= 500) ? 'unknown' : 'failed',
        error_code: error?.code || 'vapi_resync_failed',
      });
      throw error;
    }
  }
}

module.exports = { VapiTemplateHealthService, isSameMapping, readHealthRow, remoteUpdatedAfterSync };
