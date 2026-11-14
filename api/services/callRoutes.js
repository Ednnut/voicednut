const { runPostCallQaEvaluation } = require("./postCallQaService");

function createOutboundCallHandler(ctx = {}) {
  const {
    sendApiError,
    resolveHost,
    config,
    placeOutboundCall,
    buildErrorDetails,
    getCurrentProvider,
  } = ctx;

  return async function handleOutboundCall(req, res) {
    try {
      const requestedProvider = String(
        req.body?.provider || req.body?.preferred_provider || req.body?.call_provider || "",
      ).trim().toLowerCase();
      if (requestedProvider === "cartesia") {
        const number = String(req.body?.number || "").trim();
        const businessId = String(req.body?.business_id || "").trim();
        const agentId = String(req.body?.agent_id || "").trim();
        const fromNumberId = String(req.body?.from_number_id || "").trim();
        const idempotencyKey = String(req.body?.idempotency_key || req.headers?.["idempotency-key"] || "").trim();
        if (!/^\+[1-9]\d{7,14}$/.test(number) || !businessId || !agentId || !fromNumberId ||
            !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
          return sendApiError(res, 400, "cartesia_call_input_invalid", "Business, E.164 destination, agent, source number, and idempotency key are required", req.requestId || null);
        }
        try {
          if (typeof ctx.placeCartesiaOutboundCall !== "function") {
            const error = new Error("Cartesia Managed Agent calls are unavailable");
            error.code = "cartesia_not_configured";
            throw error;
          }
          const result = await ctx.placeCartesiaOutboundCall({
            business_id: businessId,
            actor_id: req.callEActorId,
            destination: number,
            agent_id: agentId,
            from_number_id: fromNumberId,
            idempotency_key: idempotencyKey,
            approval_token: req.body?.approval_token,
            dynamic_variables: req.body?.dynamic_variables,
          });
          const providerCallId = String(result?.providerCallId || "").trim();
          if (!providerCallId) {
            const error = new Error("Cartesia did not return a call ID");
            error.code = "cartesia_call_outcome_unknown";
            throw error;
          }
          return res.json({
            success: true,
            call_sid: providerCallId,
            provider_call_id: providerCallId,
            to: number,
            status: result.status || "created",
            deduped: result.idempotentReplay === true,
            provider: "cartesia",
            ai_voice_engine: "cartesia",
            business_id: businessId,
            agent_id: agentId,
          });
        } catch (error) {
          const code = String(error?.code || "cartesia_call_failed");
          const status = Number(error?.status) || (code.includes("not_configured") || code.includes("approval_unavailable") || code.includes("dependencies_missing") ? 503
            : code.includes("operator") || code.includes("scope") ? 403
              : code.includes("invalid") || code.includes("required") ? 400
                : code.includes("conflict") || code.includes("unresolved") || code.includes("not_ready") || code.includes("approval") ? 409 : 502);
          console.error("cartesia_managed_agent_call_error", { code, status });
          return sendApiError(res, status, code, status >= 500 ? "Cartesia Managed Agent call failed or needs reconciliation" : error.message, req.requestId || null);
        }
      }
      if (requestedProvider === "vapi") {
        const number = String(req.body?.number || "").trim();
        const templateId = Number(req.body?.script_id);
        const mappingId = Number(req.body?.mapping_id);
        const phoneNumberId = String(req.body?.phone_number_id || "").trim();
        const idempotencyKey = String(
          req.body?.idempotency_key || req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"] || "",
        ).trim();
        const validationError = (status, code, message) => sendApiError(
          res, status, code, message, req.requestId || null,
        );
        if (!Number.isSafeInteger(templateId) || templateId <= 0 || !Number.isSafeInteger(mappingId) || mappingId <= 0) {
          return validationError(400, "vapi_mapping_required", "script_id and mapping_id are required for Vapi calls");
        }
        if (!phoneNumberId || phoneNumberId.length > 200) {
          return validationError(400, "vapi_phone_number_id_required", "phone_number_id is required for Vapi calls");
        }
        if (!/^\+[1-9]\d{1,14}$/.test(number)) {
          return validationError(400, "vapi_destination_invalid", "Destination number must use E.164 format");
        }
        if (!/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
          return validationError(400, "vapi_idempotency_key_required", "A valid idempotency key is required for Vapi calls");
        }
        try {
          if (typeof ctx.placeVapiOutboundCall !== "function") {
            const error = new Error("Vapi outbound calling is unavailable");
            error.code = "vapi_not_configured";
            throw error;
          }
          const result = await ctx.placeVapiOutboundCall({
            templateId,
            ...(req.body?.script_version !== undefined ? { templateVersion: req.body.script_version } : {}),
            mappingId, phoneNumberId, number, idempotencyKey,
            ...(req.body?.first_message_override !== undefined ? { firstMessage: req.body.first_message_override } : {}),
            ...(req.body?.variable_values !== undefined ? { variableValues: req.body.variable_values } : {}),
            actorId: req.callEActorId,
          });
          const providerCallId = String(result?.providerCallId || "").trim();
          if (!providerCallId) {
            const error = new Error("Vapi did not return a call ID");
            error.code = "vapi_call_id_missing";
            throw error;
          }
          return res.json({
            success: true,
            call_sid: providerCallId,
            provider_call_id: providerCallId,
            to: number,
            status: result.status || "queued",
            deduped: result.idempotentReplay === true,
            provider: "vapi",
            ai_voice_engine: "vapi",
            template_id: Number(result.templateId) || templateId,
            template_version: Number(result.templateVersion) || null,
            mapping_id: Number(result.mappingId) || mappingId,
            business_context: null,
            generated_functions: 0,
            function_types: [],
            enhanced_webhooks: true,
          });
        } catch (error) {
          const code = String(error?.code || "vapi_call_failed");
          const status = code.startsWith("outbound_") ? Number(error?.status) || 409
            : code === "vapi_not_configured" || code === "vapi_call_dependencies_missing" ? 503
            : ["vapi_mapping_required", "vapi_phone_number_id_required", "vapi_destination_invalid", "vapi_idempotency_key_required", "vapi_first_message_invalid", "vapi_variables_invalid"].includes(code) ? 400
              : ["vapi_mapping_not_found", "vapi_mapping_not_ready", "vapi_mapping_stale", "vapi_template_unsupported", "vapi_mapping_template_mismatch", "vapi_idempotency_conflict", "vapi_previous_call_failed", "vapi_call_outcome_unresolved"].includes(code) ? 409
                : 502;
          console.error("vapi_outbound_call_route_error", {
            code,
            status: Number.isFinite(error?.status) ? error.status : null,
          });
          return sendApiError(
            res,
            status,
            code,
            status === 502 ? "Vapi outbound call failed" : error.message,
            req.requestId || null,
          );
        }
      }

      const number = String(req.body?.number || "").trim();
      const prompt = String(req.body?.prompt || "").trim();
      const firstMessage = String(req.body?.first_message || "").trim();
      const scriptId =
        req.body?.script_id !== undefined && req.body?.script_id !== null
          ? String(req.body.script_id).trim()
          : "";
      const hasInlineScript = Boolean(prompt && firstMessage);
      const hasTemplateScript = Boolean(scriptId);
      if (!number || (!hasInlineScript && !hasTemplateScript)) {
        return sendApiError(
          res,
          400,
          "validation_error",
          "number and either (prompt + first_message) or script_id are required",
          req.requestId || null,
        );
      }
      if (!/^\+[1-9]\d{1,14}$/.test(number)) {
        return sendApiError(
          res,
          400,
          "invalid_phone_number",
          "Invalid phone number format. Use E.164 format (e.g., +1234567890)",
          req.requestId || null,
        );
      }
      if ((prompt && prompt.length > 12000) || (firstMessage && firstMessage.length > 1000)) {
        return sendApiError(
          res,
          400,
          "validation_error",
          "prompt or first_message is too long",
          req.requestId || null,
        );
      }

      const resolvedCustomerName =
        req.body?.customer_name ?? req.body?.victim_name ?? null;
      const payload = {
        number,
        prompt,
        first_message: firstMessage,
        idempotency_key:
          req.body?.idempotency_key ||
          req.headers?.["idempotency-key"] ||
          req.headers?.["Idempotency-Key"] ||
          null,
        user_chat_id: req.callEActorId,
        customer_name: resolvedCustomerName,
        business_id: req.body?.business_id,
        script: req.body?.script,
        script_id: req.body?.script_id,
        script_version: req.body?.script_version,
  call_profile:
    req.body?.call_profile ||
    req.body?.conversation_profile ||
    req.body?.profile,
  attached_profile: req.body?.attached_profile,
  auto_attach_profile: req.body?.auto_attach_profile,
  profile_lock_mode: req.body?.profile_lock_mode,
  conversation_profile: req.body?.conversation_profile,
  conversation_profile_lock:
    req.body?.conversation_profile_lock ?? req.body?.profile_lock,
        profile_confidence_gate:
          req.body?.profile_confidence_gate,
        purpose: req.body?.purpose || req.body?.call_profile || req.body?.profile,
        preferred_provider:
          req.body?.preferred_provider || req.body?.call_provider || req.body?.provider || null,
        emotion: req.body?.emotion,
        urgency: req.body?.urgency,
        technical_level: req.body?.technical_level,
        voice_model: req.body?.voice_model,
        collection_profile: req.body?.collection_profile,
        collection_expected_length: req.body?.collection_expected_length,
        collection_timeout_s: req.body?.collection_timeout_s,
        collection_max_retries: req.body?.collection_max_retries,
        collection_mask_for_gpt: req.body?.collection_mask_for_gpt,
        collection_speak_confirmation: req.body?.collection_speak_confirmation,
        payment_enabled: req.body?.payment_enabled,
        payment_connector: req.body?.payment_connector,
        payment_amount: req.body?.payment_amount,
        payment_currency: req.body?.payment_currency,
        payment_description: req.body?.payment_description,
        payment_start_message: req.body?.payment_start_message,
        payment_success_message: req.body?.payment_success_message,
        payment_failure_message: req.body?.payment_failure_message,
        payment_retry_message: req.body?.payment_retry_message,
        payment_policy: req.body?.payment_policy,
      };

      const host = resolveHost(req) || config.server?.hostname;
      const result = await placeOutboundCall(payload, host);

      return res.json({
        success: true,
        call_sid: result.callId,
        to: payload.number,
        status: result.callStatus,
        deduped: result.idempotentReplay === true,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        provider:
          result.provider ||
          (typeof getCurrentProvider === "function"
            ? getCurrentProvider()
            : "twilio"),
        ai_voice_engine: result.aiVoiceEngine || null,
        business_context: result.functionSystem.context,
        generated_functions: result.functionSystem.functions.length,
        function_types: result.functionSystem.functions.map(
          (f) => f.function.name,
        ),
        enhanced_webhooks: true,
      });
    } catch (error) {
      const message = String(error?.message || "");
      const paymentRequiresScript = error?.code === "payment_requires_script";
      const paymentPolicyRequiresScript =
        error?.code === "payment_policy_requires_script";
      const paymentPolicyInvalid = error?.code === "payment_policy_invalid";
      const paymentValidationError = error?.code === "payment_validation_error";
      const outboundPersistenceFailed =
        error?.code === "outbound_persistence_failed";
      const idempotencyConflict = error?.code === "idempotency_conflict";
      const idempotencyInProgress = error?.code === "idempotency_in_progress";
      const providerOperationUnsupported = error?.code === "provider_operation_unsupported";
      const outboundSafetyBlock = String(error?.code || "").startsWith("outbound_");
      const isValidation =
        paymentRequiresScript ||
        paymentPolicyRequiresScript ||
        paymentPolicyInvalid ||
        paymentValidationError ||
        message.includes("Missing required fields") ||
        message.includes("Invalid phone number format");
      const status = outboundSafetyBlock
        ? Number(error?.status) || 409
        : idempotencyConflict || idempotencyInProgress || providerOperationUnsupported
        ? 409
        : outboundPersistenceFailed
          ? 503
          : paymentRequiresScript || paymentPolicyRequiresScript || isValidation
            ? 400
            : 500;
      let code = "outbound_call_failed";
      if (paymentRequiresScript) {
        code = "payment_requires_script";
      } else if (paymentPolicyRequiresScript) {
        code = "payment_policy_requires_script";
      } else if (paymentPolicyInvalid) {
        code = "payment_policy_invalid";
      } else if (paymentValidationError) {
        code = "payment_validation_error";
      } else if (idempotencyConflict) {
        code = "idempotency_conflict";
      } else if (idempotencyInProgress) {
        code = "idempotency_in_progress";
      } else if (outboundPersistenceFailed) {
        code = "outbound_persistence_failed";
      } else if (providerOperationUnsupported) {
        code = "provider_operation_unsupported";
      } else if (outboundSafetyBlock) {
        code = String(error.code);
      } else if (isValidation) {
        code = "validation_error";
      }
      console.error(
        "Error creating enhanced adaptive outbound call:",
        buildErrorDetails(error),
      );
      return sendApiError(
        res,
        status,
        code,
        paymentRequiresScript
          ? "Payment settings require a valid script_id."
          : paymentPolicyRequiresScript
            ? "Payment policy requires a valid script_id."
            : paymentPolicyInvalid || paymentValidationError
              ? message || "Invalid payment configuration."
          : outboundPersistenceFailed
            ? "Call provider accepted the request but VOICEDNUT could not persist confirmation. Do not retry the call; reconcile its saved record."
          : providerOperationUnsupported
            ? message || "The selected provider does not support this call operation."
          : outboundSafetyBlock
            ? message || "Outbound safety policy blocked this call."
          : "Failed to create outbound call",
        req.requestId || null,
        { details: buildErrorDetails(error) },
      );
    }
  };
}

