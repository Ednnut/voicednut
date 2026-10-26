const { VapiApiError } = require("./vapiClient");
const {
  fingerprintVapiTemplateMapping,
  mapCallTemplateToVapiAssistant,
} = require("../adapters/vapiTemplateAdapter");

const MAPPING_METADATA_KEY = "voicednutTemplateMapping";

function matchesMappingMetadata(assistant, expected) {
  const marker = assistant?.metadata?.[MAPPING_METADATA_KEY];
  return Boolean(
    marker &&
      Number(marker.templateId) === expected.templateId &&
      Number(marker.templateVersion) === expected.templateVersion &&
      String(marker.configFingerprint || "") === expected.configFingerprint,
  );
}

function buildAssistantSyncPayload(
  template,
  preview,
  expected,
  remoteAssistant = null,
  serverConfiguration = null,
) {
  const metadata = {
    ...(remoteAssistant?.metadata && typeof remoteAssistant.metadata === "object"
      ? remoteAssistant.metadata
      : {}),
    [MAPPING_METADATA_KEY]: {
      templateId: expected.templateId,
      templateVersion: expected.templateVersion,
      configFingerprint: expected.configFingerprint,
    },
  };
  return {
    name: String(template.name || `VOICEDNUT template ${expected.templateId}`)
      .trim()
      .slice(0, 40),
    ...preview.assistant,
    metadata,
    ...(serverConfiguration
      ? {
          server: { ...(remoteAssistant?.server || {}), ...serverConfiguration },
          serverMessages: Array.from(new Set([
            ...(Array.isArray(remoteAssistant?.serverMessages) ? remoteAssistant.serverMessages : []),
            "assistant.started",
            "status-update",
            "end-of-call-report",
            "hang",
            "transfer-update",
          ])),
        }
      : {}),
  };
}

function normalizeAssistantList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  throw new VapiApiError("Vapi assistant list response was invalid", {
    code: "vapi_invalid_assistant_list",
  });
}

class VapiTemplateSyncService {
  constructor(options = {}) {
    this.db = options.db;
    this.client = options.client;
  }

  async syncTemplate(template, candidates = {}) {
    if (!this.db || !this.client) {
      throw new VapiApiError("Vapi template sync is not configured", {
        code: "vapi_sync_not_configured",
      });
    }
    if (!this.client.isConfigured()) {
      throw new VapiApiError("Vapi integration is disabled or unconfigured", {
        code: "vapi_not_configured",
      });
    }
    const templateId = Number(template?.id);
    const templateVersion = Number(template?.version) || 1;
    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      throw new VapiApiError("A persisted call template is required", {
        code: "vapi_invalid_template",
      });
    }

    const vapiModel = candidates.model && typeof candidates.model === "object" ? candidates.model : null;
    const vapiVoice = candidates.voice && typeof candidates.voice === "object" ? candidates.voice : null;
    const serverConfiguration =
      candidates.serverConfiguration && typeof candidates.serverConfiguration === "object"
        ? candidates.serverConfiguration
        : null;
    const preview = mapCallTemplateToVapiAssistant({
      ...template,
      configuration: {
        vapi: {
          ...(vapiModel ? { model: vapiModel } : {}),
          ...(vapiVoice ? { voice: vapiVoice } : {}),
        },
      },
    });
    if (!preview.compatible) {
      throw new VapiApiError("Template has unmapped behavior and cannot be synchronized", {
        code: "vapi_template_incompatible",
      });
    }

    const configFingerprint = fingerprintVapiTemplateMapping(
      template,
      vapiModel,
      vapiVoice,
      serverConfiguration,
    );
    const expected = { templateId, templateVersion, configFingerprint };
    await this.db.upsertVapiTemplateMapping({
      template_id: templateId,
      template_version: templateVersion,
      config_fingerprint: configFingerprint,
      compatibility_status: "compatible",
      summary: {
        mapped_fields: preview.mappedFields,
        unsupported: preview.unsupported,
        missing: preview.missing,
      },
    });
    const records = await this.db.listVapiTemplateMappings(templateId);
    const mapping = records.find(
      (entry) => entry.template_version === templateVersion && entry.config_fingerprint === configFingerprint,
    );
    if (!mapping) {
      throw new VapiApiError("Local Vapi mapping record was not available", {
        code: "vapi_mapping_record_missing",
      });
    }
    const claimed = await this.db.claimVapiTemplateSync(
      templateId,
      templateVersion,
      configFingerprint,
    );
    if (!claimed) {
      throw new VapiApiError("A sync is already in progress for this mapping", {
        code: "vapi_sync_in_progress",
      });
    }

