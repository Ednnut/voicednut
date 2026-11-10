const crypto = require('node:crypto');

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function respondWithError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(String(error?.code || ''))
    ? error.code
    : 'cartesia_operation_failed';
  return res.status(status).json({ success: false, code, error: error?.message || 'Cartesia operation failed' });
}

function rejectUnknownFields(body, allowed) {
  return Object.keys(body).some((key) => !allowed.has(key));
}

function cartesiaBatchCsvCell(value, maxLength = 200) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, maxLength);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function cartesiaBatchResultsCsv(batch) {
  const columns = [
    ['recipient_id', 'id', 200],
    ['destination_phone', 'toNumber', 32],
    ['status', 'status', 64],
    ['provider_call_id', 'agentCallId', 200],
    ['end_reason', 'endReason', 128],
    ['has_provider_error', 'hasProviderError', 5],
    ['local_state', 'localState', 32],
    ['created_at', 'createdAt', 40],
  ];
  const lines = [columns.map(([header]) => cartesiaBatchCsvCell(header, 64)).join(',')];
  for (const recipient of batch.recipients) {
    lines.push(columns.map(([, field, maxLength]) => {
      const value = field === 'hasProviderError'
        ? recipient[field] === true ? 'true' : 'false'
        : recipient[field];
      return cartesiaBatchCsvCell(value, maxLength);
    }).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function isAuditReadyPhoneMutation(body = {}) {
  return body.approved === true &&
    /^[a-f0-9]{64}$/.test(String(body.confirmed_fingerprint || '').toLowerCase()) &&
    /^[A-Za-z0-9._:-]{8,100}$/.test(String(body.idempotency_key || ''));
}

function phoneMutationAuditOutcome(error) {
  return /outcome_unknown|persistence_failed|unconfirmed/.test(String(error?.code || '')) ? 'outcome_unknown' : 'failed';
}

function isAuditReadyProviderMutation(body = {}) {
  return body.approved === true &&
    /^[a-f0-9]{64}$/.test(String(body.confirmed_fingerprint || '').toLowerCase()) &&
    /^[A-Za-z0-9._:-]{8,100}$/.test(String(body.idempotency_key || ''));
}

async function runAuditedProviderOperation(options, res, config) {
  const body = config.body || {};
  const fingerprint = String(body.confirmed_fingerprint || '').toLowerCase();
  if (!isAuditReadyProviderMutation(body)) {
    try {
      return config.send(await config.execute());
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  const auditMethod = config.auditMethod || 'recordCartesiaProviderOperationAudit';
  const writeAudit = config.writeAudit || ((event) => options.db[auditMethod]({
    actor_type: 'admin_api',
    actor_id: 'shared_admin_token',
    action: config.action,
    resource_id: event.resourceId || config.resourceId || `pending:${fingerprint.slice(0, 40)}`,
    outcome: event.outcome,
    request_fingerprint: fingerprint,
    reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(event.reasonCode || '')) ? event.reasonCode : null,
  }));

  if (typeof options.db?.[auditMethod] !== 'function') {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia provider operation is unavailable' });
  }
  try {
    await writeAudit({ outcome: 'requested' });
  } catch {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia provider operation is unavailable' });
  }

  let result;
  try {
    result = await config.execute();
  } catch (error) {
    await writeAudit({ outcome: phoneMutationAuditOutcome(error), reasonCode: error?.code }).catch(() => {});
    return respondWithError(res, error);
  }

  try {
    await writeAudit({ outcome: 'succeeded', resourceId: config.getResourceId?.(result) || config.resourceId });
  } catch {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia applied the provider operation but its audit result could not be saved; refresh provider inventory before retrying' });
  }
  return config.send(result);
}

function isAuditReadyCallDispatch(body = {}) {
  return body.approved === true &&
    /^[a-f0-9]{64}$/.test(String(body.confirmed_fingerprint || '').toLowerCase()) &&
    /^[A-Za-z0-9._:-]{8,100}$/.test(String(body.idempotency_key || ''));
}

async function runAuditedCallOperation(options, res, config) {
  const auditReady = config.shouldAudit === true;
  if (!auditReady) {
    try {
      return config.send(await config.execute());
    } catch (error) {
      return respondWithError(res, error);
    }
  }

  const writeAudit = (event) => options.db.recordCartesiaCallOperationAudit({
    actor_type: 'admin_api',
    actor_id: 'shared_admin_token',
    action: config.action,
    resource_id: event.resourceId || config.resourceId,
    outcome: event.outcome,
    request_fingerprint: config.requestFingerprint,
    reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(event.reasonCode || '')) ? event.reasonCode : null,
  });
  if (typeof options.db?.recordCartesiaCallOperationAudit !== 'function') {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia call operation is unavailable' });
  }
  try {
    await writeAudit({ outcome: 'requested' });
  } catch {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia call operation is unavailable' });
  }

  let result;
  try {
    result = await config.execute();
  } catch (error) {
    const outcome = config.outcomeForError?.(error) || phoneMutationAuditOutcome(error);
    await writeAudit({ outcome, reasonCode: error?.code }).catch(() => {});
    return respondWithError(res, error);
  }
  try {
    await writeAudit({ outcome: 'succeeded', resourceId: config.getResourceId?.(result) || config.resourceId });
  } catch {
    return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia applied the call operation but its audit result could not be saved; refresh call status before retrying' });
  }
  return config.send(result);
}

async function runAuditedPhoneNumberOperation(options, req, res, config) {
  const body = config.body || {};
  const fingerprint = String(body.confirmed_fingerprint || '').toLowerCase();
  const shouldAudit = isAuditReadyPhoneMutation(body);
  const operation = config.action;
  let auditResourceId = config.resourceId || `pending:${fingerprint.slice(0, 40)}`;
  const actor = { actor_type: 'admin_api', actor_id: 'shared_admin_token' };
  const writeAudit = (event) => options.db.recordCartesiaPhoneNumberOperationAudit({
    ...actor,
    action: operation,
    resource_id: event.resourceId || auditResourceId,
    outcome: event.outcome,
    target_agent_id: event.targetAgentId === undefined ? (config.targetAgentId ?? null) : event.targetAgentId,
    request_fingerprint: fingerprint,
    reason_code: event.reasonCode || null,
  });

  if (shouldAudit) {
    if (typeof options.db?.recordCartesiaPhoneNumberOperationAudit !== 'function') {
      return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia phone-number operation is unavailable' });
    }
    try {
      await writeAudit({ outcome: 'requested' });
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia phone-number operation is unavailable' });
    }
  }

  let result;
  try {
    result = await config.execute();
  } catch (error) {
    if (shouldAudit) {
      await writeAudit({ outcome: phoneMutationAuditOutcome(error), reasonCode: error?.code }).catch(() => {});
    }
    return respondWithError(res, error);
  }

  if (shouldAudit) {
    auditResourceId = config.getResourceId?.(result) || auditResourceId;
    try {
      await writeAudit({
        outcome: 'succeeded',
        resourceId: auditResourceId,
        targetAgentId: config.getTargetAgentId?.(result),
      });
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia applied the phone-number operation but its audit result could not be saved; refresh inventory before retrying' });
    }
  }
  return config.send(result);
}

function registerCartesiaCallRoutes(app, options = {}) {
  const service = options.service;
  const batchService = options.batchService;
  const phoneNumberService = options.phoneNumberService;
  const telephonyProviderService = options.telephonyProviderService;
  const webhookConfigService = options.webhookConfigService;
  const client = options.client;
  const requireAdminToken = options.requireAdminToken || ((_req, _res, next) => next());
  const limiter = options.limiter || ((_req, _res, next) => next());
  const webhookLimiter = options.webhookLimiter || limiter;
  const webhookHandler = options.webhookHandler;

  app.get('/api/cartesia/status', requireAdminToken, (_req, res) => {
    const clientStatus = client?.getConfigurationStatus?.() || {
      enabled: false,
      configured: false,
      apiVersion: null,
    };
    return res.json({
      success: true,
      status: {
        ...clientStatus,
        dispatchEnabled: service?.dispatchEnabled === true,
        batchDispatchEnabled: batchService?.dispatchEnabled === true,
        batchReconciliationEnabled: batchService?.reconciliationEnabled === true && clientStatus.configured === true,
        batchReconciliationIntervalMs: batchService?.reconciliationIntervalMs || 60000,
        batchRetentionEnabled: batchService?.retentionEnabled === true && batchService?.retentionDays > 0,
        batchRetentionDays: batchService?.retentionDays || 0,
        destinationAllowlistCount: service?.allowedDestinations?.size || 0,
        webhookConfigured: Boolean(options.webhookSecret),
        webhookMutationsEnabled: webhookConfigService?.mutationsEnabled === true,
        phoneNumberMutationsEnabled: phoneNumberService?.mutationsEnabled === true,
        phoneNumberProvisioningEnabled: phoneNumberService?.provisioningEnabled === true,
        sipProviderMutationsEnabled: telephonyProviderService?.sipMutationsEnabled === true,
        telephonyProviderMutationsEnabled: telephonyProviderService?.providerMutationsEnabled === true,
      },
    });
  });

  if (phoneNumberService) {
    app.get('/api/cartesia/phone-numbers', requireAdminToken, limiter, async (req, res) => {
      const allowed = new Set(['limit', 'q', 'starting_after', 'ending_before', 'agent_id', 'provider_id', 'type']);
      if (rejectUnknownFields(req.query || {}, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_number_query_invalid', error: 'Unsupported phone number query fields' });
      }
      try {
        return res.json({ success: true, ...await phoneNumberService.list(req.query || {}) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.get('/api/cartesia/phone-numbers/:phoneNumberId', requireAdminToken, limiter, async (req, res) => {
      try {
        return res.json({ success: true, phoneNumber: await phoneNumberService.get(req.params.phoneNumberId) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/phone-numbers/import/preview', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'number', 'provider_id', 'agent_id', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_import_invalid', error: 'Unsupported phone import fields' });
      }
      try {
        const preview = await phoneNumberService.prepareImport(body);
        return res.json({
          success: true,
          preview: {
            operation: preview.operation,
            label: preview.label,
            number: preview.number,
            providerId: preview.providerId,
            agentId: preview.agentId,
            ownership: preview.ownership,
            numberAlreadyPresent: preview.numberAlreadyPresent,
            requestFingerprint: preview.requestFingerprint,
          },
        });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/phone-numbers/import', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'number', 'provider_id', 'agent_id', 'idempotency_key', 'approved', 'confirmed_fingerprint']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_import_invalid', error: 'Unsupported phone import fields' });
      }
      return runAuditedPhoneNumberOperation(options, req, res, {
        action: 'phone_number_import',
        body,
        targetAgentId: body.agent_id ?? null,
        execute: () => phoneNumberService.importNumber(body),
        getResourceId: (result) => result?.phoneNumber?.id,
        send: (result) => res.status(result.idempotentReplay ? 200 : 201).json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/phone-numbers/provision/preview', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'agent_id', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_provision_invalid', error: 'Unsupported phone provisioning fields' });
      }
      try {
        const preview = await phoneNumberService.prepareProvision(body);
        return res.json({
          success: true,
          preview: {
            operation: preview.operation,
            label: preview.label,
            agentId: preview.agentId,
            ownership: preview.ownership,
            potentialCharge: preview.potentialCharge,
            labelAlreadyUsed: preview.labelAlreadyUsed,
            requestFingerprint: preview.requestFingerprint,
          },
        });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/phone-numbers/provision', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'agent_id', 'idempotency_key', 'approved', 'confirmed_fingerprint', 'confirm_label']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_provision_invalid', error: 'Unsupported phone provisioning fields' });
      }
      return runAuditedPhoneNumberOperation(options, req, res, {
        action: 'phone_number_provision',
        body,
        targetAgentId: body.agent_id ?? null,
        execute: () => phoneNumberService.provisionNumber(body),
        getResourceId: (result) => result?.phoneNumber?.id,
        send: (result) => res.status(result.idempotentReplay ? 200 : 201).json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/phone-numbers/:phoneNumberId/release/preview', requireAdminToken, limiter, async (req, res) => {
      try {
        return res.json({ success: true, preview: await phoneNumberService.prepareRelease(req.params.phoneNumberId) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/phone-numbers/:phoneNumberId/release', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['approved', 'confirmed_fingerprint', 'confirm_number', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_release_invalid', error: 'Unsupported phone release fields' });
      }
      return runAuditedPhoneNumberOperation(options, req, res, {
        action: 'phone_number_release',
        body,
        resourceId: req.params.phoneNumberId,
        execute: () => phoneNumberService.releaseNumber({
          phoneNumberId: req.params.phoneNumberId,
          approved: body.approved,
          confirmed_fingerprint: body.confirmed_fingerprint,
          confirm_number: body.confirm_number,
          idempotency_key: body.idempotency_key,
        }),
        getResourceId: (result) => result?.phoneNumberId,
        send: (result) => res.json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/phone-numbers/:phoneNumberId/assignment/preview', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      if (rejectUnknownFields(body, new Set(['agent_id'])) || !Object.hasOwn(body, 'agent_id')) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_assignment_invalid', error: 'agent_id is required and must be a Cartesia agent ID or null' });
      }
      try {
        return res.json({
          success: true,
          preview: await phoneNumberService.prepareAssignment(req.params.phoneNumberId, body.agent_id),
        });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.put('/api/cartesia/phone-numbers/:phoneNumberId/assignment', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['agent_id', 'approved', 'confirmed_fingerprint', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed) || !Object.hasOwn(body, 'agent_id')) {
        return res.status(400).json({ success: false, code: 'cartesia_phone_assignment_invalid', error: 'Unsupported or missing phone assignment fields' });
      }
      return runAuditedPhoneNumberOperation(options, req, res, {
        action: 'phone_agent_assignment',
        body,
        resourceId: req.params.phoneNumberId,
        targetAgentId: body.agent_id,
        execute: () => phoneNumberService.assignAgent({
          phoneNumberId: req.params.phoneNumberId,
          agent_id: body.agent_id,
          approved: body.approved,
          confirmed_fingerprint: body.confirmed_fingerprint,
          idempotency_key: body.idempotency_key,
        }),
        getResourceId: (result) => result?.phoneNumberId,
        getTargetAgentId: (result) => result?.agentId,
        send: (result) => res.json({ success: true, assignment: result }),
      });
    });
  }

  if (telephonyProviderService) {
    app.get('/api/cartesia/providers', requireAdminToken, limiter, async (_req, res) => {
      try {
        return res.json({ success: true, providers: await telephonyProviderService.listProviders() });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.get('/api/cartesia/providers/:providerId', requireAdminToken, limiter, async (req, res) => {
      try {
        return res.json({ success: true, provider: await telephonyProviderService.getProvider(req.params.providerId) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/providers/twilio/preview', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_tls_required', error: 'Provider credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'account_sid', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_twilio_provider_configuration_invalid', error: 'Unsupported Twilio provider fields' });
      }
      try {
        const preview = await telephonyProviderService.previewTwilioProvider(body);
        return res.json({ success: true, preview });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/providers/twilio', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_tls_required', error: 'Provider credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'account_sid', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key', 'approved', 'confirmed_fingerprint', 'confirm_account_sid']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_twilio_provider_configuration_invalid', error: 'Unsupported Twilio provider fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'twilio_provider_create', body,
        execute: () => telephonyProviderService.createTwilioProvider(body),
        getResourceId: (result) => result?.provider?.id,
        send: (result) => res.status(result.idempotentReplay ? 200 : 201).json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/providers/twilio/update/preview', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_tls_required', error: 'Provider credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['provider_id', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_twilio_provider_update_invalid', error: 'Unsupported Twilio provider update fields' });
      }
      try {
        return res.json({ success: true, preview: await telephonyProviderService.previewTwilioProviderUpdate(body) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/providers/twilio/update', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_tls_required', error: 'Provider credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set([
        'provider_id', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key',
        'approved', 'confirmed_fingerprint', 'confirm_provider_id',
      ]);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_twilio_provider_update_invalid', error: 'Unsupported Twilio provider update fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'twilio_provider_update', body, resourceId: body.provider_id,
        execute: () => telephonyProviderService.updateTwilioProvider(body),
        getResourceId: (result) => result?.provider?.id,
        send: (result) => res.json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/providers/:providerId/delete/preview', requireAdminToken, limiter, async (req, res) => {
      try {
        return res.json({ success: true, preview: await telephonyProviderService.prepareProviderDeletion(req.params.providerId) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.delete('/api/cartesia/providers/:providerId', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_tls_required', error: 'Provider changes may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['idempotency_key', 'approved', 'confirmed_fingerprint', 'confirm_label']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_provider_delete_invalid', error: 'Unsupported provider deletion fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'telephony_provider_delete', body, resourceId: req.params.providerId,
        execute: () => telephonyProviderService.deleteProvider({ provider_id: req.params.providerId, ...body }),
        getResourceId: (result) => result?.providerId,
        send: (result) => res.json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/providers/sip/preview', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_tls_required', error: 'SIP credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'inbound', 'outbound', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_configuration_invalid', error: 'Unsupported SIP provider fields' });
      }
      try {
        return res.json({ success: true, preview: await telephonyProviderService.previewSIPProvider(body) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/providers/sip', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_tls_required', error: 'SIP credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['label', 'inbound', 'outbound', 'idempotency_key', 'approved', 'confirmed_fingerprint']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_configuration_invalid', error: 'Unsupported SIP provider fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'sip_provider_create', body,
        execute: () => telephonyProviderService.createSIPProvider({ ...body, confirmed_fingerprint: body.confirmed_fingerprint }),
        getResourceId: (result) => result?.provider?.id,
        send: (result) => res.status(result.idempotentReplay ? 200 : 201).json({ success: true, ...result }),
      });
    });

    app.post('/api/cartesia/providers/sip/update/preview', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_tls_required', error: 'SIP credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['provider_id', 'inbound', 'outbound', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_provider_update_invalid', error: 'Unsupported SIP provider update fields' });
      }
      try {
        return res.json({ success: true, preview: await telephonyProviderService.previewSIPProviderUpdate(body) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/providers/sip/update', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_tls_required', error: 'SIP credentials may only be submitted over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set([
        'provider_id', 'inbound', 'outbound', 'idempotency_key', 'approved',
        'confirmed_fingerprint', 'confirm_provider_id', 'confirm_linked_number_count',
      ]);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_sip_provider_update_invalid', error: 'Unsupported SIP provider update fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'sip_provider_update', body, resourceId: body.provider_id,
        execute: () => telephonyProviderService.updateSIPProvider(body),
        getResourceId: (result) => result?.provider?.id,
        send: (result) => res.json({ success: true, ...result }),
      });
    });
  }

  if (webhookConfigService) {
    app.post('/api/cartesia/webhooks/preview', requireAdminToken, limiter, async (req, res) => {
      if (rejectUnknownFields(isPlainObject(req.body) ? req.body : {}, new Set())) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_creation_invalid', error: 'Webhook creation preview does not accept request fields' });
      }
      try {
        return res.json({ success: true, preview: await webhookConfigService.prepareWebhookCreation() });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/webhooks', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_tls_required', error: 'Cartesia webhook configuration may only be changed over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['approved', 'confirmed_fingerprint', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_creation_invalid', error: 'Unsupported Cartesia webhook creation fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'webhook_create',
        auditMethod: 'recordCartesiaWebhookCreationAudit',
        body,
        resourceId: `endpoint:${crypto.createHash('sha256').update(String(webhookConfigService.publicWebhookUrl || '')).digest('hex').slice(0, 32)}`,
        writeAudit: (event) => options.db.recordCartesiaWebhookCreationAudit({
          actor_type: 'admin_api',
          actor_id: 'shared_admin_token',
          action: 'webhook_create',
          resource_id: event.resourceId || `endpoint:${crypto.createHash('sha256').update(String(webhookConfigService.publicWebhookUrl || '')).digest('hex').slice(0, 32)}`,
          outcome: event.outcome,
          request_fingerprint: String(body.confirmed_fingerprint || '').toLowerCase(),
          reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(event.reasonCode || '')) ? event.reasonCode : null,
        }),
        execute: () => webhookConfigService.createWebhook(body),
        send: (result) => res.status(result.idempotentReplay ? 200 : 201).json({ success: true, webhook: result }),
      });
    });

    app.post('/api/cartesia/agents/:agentId/webhook/assignment/preview', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      if (rejectUnknownFields(body, new Set(['webhook_id'])) || !Object.hasOwn(body, 'webhook_id')) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_assignment_invalid', error: 'webhook_id is required and must be a Cartesia webhook ID or null' });
      }
      try {
        return res.json({ success: true, preview: await webhookConfigService.prepareAssignment(req.params.agentId, body.webhook_id) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.put('/api/cartesia/agents/:agentId/webhook/assignment', requireAdminToken, limiter, async (req, res) => {
      if (req.secure !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_tls_required', error: 'Cartesia webhook configuration may only be changed over HTTPS' });
      }
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['webhook_id', 'approved', 'confirmed_fingerprint', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed) || !Object.hasOwn(body, 'webhook_id')) {
        return res.status(400).json({ success: false, code: 'cartesia_webhook_assignment_invalid', error: 'Unsupported or missing webhook assignment fields' });
      }
      return runAuditedProviderOperation(options, res, {
        action: 'agent_webhook_assignment',
        auditMethod: 'recordCartesiaWebhookAssignmentAudit',
        body,
        resourceId: `agent:${req.params.agentId}`,
        writeAudit: (event) => options.db.recordCartesiaWebhookAssignmentAudit({
          actor_type: 'admin_api',
          actor_id: 'shared_admin_token',
          action: 'agent_webhook_assignment',
          resource_id: event.resourceId || `agent:${req.params.agentId}`,
          outcome: event.outcome,
          request_fingerprint: String(body.confirmed_fingerprint || '').toLowerCase(),
          reason_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(event.reasonCode || '')) ? event.reasonCode : null,
        }),
        execute: () => webhookConfigService.assignAgentWebhook({
          agent_id: req.params.agentId,
          webhook_id: body.webhook_id,
          approved: body.approved,
          confirmed_fingerprint: body.confirmed_fingerprint,
          idempotency_key: body.idempotency_key,
        }),
        getResourceId: (result) => `agent:${result?.agentId || req.params.agentId}`,
        send: (result) => res.json({ success: true, assignment: result }),
      });
    });
  }

  app.post('/api/cartesia/calls/preview', requireAdminToken, limiter, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const allowed = new Set([
      'business_id', 'to_number', 'from_number_id', 'agent_id',
      'dynamic_variables', 'ringing_timeout_seconds', 'max_call_duration_minutes',
    ]);
    if (rejectUnknownFields(body, allowed)) {
      return res.status(400).json({ success: false, code: 'cartesia_request_invalid', error: 'Unsupported call preview fields' });
    }
    try {
      const preview = await service.prepareOutboundCall({
        business_id: body.business_id,
        to_number: body.to_number,
        from_number_id: body.from_number_id,
        agent_id: body.agent_id,
        dynamic_variables: body.dynamic_variables,
        ringing_timeout_seconds: body.ringing_timeout_seconds,
        max_call_duration_minutes: body.max_call_duration_minutes,
      });
      return res.json({ success: true, preview });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  if (batchService) {
    app.post('/api/cartesia/call-batches/preview', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['business_id', 'name', 'from_number_id', 'agent_id', 'recipients', 'target_concurrency_limit', 'ringing_timeout_seconds', 'max_call_duration_minutes']);
      if (rejectUnknownFields(body, allowed)) return res.status(400).json({ success: false, code: 'cartesia_batch_invalid', error: 'Unsupported Cartesia batch fields' });
      try {
        return res.json({ success: true, preview: await batchService.prepareBatch(body) });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/call-batches', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const allowed = new Set(['business_id', 'name', 'from_number_id', 'agent_id', 'recipients', 'target_concurrency_limit', 'ringing_timeout_seconds', 'max_call_duration_minutes', 'approved', 'confirmed_fingerprint', 'idempotency_key']);
      if (rejectUnknownFields(body, allowed)) return res.status(400).json({ success: false, code: 'cartesia_batch_invalid', error: 'Unsupported Cartesia batch fields' });
      const fingerprint = String(body.confirmed_fingerprint || '').toLowerCase();
      const shouldAudit = body.approved === true && /^[a-f0-9]{64}$/.test(fingerprint) && /^[A-Za-z0-9._:-]{8,100}$/.test(String(body.idempotency_key || ''));
      return runAuditedCallOperation(options, res, {
        shouldAudit,
        action: 'outbound_call_dispatch',
        resourceId: `pending:${fingerprint.slice(0, 40)}`,
        requestFingerprint: fingerprint,
        execute: () => batchService.createBatch({ ...body, confirmedFingerprint: body.confirmed_fingerprint }),
        getResourceId: (result) => result?.id ? `batch:${result.id}` : undefined,
        send: (result) => res.status(result.idempotentReplay ? 200 : 202).json({ success: true, batch: result }),
      });
    });

    app.get('/api/cartesia/call-batches', requireAdminToken, limiter, async (req, res) => {
      const allowed = new Set(['limit', 'starting_after', 'ending_before', 'agent_id']);
      if (rejectUnknownFields(req.query || {}, allowed)) {
        return res.status(400).json({ success: false, code: 'cartesia_batch_query_invalid', error: 'Unsupported Cartesia batch query fields' });
      }
      try { return res.json({ success: true, ...await batchService.listBatches(req.query || {}) }); }
      catch (error) { return respondWithError(res, error); }
    });

    app.get('/api/cartesia/call-batches/:batchId', requireAdminToken, limiter, async (req, res) => {
      try { return res.json({ success: true, batch: await batchService.getBatch(req.params.batchId) }); }
      catch (error) { return respondWithError(res, error); }
    });

    app.post('/api/cartesia/call-batches/:batchId/reconcile', requireAdminToken, limiter, async (req, res) => {
      if (rejectUnknownFields(isPlainObject(req.body) ? req.body : {}, new Set())) {
        return res.status(400).json({ success: false, code: 'cartesia_batch_reconcile_invalid', error: 'Batch reconciliation does not accept request fields' });
      }
      try { return res.json({ success: true, batch: await batchService.reconcileBatch(req.params.batchId) }); }
      catch (error) { return respondWithError(res, error); }
    });

    app.get('/api/cartesia/call-batches/:batchId/records', requireAdminToken, limiter, async (req, res) => {
      try { return res.json({ success: true, batch: await batchService.getStoredBatch(req.params.batchId) }); }
      catch (error) { return respondWithError(res, error); }
    });

    app.get('/api/cartesia/call-batches/:batchId/records.csv', requireAdminToken, limiter, async (req, res) => {
      const batchId = String(req.params.batchId || '');
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId)) {
        return res.status(400).json({ success: false, code: 'cartesia_invalid_batch_id', error: 'Cartesia batch ID is invalid' });
      }
      try {
        const batch = await batchService.getStoredBatch(batchId);
        if (!Array.isArray(batch?.recipients) || batch.recipients.length > 10000) {
          return res.status(502).json({ success: false, code: 'cartesia_batch_records_invalid', error: 'Stored Cartesia batch results are invalid' });
        }
        res.set('Cache-Control', 'no-store');
        res.set('Content-Disposition', `attachment; filename="cartesia-batch-${batchId}.csv"`);
        return res.type('text/csv; charset=utf-8').send(cartesiaBatchResultsCsv(batch));
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/call-batches/:batchId/retention/preview', requireAdminToken, limiter, async (req, res) => {
      if (rejectUnknownFields(isPlainObject(req.body) ? req.body : {}, new Set())) {
        return res.status(400).json({ success: false, code: 'cartesia_batch_retention_invalid', error: 'Retention preview does not accept request fields' });
      }
      try {
        const preview = await batchService.prepareRetentionPurge(req.params.batchId);
        return res.json({ success: true, preview: {
          batchId: preview.batchId,
          enabled: preview.enabled,
          retentionDays: preview.retentionDays,
          status: preview.status,
          eligible: preview.eligible,
          recipientCount: preview.recipientCount,
          expiresAt: preview.expiresAt,
          fingerprint: preview.fingerprint,
          reason: preview.reason,
        } });
      } catch (error) {
        return respondWithError(res, error);
      }
    });

    app.post('/api/cartesia/call-batches/:batchId/retention', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      if (rejectUnknownFields(body, new Set(['approved', 'confirmed_fingerprint'])) || body.approved !== true ||
          !/^[a-f0-9]{64}$/.test(String(body.confirmed_fingerprint || ''))) {
        return res.status(400).json({ success: false, code: 'cartesia_batch_retention_confirmation_required', error: 'Explicit approval and a preview fingerprint are required' });
      }
      const batchId = String(req.params.batchId || '');
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId)) {
        return res.status(400).json({ success: false, code: 'cartesia_invalid_batch_id', error: 'Cartesia batch ID is invalid' });
      }
      if (typeof options.db?.recordCartesiaBatchRetentionAudit !== 'function') {
        return res.status(503).json({ success: false, code: 'cartesia_batch_retention_audit_unavailable', error: 'Cartesia retention operation is unavailable' });
      }
      const fingerprint = String(body.confirmed_fingerprint).toLowerCase();
      const audit = (outcome, recipientCount = 0, reasonCode = null) => options.db.recordCartesiaBatchRetentionAudit({
        provider_batch_id: batchId,
        request_fingerprint: fingerprint,
        recipient_count: recipientCount,
        outcome,
        reason_code: reasonCode,
      });
      try {
        await audit('requested');
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_batch_retention_audit_unavailable', error: 'Cartesia retention operation is unavailable' });
      }
      let result;
      try {
        result = await batchService.purgeExpiredRecipients(batchId, fingerprint);
      } catch (error) {
        await audit('failed', 0, error?.code).catch(() => {});
        return respondWithError(res, error);
      }
      try {
        await audit('succeeded', result.deletedCount);
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_batch_retention_audit_unavailable', error: 'Recipient records were deleted but the operation outcome could not be audited; refresh local batch records' });
      }
      return res.json({ success: true, result });
    });

    app.post('/api/cartesia/call-batches/:batchId/cancel', requireAdminToken, limiter, async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      if (rejectUnknownFields(body, new Set(['approved'])) || body.approved !== true) {
        return res.status(400).json({ success: false, code: 'cartesia_batch_cancel_confirmation_required', error: 'Explicit batch cancellation approval is required' });
      }
      const batchId = String(req.params.batchId || '');
      const requestFingerprint = crypto.createHash('sha256').update(`cartesia_batch_cancel:${batchId}`).digest('hex');
      return runAuditedCallOperation(options, res, {
        shouldAudit: /^[A-Za-z0-9_-]{1,200}$/.test(batchId),
        action: 'outbound_call_cancel',
        resourceId: `batch:${batchId}`,
        requestFingerprint,
        execute: () => batchService.cancelBatch(batchId, true),
        getResourceId: (result) => result?.id ? `batch:${result.id}` : undefined,
        send: (result) => res.json({ success: true, batch: result }),
      });
    });
  }

  app.post('/api/cartesia/calls', requireAdminToken, limiter, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const allowed = new Set([
      'business_id', 'to_number', 'from_number_id', 'agent_id',
      'dynamic_variables', 'ringing_timeout_seconds', 'max_call_duration_minutes',
      'approved', 'confirmed_fingerprint', 'idempotency_key',
    ]);
    if (rejectUnknownFields(body, allowed)) {
      return res.status(400).json({ success: false, code: 'cartesia_request_invalid', error: 'Unsupported Cartesia call fields' });
    }
    return runAuditedCallOperation(options, res, {
      shouldAudit: isAuditReadyCallDispatch(body),
      action: 'outbound_call_dispatch',
      resourceId: `pending:${String(body.confirmed_fingerprint || '').slice(0, 40)}`,
      requestFingerprint: String(body.confirmed_fingerprint || '').toLowerCase(),
      execute: () => service.createOutboundCall({
        business_id: body.business_id,
        to_number: body.to_number,
        from_number_id: body.from_number_id,
        agent_id: body.agent_id,
        dynamic_variables: body.dynamic_variables,
        ringing_timeout_seconds: body.ringing_timeout_seconds,
        max_call_duration_minutes: body.max_call_duration_minutes,
        approved: body.approved,
        confirmedFingerprint: body.confirmed_fingerprint,
        idempotency_key: body.idempotency_key,
      }),
      getResourceId: (result) => result?.providerCallId,
      send: (result) => res.status(result.idempotentReplay ? 200 : 202).json({ success: true, call: result }),
    });
  });

  app.get('/api/cartesia/calls/:providerCallId', requireAdminToken, limiter, async (req, res) => {
    try {
      const call = await service.getCall(req.params.providerCallId);
      return res.json({ success: true, call });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/cartesia/calls/:providerCallId/cancel', requireAdminToken, limiter, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (rejectUnknownFields(body, new Set(['approved'])) || body.approved !== true) {
      return res.status(400).json({ success: false, code: 'cartesia_cancel_confirmation_required', error: 'Explicit cancellation approval is required' });
    }
    const providerCallId = String(req.params.providerCallId || '');
    const requestFingerprint = crypto.createHash('sha256').update(`cartesia_call_cancel:${providerCallId}`).digest('hex');
    return runAuditedCallOperation(options, res, {
      shouldAudit: /^[A-Za-z0-9_-]{1,200}$/.test(providerCallId),
      action: 'outbound_call_cancel',
      resourceId: providerCallId,
      requestFingerprint,
      execute: () => service.cancelCall(providerCallId, true),
      getResourceId: (result) => result?.providerCallId,
      send: (result) => res.json({ success: true, ...result }),
    });
  });

  if (typeof webhookHandler === 'function') {
    app.post('/api/webhooks/cartesia', webhookLimiter, webhookHandler);
  }
}

module.exports = { registerCartesiaCallRoutes };