function getRequesterChatId(req) {
  const raw =
    req.headers?.["x-telegram-chat-id"] ||
    req.query?.telegram_chat_id ||
    req.query?.chat_id ||
    "";
  return String(raw || "").trim();
}

function isOwnedByDifferentChat(call, requesterChatId) {
  if (!requesterChatId) return false;
  return String(call?.user_chat_id || "") !== String(requesterChatId);
}

function pickTranscriptAudioUrl(call, states = []) {
  const pickHttp = (value) => {
    const candidate = String(value || "").trim();
    if (!candidate) return null;
    if (!/^https?:\/\//i.test(candidate)) return null;
    return candidate;
  };

  const topLevelCandidates = [
    call?.transcript_audio_url,
    call?.transcriptAudioUrl,
    call?.recording_url,
    call?.recordingUrl,
    call?.audio_url,
    call?.audioUrl,
  ];
  for (const candidate of topLevelCandidates) {
    const url = pickHttp(candidate);
    if (url) return url;
  }

  for (const state of states) {
    const data =
      state?.data && typeof state.data === "object" && !Array.isArray(state.data)
        ? state.data
        : null;
    if (!data) continue;
    const stateCandidates = [
      data.transcript_audio_url,
      data.transcriptAudioUrl,
      data.recording_url,
      data.recordingUrl,
      data.audio_url,
      data.audioUrl,
      data.media_url,
      data.mediaUrl,
      data.url,
    ];
    for (const candidate of stateCandidates) {
      const url = pickHttp(candidate);
      if (url) return url;
    }
  }

  return null;
}

function normalizeTranscriptMessage(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTranscriptAudioNarration(transcripts = [], call = {}, options = {}) {
  const maxChars = Math.max(
    800,
    Math.min(Number(options.maxChars) || 2600, 10000),
  );
  const contactLabel = normalizeTranscriptMessage(
    call?.customer_name ||
      call?.victim_name ||
      call?.phone_number ||
      "the contact",
  );
  const lines = [`Call transcript for ${contactLabel}.`];
  let totalChars = lines[0].length;

  for (const entry of Array.isArray(transcripts) ? transcripts : []) {
    const message = normalizeTranscriptMessage(entry?.message);
    if (!message) continue;
    const speakerValue = String(entry?.speaker || "").toLowerCase();
    const speaker =
      speakerValue === "ai"
        ? "Agent"
        : speakerValue === "user"
          ? "Customer"
          : "Speaker";
    const line = `${speaker}: ${message}.`;
    if (totalChars + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length === 1) {
    return "";
  }
  return lines.join(" ");
}

function maskNumericToken(value, keepTail = 2) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= keepTail) {
    return "*".repeat(digits.length);
  }
  return `${"*".repeat(Math.max(2, digits.length - keepTail))}${digits.slice(-keepTail)}`;
}

function maskSensitiveExternalText(text, digitService = null) {
  const raw = String(text || "");
  if (!raw) return raw;
  if (digitService && typeof digitService.maskOtpForExternal === "function") {
    return digitService.maskOtpForExternal(raw);
  }
  return raw
    .replace(/\b\d{4,}\b/g, (match) => maskNumericToken(match, 2) || "******")
    .replace(
      /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){3,}\b/gi,
      "******",
    );
}

const DIGIT_TOKEN_REF_REGEX = /(vault:\/\/digits\/[^\s/]+\/tok_[A-Za-z0-9_]+|tok_[A-Za-z0-9_]+)/g;

function resolveDigitReference(value, callSid, digitService = null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const isToken = raw.startsWith("vault://digits/") || raw.startsWith("tok_");
  if (!isToken) return raw;
  if (digitService && typeof digitService.resolveSensitiveTokenRef === "function") {
    const result = digitService.resolveSensitiveTokenRef(callSid || null, raw);
    if (result?.ok && result.value) {
      return String(result.value);
    }
  }
  return raw;
}

function resolveTokenizedExternalText(text, callSid, digitService = null) {
  const raw = String(text || "");
  if (!raw) return raw;
  return raw.replace(DIGIT_TOKEN_REF_REGEX, (match) =>
    resolveDigitReference(match, callSid, digitService),
  );
}