    let mutationSent = false;
    try {
      let assistant = null;
      if (mapping.vapi_assistant_id) {
        assistant = await this.client.getAssistant(mapping.vapi_assistant_id);
        if (!matchesMappingMetadata(assistant, expected)) {
          throw new VapiApiError("Mapped Vapi assistant ownership could not be verified", {
            code: "vapi_assistant_mapping_mismatch",
          });
        }
        const payload = buildAssistantSyncPayload(template, preview, expected, assistant, serverConfiguration);
        mutationSent = true;
        assistant = await this.client.updateAssistant(mapping.vapi_assistant_id, payload);
      } else {
        const assistants = normalizeAssistantList(await this.client.listAssistants({ limit: 1000 }));
        const matching = assistants.filter((entry) => matchesMappingMetadata(entry, expected));
        if (matching.length > 1) {
          throw new VapiApiError("Multiple Vapi assistants match this local template mapping", {
            code: "vapi_assistant_mapping_ambiguous",
          });
        }
        if (matching.length === 1) {
          assistant = matching[0];
          const payload = buildAssistantSyncPayload(template, preview, expected, assistant, serverConfiguration);
          mutationSent = true;
          assistant = await this.client.updateAssistant(assistant.id, payload);
        } else if (["unknown", "syncing"].includes(mapping.sync_status)) {
          if (assistants.length >= 1000) {
            throw new VapiApiError("Vapi assistant list may be truncated; refusing to create a duplicate", {
              code: "vapi_assistant_list_truncated",
            });
          }
          throw new VapiApiError("Previous Vapi create outcome is unresolved; refusing a duplicate create", {
            code: "vapi_create_outcome_unresolved",
          });
        } else {
          const payload = buildAssistantSyncPayload(template, preview, expected, null, serverConfiguration);
          mutationSent = true;
          assistant = await this.client.createAssistant(payload);
        }
      }

      const assistantId = String(assistant?.id || "").trim();
      if (!assistantId) {
        throw new VapiApiError("Vapi did not return an assistant ID", {
          code: "vapi_assistant_id_missing",
        });
      }
      const persisted = await this.db.completeVapiTemplateSync({
        template_id: templateId,
        template_version: templateVersion,
        config_fingerprint: configFingerprint,
        vapi_assistant_id: assistantId,
        vapi_assistant_version: assistant.latestVersion || null,
      });
      if (!persisted) {
        throw new VapiApiError("Vapi assistant synced but local mapping could not be finalized", {
          code: "vapi_sync_persistence_failed",
        });
      }
      return {
        template_id: templateId,
        template_version: templateVersion,
        config_fingerprint: configFingerprint,
        vapi_assistant_id: assistantId,
        vapi_assistant_version: assistant.latestVersion || null,
        sync_status: "synced",
      };
    } catch (error) {
      const outcomeUnknown =
        (mutationSent && (!Number.isFinite(error?.status) || error.status >= 500)) ||
        [
          "vapi_create_outcome_unresolved",
          "vapi_assistant_mapping_ambiguous",
          "vapi_assistant_list_truncated",
        ].includes(error?.code);
      await this.db.failVapiTemplateSync({
        template_id: templateId,
        template_version: templateVersion,
        config_fingerprint: configFingerprint,
        sync_status: outcomeUnknown ? "unknown" : "failed",
        error_code: error?.code || "vapi_sync_failed",
      });
      throw error;
    }
  }
}

module.exports = {
  MAPPING_METADATA_KEY,
  VapiTemplateSyncService,
  buildAssistantSyncPayload,
  matchesMappingMetadata,
};