function createGetCallDetailsHandler(ctx = {}) {
  const { isSafeId, normalizeCallRecordForApi, buildDigitSummary } = ctx;

  return async function handleGetCallDetails(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const { callSid } = req.params;
      if (!isSafeId(callSid, { max: 128 })) {
        return res.status(400).json({ error: "Invalid call identifier" });
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }
      const requesterChatId = getRequesterChatId(req);
      if (isOwnedByDifferentChat(call, requesterChatId)) {
        return res.status(403).json({ error: "Not authorized for this call" });
      }
      let callState = null;
      try {
        callState = await db.getLatestCallState(callSid, "call_created");
      } catch (_) {
        callState = null;
      }
      const enrichedCall =
        callState?.customer_name || callState?.victim_name
          ? {
              ...call,
              customer_name:
                callState?.customer_name || callState?.victim_name,
            }
          : call;
      const normalizedCall = normalizeCallRecordForApi({
        ...enrichedCall,
        call_created_state: callState || null,
      });
      if (!normalizedCall.digit_summary) {
        const digitEvents = await db.getCallDigits(callSid).catch(() => []);
        const digitSummary = buildDigitSummary(digitEvents);
        normalizedCall.digit_summary = digitSummary.summary;
        normalizedCall.digit_count = digitSummary.count;
      }

      const transcripts = await db.getCallTranscripts(callSid);
      const digitService =
        typeof ctx.getDigitService === "function"
          ? ctx.getDigitService()
          : ctx.digitService;
      const exposeRawDigits = Boolean(requesterChatId);
      const responseTranscripts = (Array.isArray(transcripts) ? transcripts : []).map(
        (entry) => ({
          ...entry,
          message: exposeRawDigits
            ? resolveTokenizedExternalText(entry?.message || "", callSid, digitService)
            : maskSensitiveExternalText(entry?.message || "", digitService),
        }),
      );
      normalizedCall.call_summary = exposeRawDigits
        ? resolveTokenizedExternalText(
            normalizedCall.call_summary || "",
            callSid,
            digitService,
          )
        : maskSensitiveExternalText(normalizedCall.call_summary || "", digitService);
      if (normalizedCall.last_otp && exposeRawDigits) {
        normalizedCall.last_otp = resolveDigitReference(
          normalizedCall.last_otp,
          callSid,
          digitService,
        );
      } else if (normalizedCall.last_otp) {
        const otpMasked = String(normalizedCall.last_otp_masked || "").trim();
        normalizedCall.last_otp =
          otpMasked || maskNumericToken(normalizedCall.last_otp, 2) || "******";
      }

      let adaptationData = {};
      try {
        if (call.ai_analysis) {
          const analysis = JSON.parse(call.ai_analysis);
          adaptationData = analysis.adaptation || {};
        }
      } catch (e) {
        console.error("Error parsing adaptation data:", e);
      }

      const webhookNotifications = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT * FROM webhook_notifications WHERE call_sid = ? ORDER BY created_at DESC`,
          [callSid],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        );
      });

      return res.json({
        call: normalizedCall,
        transcripts: responseTranscripts,
        transcript_count: responseTranscripts.length,
        adaptation_analytics: adaptationData,
        business_context: normalizedCall.business_context,
        webhook_notifications: webhookNotifications,
        enhanced_features: true,
      });
    } catch (error) {
      console.error("Error fetching enhanced adaptive call details:", error);
      return res.status(500).json({ error: "Failed to fetch call details" });
    }
  };
}

function createGetTranscriptAudioHandler(ctx = {}) {
  const { isSafeId } = ctx;

  return async function handleGetTranscriptAudio(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const { callSid } = req.params;
      if (!isSafeId(callSid, { max: 128 })) {
        return res.status(400).json({ error: "Invalid call identifier" });
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return res.status(404).json({
          success: false,
          error: "Call not found",
        });
      }

      const requesterChatId = getRequesterChatId(req);
      if (!requesterChatId && call?.user_chat_id) {
        return res.status(403).json({
          success: false,
          error: "Not authorized for this call",
        });
      }
      if (isOwnedByDifferentChat(call, requesterChatId)) {
        return res.status(403).json({
          success: false,
          error: "Not authorized for this call",
        });
      }

      const transcriptsRaw = await db.getCallTranscripts(callSid).catch(() => []);
      if (!Array.isArray(transcriptsRaw) || transcriptsRaw.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Transcript not found",
        });
      }
      const digitService =
        typeof ctx.getDigitService === "function"
          ? ctx.getDigitService()
          : ctx.digitService;
      const exposeRawDigits = Boolean(requesterChatId);
      const transcripts = transcriptsRaw.map((entry) => ({
        ...entry,
        message: exposeRawDigits
          ? resolveTokenizedExternalText(entry?.message || "", callSid, digitService)
          : maskSensitiveExternalText(entry?.message || "", digitService),
      }));

      const callStates = await db.getCallStates(callSid, { limit: 40 }).catch(() => []);
      let audioUrl = pickTranscriptAudioUrl(call, callStates);
      if (!audioUrl && typeof ctx.getTranscriptAudioUrl === "function") {
        try {
          const narration = buildTranscriptAudioNarration(transcripts, call, {
            maxChars: ctx.transcriptAudioMaxChars,
          });
          if (narration) {
            audioUrl = await ctx.getTranscriptAudioUrl(narration, call, {
              timeoutMs: ctx.transcriptAudioTimeoutMs,
            });
            if (audioUrl) {
              await db
                .updateCallState(callSid, "transcript_audio_ready", {
                  audio_url: audioUrl,
                  source: "transcript_tts",
                  generated_at: new Date().toISOString(),
                })
                .catch(() => {});
            }
          }
        } catch (audioError) {
          console.error(
            `Transcript audio generation failed for ${callSid}:`,
            audioError?.message || audioError,
          );
        }
      }
      if (!audioUrl) {
        return res.status(202).json({
          success: false,
          status: "pending",
          message: "Transcript audio is not available yet.",
          retry_after_seconds: 30,
        });
      }

      return res.status(200).json({
        success: true,
        status: "ready",
        call_sid: callSid,
        audio_url: audioUrl,
        caption: "🎧 Transcript audio",
      });
    } catch (error) {
      console.error("Error fetching transcript audio:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch transcript audio",
      });
    }
  };
}

function createGetCallQaHandler(ctx = {}) {
  const { isSafeId } = ctx;

  return async function handleGetCallQa(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const { callSid } = req.params;
      if (!isSafeId(callSid, { max: 128 })) {
        return res.status(400).json({ error: "Invalid call identifier" });
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }

      const requesterChatId = getRequesterChatId(req);
      if (isOwnedByDifferentChat(call, requesterChatId)) {
        return res.status(403).json({ error: "Not authorized for this call" });
      }

      const report =
        typeof db.getCallQualityReport === "function"
          ? await db.getCallQualityReport(callSid).catch(() => null)
          : null;
      return res.json({
        success: true,
        call_sid: callSid,
        qa: report,
      });
    } catch (error) {
      console.error("Error fetching call QA report:", error);
      return res.status(500).json({ error: "Failed to fetch call QA report" });
    }
  };
}

function createEvaluateCallQaHandler(ctx = {}) {
  const { isSafeId } = ctx;

  return async function handleEvaluateCallQa(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const { callSid } = req.params;
      if (!isSafeId(callSid, { max: 128 })) {
        return res.status(400).json({ error: "Invalid call identifier" });
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }

      const requesterChatId = getRequesterChatId(req);
      if (isOwnedByDifferentChat(call, requesterChatId)) {
        return res.status(403).json({ error: "Not authorized for this call" });
      }

      const transcripts = await db.getCallTranscripts(callSid).catch(() => []);
      const force = String(req.query?.force || "1").toLowerCase() !== "0";
      const evaluation = await runPostCallQaEvaluation({
        callSid,
        call,
        transcripts,
        durationSeconds: Number(call.duration) || 0,
        config: ctx.config || {},
        db,
        logger: console,
        force,
      });
      if (typeof db.updateCallState === "function") {
        const stateName =
          evaluation.status === "scored" || evaluation.status === "insufficient_transcript"
            ? "post_call_qa_scored"
            : "post_call_qa_skipped";
        await db
          .updateCallState(callSid, stateName, {
            status: evaluation.status,
            reason: evaluation.evaluation_reason || evaluation.reason || null,
            score: Number.isFinite(Number(evaluation.score))
              ? Number(evaluation.score)
              : null,
            passed: evaluation.passed === true,
            shadow_mode: evaluation.shadow_mode === true,
            persisted: evaluation.persisted === true,
            version: evaluation.version || null,
            evaluated_at: new Date().toISOString(),
          })
          .catch(() => {});
      }

      return res.json({
        success: true,
        call_sid: callSid,
        qa: evaluation,
      });
    } catch (error) {
      console.error("Error evaluating call QA report:", error);
      return res.status(500).json({ error: "Failed to evaluate call QA report" });
    }
  };
}

function createGetQaSummaryHandler(ctx = {}) {
  return async function handleGetQaSummary(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }
      if (typeof db.getCallQualitySummary !== "function") {
        return res.status(501).json({ error: "QA summary is not available" });
      }

      const hoursRaw = Number(req.query?.hours);
      const hours = Number.isFinite(hoursRaw)
        ? Math.max(1, Math.min(24 * 30, Math.floor(hoursRaw)))
        : 24 * 7;
      const topFindingsRaw = Number(req.query?.top_findings);
      const topFindingsLimit = Number.isFinite(topFindingsRaw)
        ? Math.max(3, Math.min(20, Math.floor(topFindingsRaw)))
        : 8;
      const lowScoreRaw = Number(req.query?.low_score_limit);
      const lowScoreLimit = Number.isFinite(lowScoreRaw)
        ? Math.max(3, Math.min(50, Math.floor(lowScoreRaw)))
        : 10;

      const summary = await db.getCallQualitySummary({
        hours,
        topFindingsLimit,
        lowScoreLimit,
      });
      const qaConfig = ctx.config?.postCallQa || {};
      const normalizeThreshold = (value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        return Math.max(0, Math.min(100, Number(numeric.toFixed(2))));
      };
      const profileThresholdsRaw =
        qaConfig.profileThresholds && typeof qaConfig.profileThresholds === "object"
          ? qaConfig.profileThresholds
          : {};
      const profileThresholds = {};
      for (const [rawProfile, rawThreshold] of Object.entries(profileThresholdsRaw)) {
        const profile = String(rawProfile || "")
          .trim()
          .toLowerCase()
          .replace(/[^\w-]+/g, "_");
        const threshold = normalizeThreshold(rawThreshold);
        if (!profile || threshold === null) continue;
        profileThresholds[profile] = threshold;
      }
      const defaultThreshold = normalizeThreshold(qaConfig.minScore);
      if (defaultThreshold !== null && !Object.prototype.hasOwnProperty.call(profileThresholds, "default")) {
        profileThresholds.default = defaultThreshold;
      }
      const enrichedSummary = {
        ...(summary && typeof summary === "object" ? summary : {}),
        profile_thresholds: profileThresholds,
        updated_at: new Date().toISOString(),
      };
      return res.json({
        success: true,
        summary: enrichedSummary,
      });
    } catch (error) {
      console.error("Error fetching QA summary:", error);
      return res.status(500).json({ error: "Failed to fetch QA summary" });
    }
  };
}

function createListCallsHandler(ctx = {}) {
  const { parsePagination, normalizeCallRecordForApi } = ctx;

  return async function handleListCalls(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({
          success: false,
          error: "Database unavailable",
        });
      }

      const { limit, offset } = parsePagination(req.query, {
        defaultLimit: 10,
        maxLimit: 50,
      });
      const requesterChatId = getRequesterChatId(req);

      console.log(`Fetching calls list: limit=${limit}, offset=${offset}`);

      const calls = await db.getRecentCalls({
        limit,
        offset,
        userChatId: requesterChatId || null,
      });
      const totalCount = await db.getCallsCount(requesterChatId || null);

      const formattedCalls = calls.map((call) => {
        const normalized = normalizeCallRecordForApi(call);
        return {
          ...normalized,
          transcript_count: call.transcript_count || 0,
          created_date: new Date(call.created_at).toLocaleDateString(),
          duration_formatted: call.duration
            ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, "0")}`
            : "N/A",
        };
      });

      return res.json({
        success: true,
        calls: formattedCalls,
        pagination: {
          total: totalCount,
          limit: limit,
          offset: offset,
          has_more: offset + limit < totalCount,
        },
        enhanced_features: true,
      });
    } catch (error) {
      console.error("Error fetching calls list:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch calls list",
        details: error.message,
      });
    }
  };
}

function createCallActivityHandlers(ctx = {}) {
  const getDb = () => typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
  const owner = (req) => String(req.callEActorId || "").trim();
  const readCall = async (req) => {
    const actorId = owner(req);
    const callSid = String(req.params?.callSid || "").trim();
    if (!actorId || !callSid || callSid.length > 200) return { error: "invalid" };
    const db = getDb();
    const call = await db?.getCall?.(callSid);
    if (!call) return { error: "not_found" };
    if (String(call.user_chat_id || "") !== actorId) return { error: "forbidden" };
    let created = typeof db.getLatestCallState === "function" ? await db.getLatestCallState(callSid, "call_created").catch(() => null) : null;
    if (typeof created === "string") { try { created = JSON.parse(created); } catch { created = {}; } }
    return { db, call, created: created || {}, actorId };
  };
  const maskPhone = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return digits ? `••••${digits.slice(-4)}` : null;
  };
  const project = (call, created = {}) => ({
    call_sid: call.call_sid,
    provider: String(created.telephony_provider || created.provider || call.telephony_provider || call.provider || "unknown").toLowerCase(),
    provider_call_id: (() => {
      const provider = String(created.telephony_provider || created.provider || call.telephony_provider || call.provider || "unknown").toLowerCase();
      const recorded = call.provider_call_id || created.provider_call_id || created.provider_metadata?.twilio_call_sid || created.provider_metadata?.plivo_uuid || created.provider_metadata?.vonage_uuid;
      if (recorded) return recorded;
      if (provider === "vapi" && String(call.call_sid || "").startsWith("vapi_")) return String(call.call_sid).slice(5);
      if (provider === "cartesia" && String(call.call_sid || "").startsWith("cartesia_")) return String(call.call_sid).slice(9);
      return null;
    })(),
    ai_voice_engine: call.ai_voice_engine || created.ai_voice_engine || null,
    phone_number: maskPhone(call.phone_number),
    status: call.status || "unknown",
    direction: call.direction || null,
    created_at: call.created_at || null,
    started_at: call.started_at || null,
    ended_at: call.ended_at || null,
    duration: Number(call.duration) || 0,
    business_id: call.business_id || created.business_id || null,
    refresh_available: Boolean(created.provider_call_id || created.provider_metadata?.twilio_call_sid || created.provider_metadata?.plivo_uuid || created.provider_metadata?.vonage_uuid ||
      ((String(created.telephony_provider || created.provider || call.provider || "").toLowerCase() === "vapi" && String(call.call_sid || "").startsWith("vapi_")) ||
       (String(created.telephony_provider || created.provider || call.provider || "").toLowerCase() === "cartesia" && String(call.call_sid || "").startsWith("cartesia_")))),
  });
  const normalizeProviderStatus = (provider, remote) => {
    const raw = String(remote?.status || remote?.call_status || remote?.state || "").trim().toLowerCase().replace(/_/g, "-");
    if (!raw) return "";
    if (raw === "created" || raw === "queued") return "queued";
    if (raw === "started" || raw === "answered" || raw === "in-progress") return "in-progress";
    if (raw === "ended") {
      const reason = String(remote?.endedReason || remote?.end_reason || "").toLowerCase();
      if (/no-answer|did-not-answer|timeout/.test(reason)) return "no-answer";
      if (/busy/.test(reason)) return "busy";
      if (/failed|error|rejected/.test(reason)) return "failed";
      return "completed";
    }
    if (["unanswered", "no-answer"].includes(raw)) return "no-answer";
    if (["rejected", "declined"].includes(raw)) return "failed";
    if (["hangup", "disconnected"].includes(raw)) return "completed";
    if (["ringing", "completed", "failed", "busy", "no-answer", "canceled", "cancelled", "voicemail"].includes(raw)) return raw === "cancelled" ? "canceled" : raw;
    if (provider === "cartesia" && raw === "starting") return "initiated";
    return raw.slice(0, 40);
  };
  const list = async (req, res) => {
    try {
      const actorId = owner(req);
      if (!actorId) return res.status(401).json({ success: false, error: "verified_actor_required" });
      const db = getDb();
      const limit = Math.max(1, Math.min(30, Number.parseInt(req.query?.limit, 10) || 10));
      const offset = Math.max(0, Math.min(1000, Number.parseInt(req.query?.offset, 10) || 0));
      const search = String(req.query?.q || "").trim().slice(0, 100);
      const status = String(req.query?.status || "").trim().toLowerCase().slice(0, 40);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.date || "")) ? String(req.query.date) : null;
      const dateStart = date ? new Date(`${date}T00:00:00.000Z`) : null;
      const dateEnd = date ? new Date(dateStart.getTime() + 24 * 60 * 60 * 1000) : null;
      if (date && (!Number.isFinite(dateStart.getTime()) || dateStart.toISOString().slice(0, 10) !== date)) return res.status(400).json({ success: false, error: "invalid_activity_date" });
      const calls = await db.getRecentCalls({ limit, offset, userChatId: actorId, query: search || null, status: status || null, start: dateStart?.toISOString() || null, end: dateEnd?.toISOString() || null });
      const rows = await Promise.all(calls.map(async (call) => {
        const state = typeof db.getLatestCallState === "function" ? await db.getLatestCallState(call.call_sid, "call_created").catch(() => null) : null;
        return project(call, typeof state === "string" ? (() => { try { return JSON.parse(state); } catch { return {}; } })() : state || {});
      }));
      return res.json({ success: true, calls: rows, pagination: { limit, offset, has_more: rows.length === limit } });
    } catch (error) {
      console.error("call_activity_list_failed", { code: String(error?.code || "database_error").slice(0, 80) });
      return res.status(500).json({ success: false, error: "call_activity_unavailable" });
    }
  };
  const detail = async (req, res) => {
    try {
      const result = await readCall(req);
      if (result.error === "invalid") return res.status(400).json({ success: false, error: "invalid_call_id" });
      if (result.error === "not_found") return res.status(404).json({ success: false, error: "call_not_found" });
      if (result.error) return res.status(403).json({ success: false, error: "not_authorized_for_call" });
      const states = await result.db.getCallStates(result.call.call_sid, { limit: 20 });
      const lifecycle_events = typeof result.db.listCallLifecycleEvents === "function"
        ? await result.db.listCallLifecycleEvents(result.call.call_sid, result.actorId, { limit: 20 })
        : [];
      const call = project(result.call, result.created);
      const recent_states = states.slice().reverse().map((state) => ({
        state: String(state.state || "event").slice(0, 80),
        timestamp: state.timestamp || null,
        sequence_number: Number(state.sequence_number) || null,
        data: state.data && typeof state.data === "object" ? {
          status: typeof state.data.status === "string" ? state.data.status.slice(0, 40) : undefined,
          provider_status: typeof state.data.provider_status === "string" ? state.data.provider_status.slice(0, 40) : undefined,
          source: typeof state.data.source === "string" ? state.data.source.slice(0, 40) : undefined,
        } : null,
      }));
      if (call.provider === "vapi" && typeof result.db.listVapiCallEvents === "function") {
        const events = await result.db.listVapiCallEvents({ provider_call_id: call.provider_call_id, limit: 20 });
        for (const event of events) recent_states.push({
          state: String(event.event_type || "provider_event").slice(0, 80),
          timestamp: event.event_timestamp || event.received_at || null,
          sequence_number: null,
          data: { provider_status: typeof event.provider_status === "string" ? event.provider_status.slice(0, 40) : undefined },
        });
        recent_states.sort((left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""));
        if (recent_states.length > 20) recent_states.splice(0, recent_states.length - 20);
      }
      return res.json({ success: true, call, lifecycle_events: lifecycle_events.map((event) => ({
        event_id: Number(event.event_id) || null,
        provider: event.provider || null,
        event_type: String(event.event_type || "event").slice(0, 80),
        status: event.status || null,
        provider_status: event.provider_status || null,
        source: String(event.source || "call_state").slice(0, 40),
        occurred_at: event.occurred_at || null,
      })), recent_states, retry_safe: false, retry_guidance: call.refresh_available
        ? "Status refresh only confirms provider state. Do not retry while a call may be active or accepted."
        : "No provider call ID is recorded. Reconcile with the provider first; absence of an ID is not proof that no call was placed." });
    } catch (error) {
      console.error("call_activity_detail_failed", { code: String(error?.code || "database_error").slice(0, 80) });
      return res.status(500).json({ success: false, error: "call_activity_unavailable" });
    }
  };
  const refresh = async (req, res, { reconcile = false } = {}) => {
    try {
      const result = await readCall(req);
      if (result.error === "invalid") return res.status(400).json({ success: false, error: "invalid_call_id" });
      if (result.error === "not_found") return res.status(404).json({ success: false, error: "call_not_found" });
      if (result.error) return res.status(403).json({ success: false, error: "not_authorized_for_call" });
      if (typeof ctx.getCallActivityStatus !== "function") return res.status(503).json({ success: false, error: "provider_status_refresh_unavailable" });
      const call = project(result.call, result.created);
      if (!call.refresh_available) return res.status(409).json({
        success: false,
        error: "provider_call_id_unavailable",
        reconciliation: reconcile ? { outcome: "unresolved", reason: "provider_call_id_unavailable" } : undefined,
        retry_safe: false,
        retry_guidance: "No provider call ID is recorded. A search by time or destination could match another call; verify with the provider and do not retry based only on this record.",
      });
      const remote = reconcile && call.provider === "vapi" && typeof ctx.reconcileVapiCallActivity === "function"
        ? await ctx.reconcileVapiCallActivity({ call, actorId: result.actorId })
        : await ctx.getCallActivityStatus({ call, actorId: result.actorId });
      const status = normalizeProviderStatus(call.provider, remote);
      if (!status || status.length > 40) return res.status(502).json({ success: false, error: "provider_status_invalid" });
      await result.db.updateCallStatus(call.call_sid, status, { allow_terminal_upgrade: true });
      await result.db.updateCallState(call.call_sid, reconcile ? "provider_call_reconciled" : "provider_status_refreshed", {
        provider: call.provider,
        status,
        source: reconcile ? "provider_reconciliation" : "provider_lookup",
        refreshed_at: new Date().toISOString(),
      });
      return res.json({
        success: true,
        call: { ...call, status },
        status_source: reconcile ? "provider_reconciliation" : "provider_lookup",
        ...(reconcile ? { reconciliation: { outcome: "reconciled", provider: call.provider } } : {}),
        retry_safe: false,
        retry_guidance: reconcile
          ? "Reconciliation only read provider state. A retry is not authorized by this result."
          : "Status refresh does not authorize a retry. Confirm no active or accepted call before placing another call.",
      });
    } catch (error) {
      const status = Number(error?.status || error?.statusCode);
      if (status === 404) return res.status(404).json({ success: false, error: "provider_call_not_found", retry_safe: false, retry_guidance: "A provider lookup miss is not proof that submission failed; wait and refresh again before considering another call." });
      console.error("call_activity_refresh_failed", { code: String(error?.code || "provider_lookup_failed").slice(0, 80) });
      return res.status(status >= 400 && status < 500 ? status : 502).json({ success: false, error: "provider_status_refresh_failed", retry_safe: false, retry_guidance: "Provider status could not be confirmed; do not retry until the outcome is verified." });
    }
  };
  const reconcile = (req, res) => refresh(req, res, { reconcile: true });
  return { list, detail, refresh, reconcile };
}

function getStatusIcon(status) {
  const icons = {
    completed: "✅",
    "no-answer": "📶",
    busy: "📞",
    failed: "❌",
    canceled: "🎫",
    "in-progress": "🔄",
    ringing: "📲",
  };
  return icons[status] || "❓";
}

function createListCallsFilteredHandler(ctx = {}) {
  const {
    parsePagination,
    normalizeCallStatus,
    normalizeDateFilter,
    normalizeCallRecordForApi,
  } = ctx;

  return async function handleListCallsFiltered(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({
          success: false,
          error: "Database unavailable",
        });
      }

      const { limit, offset } = parsePagination(req.query, {
        defaultLimit: 10,
        maxLimit: 50,
      });
      const status = req.query.status
        ? normalizeCallStatus(req.query.status)
        : null;
      const phone = req.query.phone;
      const dateFrom = normalizeDateFilter(req.query.date_from);
      const dateTo = normalizeDateFilter(req.query.date_to, true);
      const requesterChatId = getRequesterChatId(req);

      let whereClause = "";
      let queryParams = [];
      const conditions = [];

      if (status) {
        conditions.push("c.status = ?");
        queryParams.push(status);
      }

      if (phone) {
        conditions.push("c.phone_number LIKE ?");
        queryParams.push(`%${phone}%`);
      }

      if (dateFrom) {
        conditions.push("c.created_at >= ?");
        queryParams.push(dateFrom);
      }

      if (dateTo) {
        conditions.push("c.created_at <= ?");
        queryParams.push(dateTo);
      }
      if (requesterChatId) {
        conditions.push("c.user_chat_id = ?");
        queryParams.push(requesterChatId);
      }

      if (conditions.length > 0) {
        whereClause = "WHERE " + conditions.join(" AND ");
      }

      const query = `
        SELECT 
          c.*,
          COUNT(t.id) as transcript_count,
          GROUP_CONCAT(DISTINCT t.speaker) as speakers,
          MIN(t.timestamp) as conversation_start,
          MAX(t.timestamp) as conversation_end,
          (SELECT s.data FROM call_states s
           WHERE s.call_sid = c.call_sid AND s.state = 'call_created'
           ORDER BY s.timestamp DESC, s.id DESC LIMIT 1) as call_created_state,
          cr.provider as runtime_provider,
          co.provider_used as provider_used
        FROM calls c
        LEFT JOIN transcripts t ON c.call_sid = t.call_sid
        LEFT JOIN call_runtime_state cr ON cr.call_sid = c.call_sid
        LEFT JOIN call_outcomes co ON co.call_sid = c.call_sid
        ${whereClause}
        GROUP BY c.call_sid
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
      `;

      queryParams.push(limit, offset);

      const calls = await new Promise((resolve, reject) => {
        db.db.all(query, queryParams, (err, rows) => {
          if (err) {
            console.error("Database error in enhanced calls query:", err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        });
      });
      const callsWithDispositions =
        typeof db.attachLatestCallDispositions === "function"
          ? await db.attachLatestCallDispositions(calls)
          : calls;

      const countQuery = `SELECT COUNT(*) as count FROM calls c ${whereClause}`;
      const totalCount = await new Promise((resolve) => {
        db.db.get(countQuery, queryParams.slice(0, -2), (err, row) => {
          if (err) {
            console.error("Database error counting filtered calls:", err);
            resolve(0);
          } else {
            resolve(row?.count || 0);
          }
        });
      });

      const enhancedCalls = callsWithDispositions.map((call) => {
        const normalized = normalizeCallRecordForApi(call);
        const hasConversation =
          call.speakers &&
          call.speakers.includes("user") &&
          call.speakers.includes("ai");
        const conversationDuration =
          call.conversation_start && call.conversation_end
            ? Math.round(
                (new Date(call.conversation_end) -
                  new Date(call.conversation_start)) /
                  1000,
              )
            : 0;

        return {
          ...normalized,
          transcript_count: call.transcript_count || 0,
          has_conversation: hasConversation,
          conversation_duration: conversationDuration,
          generated_functions_count: Array.isArray(normalized.generated_functions)
            ? normalized.generated_functions.length
            : 0,
          created_date: new Date(call.created_at).toLocaleDateString(),
          created_time: new Date(call.created_at).toLocaleTimeString(),
          duration_formatted: call.duration
            ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, "0")}`
            : "N/A",
          status_icon: getStatusIcon(call.status),
          enhanced: true,
        };
      });

      return res.json({
        success: true,
        calls: enhancedCalls,
        filters: {
          status,
          phone,
          date_from: dateFrom,
          date_to: dateTo,
        },
        pagination: {
          total: totalCount,
          limit: limit,
          offset: offset,
          has_more: offset + limit < totalCount,
          current_page: Math.floor(offset / limit) + 1,
          total_pages: Math.ceil(totalCount / limit),
        },
        enhanced_features: true,
      });
    } catch (error) {
      console.error("Error in enhanced calls list:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch enhanced calls list",
        details: error.message,
      });
    }
  };
}

function createSearchCallsHandler(ctx = {}) {
  const { parseBoundedInteger, normalizeCallRecordForApi } = ctx;

  return async function handleSearchCalls(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db) {
        return res.status(500).json({
          success: false,
          error: "Database unavailable",
        });
      }

      const query = String(req.query.q || "").trim();
      const limit = parseBoundedInteger(req.query.limit, {
        defaultValue: 20,
        min: 1,
        max: 50,
      });
      const requesterChatId = getRequesterChatId(req);

      if (!query || query.length < 2) {
        return res.status(400).json({
          success: false,
          error: "Search query must be at least 2 characters",
        });
      }
      if (query.length > 120) {
        return res.status(400).json({
          success: false,
          error: "Search query must be 120 characters or less",
        });
      }

      const searchResults = await new Promise((resolve, reject) => {
        const searchQuery = `
          SELECT DISTINCT
            c.*,
            COUNT(t.id) as transcript_count,
            GROUP_CONCAT(t.message, ' ') as conversation_text,
            (SELECT s.data FROM call_states s
             WHERE s.call_sid = c.call_sid AND s.state = 'call_created'
             ORDER BY s.timestamp DESC, s.id DESC LIMIT 1) as call_created_state,
            cr.provider as runtime_provider,
            co.provider_used as provider_used
          FROM calls c
          LEFT JOIN transcripts t ON c.call_sid = t.call_sid
          LEFT JOIN call_runtime_state cr ON cr.call_sid = c.call_sid
          LEFT JOIN call_outcomes co ON co.call_sid = c.call_sid
          WHERE (
            c.phone_number LIKE ? OR
            c.call_summary LIKE ? OR
            c.prompt LIKE ? OR
            c.first_message LIKE ? OR
            t.message LIKE ?
          )${requesterChatId ? " AND c.user_chat_id = ?" : ""}
          GROUP BY c.call_sid
          ORDER BY c.created_at DESC
          LIMIT ?
        `;

        const searchTerm = `%${query}%`;
        const params = [
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
          searchTerm,
        ];
        if (requesterChatId) params.push(requesterChatId);
        params.push(limit);

        db.db.all(searchQuery, params, (err, rows) => {
          if (err) {
            console.error("Search query error:", err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        });
      });
      const searchResultsWithDispositions =
        typeof db.attachLatestCallDispositions === "function"
          ? await db.attachLatestCallDispositions(searchResults)
          : searchResults;

      const digitService =
        typeof ctx.getDigitService === "function"
          ? ctx.getDigitService()
          : ctx.digitService;
      const formattedResults = searchResultsWithDispositions.map((call) => {
        const normalized = normalizeCallRecordForApi(call);
        return {
          ...normalized,
          transcript_count: call.transcript_count || 0,
          matching_text: call.conversation_text
            ? `${digitService ? digitService.maskOtpForExternal(call.conversation_text) : call.conversation_text}`.substring(
                0,
                200,
              ) + "..."
            : null,
          created_date: new Date(call.created_at).toLocaleDateString(),
          duration_formatted: call.duration
            ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, "0")}`
            : "N/A",
        };
      });

      return res.json({
        success: true,
        query: query,
        results: formattedResults,
        result_count: formattedResults.length,
        enhanced_search: true,
      });
    } catch (error) {
      console.error("Error in call search:", error);
      return res.status(500).json({
        success: false,
        error: "Search failed",
        details: error.message,
      });
    }
  };
}

const CALLBACK_TASK_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
]);
const CALLBACK_TASK_MUTATION_STATUSES = new Set([
  "pending",
  "completed",
  "failed",
]);
const REVIEW_CASE_STATUSES = new Set([
  "open",
  "in_progress",
  "resolved",
  "closed",
]);

function sendRouteError(ctx, req, res, status, code, message, extra = null) {
  if (typeof ctx.sendApiError === "function") {
    return ctx.sendApiError(
      res,
      status,
      code,
      message,
      req.requestId || null,
      extra || undefined,
    );
  }
  return res.status(status).json({
    success: false,
    code,
    error: message,
    ...(extra && typeof extra === "object" ? extra : {}),
  });
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizeCallbackTask(job = {}) {
  const payload = parseJsonObject(job.payload) || {};
  return {
    id: job.id,
    type: job.job_type,
    status: job.status,
    run_at: job.run_at,
    attempts: Number(job.attempts) || 0,
    last_error: job.last_error || null,
    source_call_sid:
      payload.source_call_sid || payload.call_sid || payload.callSid || null,
    phone_number: payload.number || payload.phone_number || null,
    user_chat_id: payload.user_chat_id || null,
    created_at: job.created_at || null,
    updated_at: job.updated_at || null,
    completed_at: job.completed_at || null,
    payload,
  };
}

function normalizeReviewCase(reviewCase = {}) {
  return {
    id: reviewCase.id,
    call_sid: reviewCase.call_sid || null,
    phone_number: reviewCase.phone_number || null,
    requested_action: reviewCase.requested_action || null,
    reason: reviewCase.reason || null,
    notes: reviewCase.notes || null,
    source: reviewCase.source || null,
    status: reviewCase.status,
    created_by: reviewCase.created_by || null,
    metadata: parseJsonObject(reviewCase.metadata),
    created_at: reviewCase.created_at || null,
    updated_at: reviewCase.updated_at || null,
    resolved_at: reviewCase.resolved_at || null,
  };
}

function normalizePhoneNumber(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function resolveScheduledRunAt(rawRunAt, rawDelayMinutes, defaultDelayMinutes = 15) {
  const delayMinutesValue = Number(rawDelayMinutes);
  if (Number.isFinite(delayMinutesValue) && delayMinutesValue >= 0) {
    return new Date(Date.now() + delayMinutesValue * 60 * 1000).toISOString();
  }
  const runAt = String(rawRunAt || "").trim();
  if (runAt) {
    const parsed = new Date(runAt);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }
  return new Date(
    Date.now() + Math.max(0, Number(defaultDelayMinutes) || 15) * 60 * 1000,
  ).toISOString();
}

function maskCallDestination(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `•••${digits.slice(-4)}` : "unavailable";
}

function createCallOperationsHandler(ctx = {}) {
  return async function handleCallOperations(_req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.db) {
        return res.status(500).json({ success: false, error: "Database unavailable" });
      }

      const limit = 10;
      const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const activeStatusCondition =
        "LOWER(COALESCE(c.status, '')) NOT IN ('completed','voicemail','busy','failed','no-answer','no_answer','canceled','cancelled')";
      const activeStatusPredicate = `c.direction = 'outbound' AND ${activeStatusCondition}`;
      const failedStatusCondition =
        "LOWER(COALESCE(c.status, '')) IN ('failed','busy','no-answer','no_answer','canceled','cancelled')";
      const failedStatusPredicate = `c.direction = 'outbound' AND ${failedStatusCondition}`;
      const staleActivityPredicate =
        "julianday(COALESCE((SELECT MAX(s.timestamp) FROM call_states s WHERE s.call_sid = c.call_sid), c.started_at, c.created_at)) <= julianday(?)";
      const staleSubmissionPredicate =
        `LOWER(COALESCE(c.status, '')) = 'unknown' OR (LOWER(COALESCE(c.status, '')) = 'submission_pending' AND ${staleActivityPredicate})`;
      const loadCalls = (where, params = []) =>
        new Promise((resolve, reject) => {
          db.db.all(
            `SELECT c.call_sid, c.phone_number, c.status, c.created_at, c.started_at,
                    c.ended_at, c.duration, c.error_code,
                    cr.provider AS runtime_provider,
                    co.provider_used AS provider_used,
                    (SELECT s.data FROM call_states s
                     WHERE s.call_sid = c.call_sid AND s.state = 'call_created'
                     ORDER BY s.timestamp DESC, s.id DESC LIMIT 1) AS call_created_state,
                    (SELECT s.data FROM call_states s
                     WHERE s.call_sid = c.call_sid
                       AND s.state IN ('outbound_submission_uncertain', 'provider_submission_accepted', 'provider_metadata_updated', 'call_created')
                     ORDER BY s.sequence_number DESC LIMIT 1) AS provider_state_data,
                    (SELECT MAX(s.timestamp) FROM call_states s
                     WHERE s.call_sid = c.call_sid) AS last_event_at
             FROM calls c
             LEFT JOIN call_runtime_state cr ON cr.call_sid = c.call_sid
             LEFT JOIN call_outcomes co ON co.call_sid = c.call_sid
             WHERE c.direction = 'outbound' AND ${where}
             ORDER BY c.created_at DESC
             LIMIT ?`,
            [...params, limit],
            (error, rows) => (error ? reject(error) : resolve(rows || [])),
          );
        });
      const [active, stale, failures, unknownSubmissions, notifications, webhookErrors] = await Promise.all([
        loadCalls(activeStatusCondition),
        loadCalls(
          `${activeStatusCondition} AND ${staleActivityPredicate}`,
          [staleCutoff],
        ),
        loadCalls(
          `${failedStatusCondition} AND julianday(c.created_at) >= julianday(?)`,
          [dayCutoff],
        ),
        loadCalls(`(${staleSubmissionPredicate})`, [staleCutoff]),
        new Promise((resolve, reject) => {
          db.db.all(
            `SELECT status, COUNT(*) AS count
             FROM webhook_notifications
             WHERE status IN ('pending', 'retrying', 'failed')
             GROUP BY status`,
            (error, rows) => (error ? reject(error) : resolve(rows || [])),
          );
        }),
        new Promise((resolve, reject) => {
          db.db.get(
            `SELECT COUNT(*) AS count, MAX(timestamp) AS latest_at
             FROM service_health_logs
             WHERE service_name = 'webhook_system' AND status = 'error'
               AND julianday(timestamp) >= julianday(?)`,
            [dayCutoff],
            (error, row) => (error ? reject(error) : resolve(row || { count: 0 })),
          );
        }),
      ]);

      const [activeCount, staleCount, failureCount, unknownSubmissionCount, activeProviders] = await Promise.all([
        new Promise((resolve, reject) => {
          db.db.get(
            `SELECT COUNT(*) AS count FROM calls c WHERE ${activeStatusPredicate}`,
            (error, row) => (error ? reject(error) : resolve(Number(row?.count) || 0)),
          );
        }),
        new Promise((resolve, reject) => {
          db.db.get(
            `SELECT COUNT(*) AS count FROM calls c
             WHERE ${activeStatusPredicate} AND ${staleActivityPredicate}`,
            [staleCutoff],
            (error, row) => (error ? reject(error) : resolve(Number(row?.count) || 0)),
          );
        }),
        new Promise((resolve, reject) => {
          db.db.get(
            `SELECT COUNT(*) AS count FROM calls c
             WHERE ${failedStatusPredicate} AND julianday(c.created_at) >= julianday(?)`,
            [dayCutoff],
            (error, row) => (error ? reject(error) : resolve(Number(row?.count) || 0)),
          );
        }),
        new Promise((resolve, reject) => {
          db.db.get(
            `SELECT COUNT(*) AS count FROM calls c
             WHERE c.direction = 'outbound' AND (${staleSubmissionPredicate})`,
            [staleCutoff],
            (error, row) => (error ? reject(error) : resolve(Number(row?.count) || 0)),
          );
        }),
        new Promise((resolve, reject) => {
          db.db.all(
            `SELECT COALESCE(cr.provider, co.provider_used, 'unknown') AS provider,
                    COUNT(*) AS count
             FROM calls c
             LEFT JOIN call_runtime_state cr ON cr.call_sid = c.call_sid
             LEFT JOIN call_outcomes co ON co.call_sid = c.call_sid
             WHERE ${activeStatusPredicate}
             GROUP BY provider ORDER BY count DESC`,
            (error, rows) => (error ? reject(error) : resolve(rows || [])),
          );
        }),
      ]);

      const normalizeRow = (row) => {
        let createdState = {};
        let providerState = {};
        try {
          createdState =
            typeof row.call_created_state === "string"
              ? JSON.parse(row.call_created_state)
              : row.call_created_state || {};
        } catch (_) {
          createdState = {};
        }
        try {
          providerState =
            typeof row.provider_state_data === "string"
              ? JSON.parse(row.provider_state_data)
              : row.provider_state_data || {};
        } catch (_) {
          providerState = {};
        }
        const providerMetadata =
          providerState.provider_metadata && typeof providerState.provider_metadata === "object"
            ? providerState.provider_metadata
            : {};
        return {
          call_sid: row.call_sid,
          destination: maskCallDestination(row.phone_number),
          status: row.status || "unknown",
          telephony_provider:
            row.runtime_provider ||
            row.provider_used ||
            providerState.provider ||
            createdState.provider ||
            null,
          provider_call_id:
            providerState.provider_call_id ||
            providerMetadata.provider_call_id ||
            providerMetadata.twilio_call_sid ||
            providerMetadata.plivo_call_id ||
            providerMetadata.vonage_uuid ||
            null,
          ai_voice_engine: createdState.ai_voice_engine || null,
          created_at: row.created_at || null,
          last_event_at: row.last_event_at || row.created_at || null,
          started_at: row.started_at || null,
          ended_at: row.ended_at || null,
          duration: Number.isFinite(Number(row.duration)) ? Number(row.duration) : null,
          error_code: row.error_code || null,
        };
      };
      const notificationCounts = Object.fromEntries(
        notifications.map((row) => [row.status, Number(row.count) || 0]),
      );
      const activeCalls = active.map(normalizeRow);
      const providerActive = Object.fromEntries(
        activeProviders.map((row) => [row.provider, Number(row.count) || 0]),
      );

      // One administrator-only, provider-neutral activity feed. Keep source
      // records separate and expose only masked destinations and status data.
      const providerCallGroups = await Promise.all([
        new Promise((resolve, reject) => db.db.all(
          `SELECT c.call_sid, c.phone_number, c.status, c.created_at,
                  COALESCE(cr.provider, co.provider_used, 'unknown') AS provider
           FROM calls c
           LEFT JOIN call_runtime_state cr ON cr.call_sid = c.call_sid
           LEFT JOIN call_outcomes co ON co.call_sid = c.call_sid
           WHERE c.direction = 'outbound' ORDER BY c.created_at DESC LIMIT 20`,
          (error, rows) => error ? reject(error) : resolve((rows || []).map((row) => ({
            call_sid: row.call_sid, provider_call_id: null, destination: maskCallDestination(row.phone_number),
            status: row.status || 'unknown', telephony_provider: row.provider,
            created_at: row.created_at || null,
          }))),
        )),
        new Promise((resolve, reject) => db.db.all(
          `SELECT e.provider_call_id, e.provider_status, e.event_type, e.event_timestamp, e.received_at
           FROM vapi_call_events e
           WHERE e.id = (SELECT MAX(latest.id) FROM vapi_call_events latest WHERE latest.provider_call_id = e.provider_call_id)
           ORDER BY COALESCE(e.event_timestamp, e.received_at) DESC LIMIT 20`,
          (error, rows) => error ? reject(error) : resolve((rows || []).map((row) => ({
            call_sid: row.provider_call_id, provider_call_id: row.provider_call_id, destination: null,
            status: row.provider_status || row.event_type || 'unknown', telephony_provider: 'vapi',
            created_at: row.event_timestamp || row.received_at || null,
          }))),
        )),
        new Promise((resolve, reject) => db.db.all(
          `SELECT provider_call_id, phone_number, status, COALESCE(start_time, created_at) AS created_at
           FROM cartesia_calls WHERE direction = 'outbound' ORDER BY created_at DESC LIMIT 20`,
          (error, rows) => error ? reject(error) : resolve((rows || []).map((row) => ({
            call_sid: row.provider_call_id, provider_call_id: row.provider_call_id,
            destination: maskCallDestination(row.phone_number), status: row.status || 'unknown',
            telephony_provider: 'cartesia', created_at: row.created_at || null,
          }))),
        )),
      ]);
      const directCallIds = new Set(providerCallGroups[0].map((call) => String(call.call_sid || '')));
      const recentProviderCalls = [
        ...providerCallGroups[0],
        ...providerCallGroups[1],
        ...providerCallGroups[2].filter((call) => !directCallIds.has(`cartesia_${call.provider_call_id}`)),
      ].sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0)).slice(0, 20);

      return res.json({
        success: true,
        generated_at: new Date().toISOString(),
        counts: {
          active: activeCount,
          stale: staleCount,
          recent_failures: failureCount,
          unknown_submissions: unknownSubmissionCount,
        },
        active_calls: activeCalls,
        recent_provider_calls: recentProviderCalls,
        stale_calls: stale.map(normalizeRow),
        recent_failures: failures.map(normalizeRow),
        unknown_submissions: unknownSubmissions.map(normalizeRow),
        active_by_provider: providerActive,
        notification_delivery: {
          pending: notificationCounts.pending || 0,
          retrying: notificationCounts.retrying || 0,
          failed: notificationCounts.failed || 0,
        },
        webhook_processing_errors_24h: {
          count: Number(webhookErrors.count) || 0,
          latest_at: webhookErrors.latest_at || null,
        },
      });
    } catch (error) {
      console.error("Error fetching call operations summary:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to fetch call operations summary",
      });
    }
  };
}

function createListCallbackTasksHandler(ctx = {}) {
  const { parseBoundedInteger } = ctx;

  return async function handleListCallbackTasks(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.listCallJobs) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "database_unavailable",
          "Database unavailable",
        );
      }
      const status = String(req.query?.status || "")
        .trim()
        .toLowerCase();
      if (status && !CALLBACK_TASK_STATUSES.has(status)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid callback task status",
        );
      }
      const limit = parseBoundedInteger(req.query?.limit, {
        defaultValue: 20,
        min: 1,
        max: 100,
      });
      const jobs = await db.listCallJobs({
        job_type: "callback_call",
        status: status || null,
        limit,
      });
      return res.json({
        success: true,
        callback_tasks: jobs.map(normalizeCallbackTask),
      });
    } catch (error) {
      console.error("Error listing callback tasks:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "callback_tasks_list_failed",
        "Failed to list callback tasks",
      );
    }
  };
}

function createCreateCallbackTaskHandler(ctx = {}) {
  const { isSafeId, buildCallbackPayload, scheduleCallJob, config } = ctx;

  return async function handleCreateCallbackTask(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.getCall || !scheduleCallJob) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "callback_tasks_unavailable",
          "Callback task scheduling unavailable",
        );
      }

      const callSid = String(req.body?.call_sid || "").trim();
      if (!callSid) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "call_sid is required",
        );
      }
      if (typeof isSafeId === "function" && !isSafeId(callSid)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid call_sid",
        );
      }

      const call = await db.getCall(callSid);
      if (!call) {
        return sendRouteError(
          ctx,
          req,
          res,
          404,
          "call_not_found",
          "Call not found",
        );
      }
      const callState = await db
        .getLatestCallState?.(callSid, "call_created")
        .catch(() => null);
      const payloadBuilder =
        typeof buildCallbackPayload === "function"
          ? buildCallbackPayload(call, callState)
          : {
              number: call.phone_number,
              prompt: call.prompt || null,
              first_message: call.first_message || null,
              user_chat_id: call.user_chat_id || null,
            };
      const payload = {
        ...payloadBuilder,
        source_call_sid: callSid,
      };
      if (!payload.number || !/^\+[1-9]\d{1,14}$/.test(String(payload.number))) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "invalid_phone_number",
          "Call does not have a valid E.164 phone number",
        );
      }

      const defaultDelayMinutes = Number(config?.inbound?.callbackDelayMinutes) || 15;
      const runAt = resolveScheduledRunAt(
        req.body?.run_at,
        req.body?.delay_minutes,
        defaultDelayMinutes,
      );
      if (!runAt) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "run_at must be a valid timestamp",
        );
      }

      const taskId = await scheduleCallJob("callback_call", payload, runAt);
      await db
        .updateCallState?.(callSid, "callback_scheduled", {
          run_at: runAt,
          source: "api",
          callback_task_id: taskId,
        })
        .catch(() => null);
      const job = await db.getCallJob?.(taskId);
      return res.status(201).json({
        success: true,
        callback_task: normalizeCallbackTask(
          job || {
            id: taskId,
            job_type: "callback_call",
            status: "pending",
            run_at: runAt,
            payload: JSON.stringify(payload),
          },
        ),
      });
    } catch (error) {
      console.error("Error creating callback task:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "callback_task_create_failed",
        "Failed to create callback task",
      );
    }
  };
}

function createUpdateCallbackTaskStatusHandler(ctx = {}) {
  const { parseBoundedInteger } = ctx;

  return async function handleUpdateCallbackTaskStatus(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.getCallJob) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "callback_tasks_unavailable",
          "Callback task status updates unavailable",
        );
      }
      const taskId = parseBoundedInteger(req.params?.taskId, {
        defaultValue: NaN,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!Number.isFinite(taskId)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid callback task id",
        );
      }
      const job = await db.getCallJob(taskId);
      if (!job || job.job_type !== "callback_call") {
        return sendRouteError(
          ctx,
          req,
          res,
          404,
          "callback_task_not_found",
          "Callback task not found",
        );
      }
      const status = String(req.body?.status || "")
        .trim()
        .toLowerCase();
      if (!CALLBACK_TASK_MUTATION_STATUSES.has(status)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "status must be pending, completed, or failed",
        );
      }
      if (status === "pending") {
        const runAtInputProvided =
          req.body?.run_at !== undefined || req.body?.delay_minutes !== undefined;
        if (!runAtInputProvided) {
          return sendRouteError(
            ctx,
            req,
            res,
            400,
            "validation_error",
            "run_at or delay_minutes is required when setting status to pending",
          );
        }
        const runAt = resolveScheduledRunAt(
          req.body?.run_at,
          req.body?.delay_minutes,
          0,
        );
        if (!runAt) {
          return sendRouteError(
            ctx,
            req,
            res,
            400,
            "validation_error",
            "run_at must be a valid timestamp",
          );
        }
        await db.rescheduleCallJob(taskId, runAt, req.body?.error || null);
      } else {
        await db.completeCallJob(taskId, status, req.body?.error || null);
      }
      const updated = await db.getCallJob(taskId);
      return res.json({
        success: true,
        callback_task: normalizeCallbackTask(updated),
      });
    } catch (error) {
      console.error("Error updating callback task status:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "callback_task_update_failed",
        "Failed to update callback task status",
      );
    }
  };
}

function createListReviewCasesHandler(ctx = {}) {
  const { parseBoundedInteger } = ctx;

  return async function handleListReviewCases(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.listReviewCases) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "review_cases_unavailable",
          "Review case listing unavailable",
        );
      }
      const status = String(req.query?.status || "")
        .trim()
        .toLowerCase();
      if (status && !REVIEW_CASE_STATUSES.has(status)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid review case status",
        );
      }
      const limit = parseBoundedInteger(req.query?.limit, {
        defaultValue: 20,
        min: 1,
        max: 100,
      });
      const reviewCases = await db.listReviewCases({
        status: status || null,
        limit,
      });
      return res.json({
        success: true,
        review_cases: reviewCases.map(normalizeReviewCase),
      });
    } catch (error) {
      console.error("Error listing review cases:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "review_cases_list_failed",
        "Failed to list review cases",
      );
    }
  };
}

function createCreateReviewCaseHandler(ctx = {}) {
  const { isSafeId } = ctx;

  return async function handleCreateReviewCase(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.createReviewCase) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "review_cases_unavailable",
          "Review case creation unavailable",
        );
      }
      const callSid = String(req.body?.call_sid || "").trim();
      const requestedAction =
        String(req.body?.requested_action || "review_case").trim() ||
        "review_case";
      let phoneNumber = normalizePhoneNumber(req.body?.phone_number);
      if (!callSid && !phoneNumber) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "call_sid or phone_number is required",
        );
      }
      if (callSid && typeof isSafeId === "function" && !isSafeId(callSid)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid call_sid",
        );
      }
      let call = null;
      if (callSid) {
        call = await db.getCall?.(callSid);
        if (!call) {
          return sendRouteError(
            ctx,
            req,
            res,
            404,
            "call_not_found",
            "Call not found",
          );
        }
        if (!phoneNumber) {
          phoneNumber = normalizePhoneNumber(call.phone_number);
        }
      }
      if (phoneNumber && !/^\+[1-9]\d{1,14}$/.test(phoneNumber)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "invalid_phone_number",
          "phone_number must use E.164 format",
        );
      }
      const createdBy = String(req.headers?.["x-telegram-chat-id"] || "")
        .trim()
        || null;
      const reviewCaseId = await db.createReviewCase({
        call_sid: callSid || null,
        phone_number: phoneNumber || null,
        requested_action: requestedAction,
        reason: req.body?.reason || null,
        notes: req.body?.notes || null,
        source: req.body?.source || "api",
        created_by: createdBy,
        metadata:
          req.body?.metadata && typeof req.body.metadata === "object"
            ? req.body.metadata
            : null,
      });
      if (callSid) {
        await db
          .updateCallState?.(callSid, "review_case_requested", {
            at: new Date().toISOString(),
            source: "api",
            requested_action: requestedAction,
            review_case_id: reviewCaseId,
          })
          .catch(() => null);
      }
      const reviewCase = await db.getReviewCase?.(reviewCaseId);
      return res.status(201).json({
        success: true,
        review_case: normalizeReviewCase(
          reviewCase || {
            id: reviewCaseId,
            call_sid: callSid || null,
            phone_number: phoneNumber || null,
            requested_action: requestedAction,
            reason: req.body?.reason || null,
            notes: req.body?.notes || null,
            source: req.body?.source || "api",
            status: "open",
            created_by: createdBy,
            metadata:
              req.body?.metadata && typeof req.body.metadata === "object"
                ? JSON.stringify(req.body.metadata)
                : null,
          },
        ),
      });
    } catch (error) {
      console.error("Error creating review case:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "review_case_create_failed",
        "Failed to create review case",
      );
    }
  };
}

function createUpdateReviewCaseStatusHandler(ctx = {}) {
  const { parseBoundedInteger } = ctx;

  return async function handleUpdateReviewCaseStatus(req, res) {
    try {
      const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
      if (!db?.getReviewCase || !db?.updateReviewCaseStatus) {
        return sendRouteError(
          ctx,
          req,
          res,
          500,
          "review_cases_unavailable",
          "Review case status updates unavailable",
        );
      }
      const reviewCaseId = parseBoundedInteger(req.params?.caseId, {
        defaultValue: NaN,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!Number.isFinite(reviewCaseId)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "Invalid review case id",
        );
      }
      const reviewCase = await db.getReviewCase(reviewCaseId);
      if (!reviewCase) {
        return sendRouteError(
          ctx,
          req,
          res,
          404,
          "review_case_not_found",
          "Review case not found",
        );
      }
      const status = String(req.body?.status || "")
        .trim()
        .toLowerCase();
      if (!REVIEW_CASE_STATUSES.has(status)) {
        return sendRouteError(
          ctx,
          req,
          res,
          400,
          "validation_error",
          "status must be open, in_progress, resolved, or closed",
        );
      }
      await db.updateReviewCaseStatus(reviewCaseId, status, {
        notes: req.body?.notes || null,
        metadata:
          req.body?.metadata && typeof req.body.metadata === "object"
            ? req.body.metadata
            : undefined,
      });
      const updated = await db.getReviewCase(reviewCaseId);
      return res.json({
        success: true,
        review_case: normalizeReviewCase(updated),
      });
    } catch (error) {
      console.error("Error updating review case status:", error);
      return sendRouteError(
        ctx,
        req,
        res,
        500,
        "review_case_update_failed",
        "Failed to update review case status",
      );
    }
  };
}

function registerCallRoutes(app, ctx = {}) {
  const requireOutboundAuthorization =
    typeof ctx.requireOutboundAuthorization === "function"
      ? ctx.requireOutboundAuthorization
      : (_req, _res, next) => next();
  const requireAdminToken =
    typeof ctx.requireAdminToken === "function"
      ? ctx.requireAdminToken
      : requireOutboundAuthorization;
  const requireCallEActorAssertion = typeof ctx.requireCallEActorAssertion === "function"
    ? ctx.requireCallEActorAssertion
    : (_req, _res, next) => next();
  const cartesiaApprovalLimiter = typeof ctx.cartesiaApprovalLimiter === "function"
    ? ctx.cartesiaApprovalLimiter
    : (_req, _res, next) => next();
  const handleOutboundCall = createOutboundCallHandler(ctx);
  const handleGetCallDetails = createGetCallDetailsHandler(ctx);
  const callActivity = createCallActivityHandlers(ctx);
  const handleGetTranscriptAudio = createGetTranscriptAudioHandler(ctx);
  const handleListCalls = createListCallsHandler(ctx);
  const handleListCallsFiltered = createListCallsFilteredHandler(ctx);
  const handleSearchCalls = createSearchCallsHandler(ctx);
  const handleCallOperations = createCallOperationsHandler(ctx);
  const handleListCallbackTasks = createListCallbackTasksHandler(ctx);
  const handleCreateCallbackTask = createCreateCallbackTaskHandler(ctx);
  const handleUpdateCallbackTaskStatus =
    createUpdateCallbackTaskStatusHandler(ctx);
  const handleListReviewCases = createListReviewCasesHandler(ctx);
  const handleCreateReviewCase = createCreateReviewCaseHandler(ctx);
  const handleUpdateReviewCaseStatus =
    createUpdateReviewCaseStatusHandler(ctx);
  const handleGetCallQa = createGetCallQaHandler(ctx);
  const handleEvaluateCallQa = createEvaluateCallQaHandler(ctx);
  const handleGetQaSummary = createGetQaSummaryHandler(ctx);

  app.post(
    "/outbound-call",
    requireOutboundAuthorization,
    requireCallEActorAssertion,
    handleOutboundCall,
  );
  app.get(
    "/api/calls/operations",
    requireAdminToken,
    handleCallOperations,
  );
  app.get("/api/cartesia/call-readiness", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.getCartesiaCallReadiness !== "function") return res.json({ success: true, enabled: false, reason: "cartesia_not_configured" });
      const result = await ctx.getCartesiaCallReadiness();
      return res.json({ success: true, enabled: result?.enabled === true, reason: result?.enabled === true ? null : result?.code || "cartesia_not_configured" });
    } catch {
      return res.json({ success: true, enabled: false, reason: "cartesia_not_configured" });
    }
  });
  app.get("/api/cartesia/provider-defaults", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.getCartesiaCallDefaults !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_call_defaults_unavailable", "Cartesia call defaults are unavailable");
      }
      const defaults = await ctx.getCartesiaCallDefaults({
        business_id: req.query?.business_id,
        actor_id: req.callEActorId,
      });
      return res.json({
        success: true,
        profile: {
          business_id: String(req.query?.business_id || "").trim(),
          agent_id: defaults.agentId,
          from_number_id: defaults.fromNumberId,
        },
      });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_defaults_failed");
      const status = Number(error?.status) || (code.includes("operator") ? 403 : code.includes("scope_invalid") ? 400 : 503);
      console.error("cartesia_call_defaults_read_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia call defaults could not be loaded" : error.message);
    }
  });
  app.post("/api/cartesia/provider-defaults", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Only Cartesia administrators may update call defaults");
      }
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const allowedFields = new Set(["business_id", "agent_id", "from_number_id"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        return sendRouteError(ctx, req, res, 400, "cartesia_call_defaults_invalid", "Cartesia call defaults contain unsupported fields");
      }
      if (typeof ctx.setCartesiaCallDefaults !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_call_defaults_unavailable", "Cartesia call defaults are unavailable");
      }
      const defaults = await ctx.setCartesiaCallDefaults({
        business_id: body.business_id,
        actor_id: req.callEActorId,
        agent_id: body.agent_id,
        from_number_id: body.from_number_id,
      });
      return res.json({
        success: true,
        profile: {
          business_id: String(body.business_id || "").trim(),
          agent_id: defaults.agentId,
          from_number_id: defaults.fromNumberId,
        },
      });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_defaults_failed");
      const status = Number(error?.status) || (
        code.includes("operator") ? 403
          : code.includes("scope_invalid") || code.includes("invalid") ? 400
            : code.includes("conflict") || code.includes("not_ready") ? 409
              : 503
      );
      console.error("cartesia_call_defaults_write_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia call defaults could not be saved" : error.message);
    }
  });
  app.post("/api/cartesia/call-approval", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const allowedFields = new Set(["business_id", "destination", "agent_id", "from_number_id", "idempotency_key", "dynamic_variables", "confirmation_phrase"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) return sendRouteError(ctx, req, res, 400, "cartesia_call_approval_invalid", "Cartesia call approval contains unsupported fields");
      if (typeof ctx.createCartesiaCallApproval !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia Managed Agent calling is unavailable");
      const approval = await ctx.createCartesiaCallApproval({ ...body, actor_id: req.callEActorId });
      return res.json({ success: true, approval_token: approval.approvalToken, request_fingerprint: approval.requestFingerprint, expires_at: approval.expiresAt });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_approval_failed");
      const status = Number(error?.status) || (code.includes("not_configured") || code.includes("unavailable") ? 503
        : code.includes("operator") ? 403
          : code.includes("invalid") || code.includes("required") ? 400
            : code.includes("conflict") || code.includes("not_ready") ? 409 : 502);
      console.error("cartesia_call_approval_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia Managed Agent call approval failed" : error.message);
    }
  });
  app.get("/api/cartesia/agents", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia agent inventory is restricted to administrators");
      }
      if (typeof ctx.listCartesiaAgents !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia agent inventory is unavailable");
      }
      const agents = await ctx.listCartesiaAgents();
      return res.json({ success: true, agents });
    } catch (error) {
      const code = String(error?.code || "cartesia_agent_list_failed");
      const status = Number(error?.status) || (
        code.includes("not_configured") ? 503
          : code.includes("invalid") ? 502
            : 502
      );
      console.error("cartesia_agent_list_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, "Cartesia agent inventory could not be loaded");
    }
  });
  app.get("/api/cartesia/agents/:agentId/health", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia agent health is restricted to administrators");
      }
      if (typeof ctx.getCartesiaAgentDeploymentHealth !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia agent health is unavailable");
      }
      const health = await ctx.getCartesiaAgentDeploymentHealth({ agent_id: req.params?.agentId, actor_id: req.callEActorId });
      return res.json({ success: true, ...health });
    } catch (error) {
      const code = String(error?.code || "cartesia_agent_health_failed");
      const status = Number(error?.status) || (code.includes("invalid") ? 400 : code.includes("not_configured") ? 503 : code.includes("not_found") ? 404 : 502);
      console.error("cartesia_agent_health_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia agent health could not be loaded" : error.message);
    }
  });
  app.post("/api/cartesia/campaigns", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      }
      return sendRouteError(ctx, req, res, 409, "cartesia_is_ai_capability",
        "Cartesia campaign dialing is retired. Start calls through /call using the selected telephony provider.");
    } catch (error) {
      return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
    }
  });
  app.get("/api/cartesia/campaigns/:campaignId", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      }
      if (typeof ctx.getCartesiaCampaign !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_campaign_unavailable", "Cartesia campaign status is unavailable");
      }
      const result = await ctx.getCartesiaCampaign({ campaign_id: req.params?.campaignId, business_id: req.query?.business_id, actor_id: req.callEActorId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = String(error?.code || "cartesia_campaign_status_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("operator") ? 403 : code.includes("invalid") || code.includes("required") ? 400 : 502);
      console.error("cartesia_campaign_status_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia campaign status could not be loaded" : error.message);
    }
  });
  app.post("/api/cartesia/campaigns/:campaignId/reconcile", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      if (typeof ctx.reconcileCartesiaCampaign !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_campaign_unavailable", "Cartesia batch reconciliation is unavailable");
      const result = await ctx.reconcileCartesiaCampaign({ campaign_id: req.params?.campaignId, business_id: req.body?.business_id, actor_id: req.callEActorId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = String(error?.code || "cartesia_campaign_reconcile_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("operator") ? 403 : code.includes("invalid") ? 400 : code.includes("unresolved") || code.includes("mismatch") ? 409 : 502);
      console.error("cartesia_campaign_reconcile_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia batch reconciliation could not be confirmed" : error.message);
    }
  });
  app.post("/api/cartesia/campaigns/:campaignId/cancel", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      if (typeof ctx.cancelCartesiaCampaignBatch !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_campaign_unavailable", "Cartesia batch cancellation is unavailable");
      const result = await ctx.cancelCartesiaCampaignBatch({ ...req.body, campaign_id: req.params?.campaignId, actor_id: req.callEActorId });
      return res.json({ success: true, campaign: result });
    } catch (error) {
      const code = String(error?.code || "cartesia_campaign_cancel_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("operator") ? 403 : code.includes("invalid") || code.includes("confirmation") ? 400 : code.includes("conflict") || code.includes("mismatch") || code.includes("not_cancellable") ? 409 : 502);
      console.error("cartesia_campaign_cancel_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia batch cancellation could not be confirmed" : error.message);
    }
  });
  app.post("/api/cartesia/campaigns/:campaignId/retry", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      return sendRouteError(ctx, req, res, 409, "cartesia_is_ai_capability",
        "Cartesia batch retries are retired. Start calls through /call using the selected telephony provider.");
    } catch (error) {
      return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
    }
  });
  app.post("/api/cartesia/campaigns/:campaignId/submit", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
      }
      return sendRouteError(ctx, req, res, 409, "cartesia_is_ai_capability",
        "Cartesia campaign dialing is retired. Start calls through /call using the selected telephony provider.");
    } catch (error) {
      return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia campaigns are restricted to administrators");
    }
  });
  app.get("/api/cartesia/calls", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call operations are restricted to administrators");
      }
      if (typeof ctx.listCartesiaCalls !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call history is unavailable");
      }
      const result = await ctx.listCartesiaCalls({
        agentId: String(req.query?.agent_id || "").trim(),
        businessId: String(req.query?.business_id || "").trim(),
        actorId: req.callEActorId,
        startTimeGte: String(req.query?.start_time_gte || "").trim(),
        startTimeLte: String(req.query?.start_time_lte || "").trim(),
        startingAfter: String(req.query?.starting_after || "").trim(),
        reviewQueue: String(req.query?.review_queue || "").toLowerCase() === "true",
        limit: req.query?.limit,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_list_failed");
      const status = Number(error?.status) || (code.includes("invalid") || code.includes("scope_required") ? 400 : code.includes("operator") ? 403 : code.includes("not_configured") || code.includes("dependencies_missing") ? 503 : 502);
      console.error("cartesia_call_list_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status === 502 ? "Cartesia call history could not be loaded" : error.message);
    }
  });
  app.get("/api/cartesia/calls/:callId", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call operations are restricted to administrators");
      }
      if (typeof ctx.getCartesiaCall !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call details are unavailable");
      }
      const includeTranscript = String(req.query?.include_transcript || "").toLowerCase() === "true";
      const call = await ctx.getCartesiaCall(req.params?.callId, {
        businessId: req.query?.business_id, actorId: req.callEActorId, includeReviewDetails: true, includeTranscript,
      });
      return res.json({ success: true, call });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_lookup_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("invalid") || code.includes("scope_required") ? 400 : code.includes("operator") ? 403 : code.includes("not_configured") || code.includes("dependencies_missing") ? 503 : 502);
      console.error("cartesia_call_lookup_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status === 502 ? "Cartesia call details could not be loaded" : error.message);
    }
  });
  app.get("/api/cartesia/calls/:callId/audio", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call recordings are restricted to administrators");
      }
      if (typeof ctx.getCartesiaCallAudio !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call recordings are unavailable");
      const result = await ctx.getCartesiaCallAudio(req.params?.callId, { businessId: req.query?.business_id, actorId: req.callEActorId });
      res.set("Cache-Control", "private, no-store");
      res.set("Content-Disposition", `attachment; filename="cartesia-call-${String(req.params?.callId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.wav"`);
      return res.type(result.contentType || "audio/wav").send(result.bytes);
    } catch (error) {
      const code = String(error?.code || "cartesia_call_audio_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("invalid") || code.includes("scope_required") ? 400 : code.includes("operator") ? 403 : code.includes("unavailable") ? 409 : code.includes("not_configured") || code.includes("dependencies_missing") ? 503 : 502);
      console.error("cartesia_call_audio_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia call recording could not be loaded" : error.message);
    }
  });
  app.post("/api/cartesia/calls/:callId/redact", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    const callId = String(req.params?.callId || "");
    if (String(req.body?.confirmation_phrase || "") !== `DELETE CARTESIA CALL DATA ${callId} CONSENT WITHDRAWN`) {
      return sendRouteError(ctx, req, res, 400, "cartesia_call_redaction_confirmation_required", "An exact call-specific data-deletion confirmation is required");
    }
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call-data deletion is restricted to administrators");
      }
      if (typeof ctx.redactCartesiaCallData !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call-data deletion is unavailable");
      const result = await ctx.redactCartesiaCallData(callId, { businessId: req.body?.business_id, actorId: req.callEActorId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_redaction_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("invalid") || code.includes("scope_required") ? 400 : code.includes("operator") ? 403 : code.includes("unavailable") ? 409 : code.includes("not_configured") || code.includes("dependencies_missing") ? 503 : 502);
      console.error("cartesia_call_redaction_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia call data could not be deleted" : error.message);
    }
  });
  app.get("/api/cartesia/review-rules", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call review rules are restricted to administrators");
      }
      if (typeof ctx.getCartesiaCallReviewRules !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_call_dependencies_missing", "Cartesia call review rules are unavailable");
      return res.json({ success: true, rules: await ctx.getCartesiaCallReviewRules({ businessId: req.query?.business_id, actorId: req.callEActorId }) });
    } catch (error) {
      const code = String(error?.code || "cartesia_review_rules_load_failed");
      console.error("cartesia_review_rules_load_error", { code });
      return sendRouteError(ctx, req, res, Number(error?.status) || 503, code, "Cartesia call review rules could not be loaded");
    }
  });
  app.post("/api/cartesia/review-rules", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call review rules are restricted to administrators");
      }
      if (typeof ctx.saveCartesiaCallReviewRules !== "function") return sendRouteError(ctx, req, res, 503, "cartesia_call_dependencies_missing", "Cartesia call review rules are unavailable");
      const rules = await ctx.saveCartesiaCallReviewRules({ rules: req.body?.rules, businessId: req.body?.business_id, actorId: req.callEActorId });
      return res.json({ success: true, rules });
    } catch (error) {
      const code = String(error?.code || "cartesia_review_rules_save_failed");
      const status = Number(error?.status) || (code.includes("invalid") ? 400 : 503);
      console.error("cartesia_review_rules_save_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status >= 500 ? "Cartesia call review rules could not be saved" : error.message);
    }
  });
  app.post("/api/cartesia/calls/:callId/cancel", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendRouteError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia call operations are restricted to administrators");
      }
      const callId = String(req.params?.callId || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(callId) || String(req.body?.confirmation_phrase || "") !== `CANCEL CARTESIA CALL ${callId}`) {
        return sendRouteError(ctx, req, res, 400, "cartesia_call_cancel_confirmation_required", "An exact call-specific cancellation confirmation is required");
      }
      if (typeof ctx.cancelCartesiaCall !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call cancellation is unavailable");
      }
      const result = await ctx.cancelCartesiaCall(callId, { businessId: req.body?.business_id, actorId: req.callEActorId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_cancel_failed");
      const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("invalid") || code.includes("confirmation") || code.includes("scope_required") ? 400 : code.includes("admin") || code.includes("operator") ? 403 : code.includes("not_cancellable") ? 409 : code.includes("not_configured") || code.includes("dependencies_missing") ? 503 : 502);
      console.error("cartesia_call_cancel_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status === 502 ? "Cartesia cancellation could not be confirmed; refresh status before retrying" : error.message);
    }
  });
  app.post("/api/cartesia/call-reconcile", cartesiaApprovalLimiter, requireOutboundAuthorization, requireCallEActorAssertion, async (req, res) => {
    try {
      if (typeof ctx.reconcileCartesiaOutboundCall !== "function") {
        return sendRouteError(ctx, req, res, 503, "cartesia_not_configured", "Cartesia call lookup is unavailable");
      }
      const result = await ctx.reconcileCartesiaOutboundCall({
        ...(req.body || {}),
        actorId: req.callEActorId,
      });
      const call = result?.call ? {
        call_id: result.call.callId,
        agent_id: result.call.agentId,
        status: result.call.status,
        start_time: result.call.startTime,
        end_time: result.call.endTime,
        end_reason: result.call.endReason,
      } : null;
      return res.json({ success: true, outcome: result?.outcome || "unresolved", reason: result?.reason || null, status: result?.status || "unknown", call });
    } catch (error) {
      const code = String(error?.code || "cartesia_call_reconciliation_failed");
      const status = Number(error?.status) || (
        code.includes("not_found") ? 404
          : code.includes("operator") ? 403
            : code.includes("invalid") || code.includes("required") ? 400
              : code.includes("conflict") || code.includes("mismatch") ? 409
                : code.includes("not_configured") || code.includes("dependencies_missing") ? 503
                  : 502
      );
      console.error("cartesia_call_reconciliation_error", { code, status });
      return sendRouteError(ctx, req, res, status, code, status === 502 ? "Cartesia call lookup failed" : error?.message || "Cartesia call lookup failed");
    }
  });
  app.get("/api/calls", requireOutboundAuthorization, handleListCalls);
  app.get("/api/calls/list", requireOutboundAuthorization, handleListCallsFiltered);
  app.get("/api/calls/search", requireOutboundAuthorization, handleSearchCalls);
  app.get("/api/calls/activity", requireOutboundAuthorization, requireCallEActorAssertion, callActivity.list);
  app.get("/api/calls/activity/:callSid", requireOutboundAuthorization, requireCallEActorAssertion, callActivity.detail);
  app.post("/api/calls/activity/:callSid/refresh", requireOutboundAuthorization, requireCallEActorAssertion, callActivity.refresh);
  app.post("/api/calls/activity/:callSid/reconcile", requireOutboundAuthorization, requireCallEActorAssertion, callActivity.reconcile);
  app.get(
    "/api/calls/:callSid/transcript/audio",
    requireOutboundAuthorization,
    handleGetTranscriptAudio,
  );
  app.get("/api/calls/:callSid", requireOutboundAuthorization, handleGetCallDetails);
  app.get(
    "/api/callback-tasks",
    requireOutboundAuthorization,
    handleListCallbackTasks,
  );
  app.post(
    "/api/callback-tasks",
    requireOutboundAuthorization,
    handleCreateCallbackTask,
  );
  app.patch(
    "/api/callback-tasks/:taskId/status",
    requireOutboundAuthorization,
    handleUpdateCallbackTaskStatus,
  );
  app.get(
    "/api/review-cases",
    requireOutboundAuthorization,
    handleListReviewCases,
  );
  app.post(
    "/api/review-cases",
    requireOutboundAuthorization,
    handleCreateReviewCase,
  );
  app.patch(
    "/api/review-cases/:caseId/status",
    requireOutboundAuthorization,
    handleUpdateReviewCaseStatus,
  );
  app.get("/api/qa/summary", requireOutboundAuthorization, handleGetQaSummary);
  app.get("/api/calls/:callSid/qa", requireOutboundAuthorization, handleGetCallQa);
  app.post(
    "/api/calls/:callSid/qa/evaluate",
    requireOutboundAuthorization,
    handleEvaluateCallQa,
  );
}

module.exports = {
  registerCallRoutes,
  __testables: {
    createOutboundCallHandler,
    createListCallsHandler,
    createListCallsFilteredHandler,
    createSearchCallsHandler,
    createCallOperationsHandler,
    createCallActivityHandlers,
  },
};
