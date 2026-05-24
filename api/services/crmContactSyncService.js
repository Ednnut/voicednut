const crypto = require("crypto");
const fetch = require("node-fetch");

const SUPPORTED_CRM_PROVIDERS = new Set([
  "hubspot",
  "salesforce",
  "airtable",
  "gohighlevel",
  "managed",
  "stub",
]);

function normalizeProvider(value, fallback = "stub") {
  const provider = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (provider === "gohighlevel" || provider === "ghl") return "gohighlevel";
  if (SUPPORTED_CRM_PROVIDERS.has(provider)) return provider;
  return fallback;
}

function normalizeText(value, max = 240) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function normalizeEmail(value) {
  return normalizeText(value, 320).toLowerCase();
}

function stableId(prefix, parts = []) {
  const hash = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part || "")).join(":"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${hash}`;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

class CrmContactSyncService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.invokeManagedEndpoint = options.invokeManagedEndpoint || null;
    this.fetch = options.fetch || fetch;
  }

  resolveProvider(provider) {
    return normalizeProvider(provider, normalizeProvider(this.config.provider, "stub"));
  }

  getProviderConfig(provider) {
    return safeObject(this.config[this.resolveProvider(provider)]);
  }

  isProviderConfigured(provider) {
    const resolved = this.resolveProvider(provider);
    const providerConfig = this.getProviderConfig(resolved);
    if (resolved === "hubspot") {
      return Boolean(providerConfig.apiKey);
    }
    if (resolved === "airtable") {
      return Boolean(providerConfig.apiKey && providerConfig.baseId);
    }
    if (resolved === "gohighlevel") {
      return Boolean(providerConfig.apiKey && providerConfig.locationId);
    }
    if (resolved === "salesforce") {
      return Boolean(providerConfig.accessToken && providerConfig.instanceUrl);
    }
    return false;
  }

  async health(payload = {}) {
    const provider = this.resolveProvider(payload.provider);
    const checks = [
      {
        name: "provider_supported",
        status: SUPPORTED_CRM_PROVIDERS.has(provider) ? "pass" : "fail",
        provider,
      },
    ];
    if (provider === "managed") {
      checks.push({
        name: "managed_endpoint",
        status: typeof this.invokeManagedEndpoint === "function" ? "pass" : "warn",
      });
    } else if (provider !== "stub") {
      checks.push({
        name: "native_provider_adapter",
        status: this.isProviderConfigured(provider) ? "pass" : "warn",
        message: this.isProviderConfigured(provider)
          ? "Native CRM API adapter is configured."
          : "Native CRM API credentials are missing; using local interface persistence.",
      });
    }
    const ok = checks.every((check) => check.status !== "fail");
    return {
      ok,
      provider,
      mode: provider === "stub" ? "stub" : this.isProviderConfigured(provider) ? "native" : "interface",
      checks,
    };
  }

  buildContactProperties(contact = {}, identity = {}) {
    const firstName = normalizeText(contact.first_name || contact.firstName, 120);
    const lastName = normalizeText(contact.last_name || contact.lastName, 120);
    const name = normalizeText(contact.name || [firstName, lastName].filter(Boolean).join(" "), 180);
    return {
      email: identity.email || normalizeEmail(contact.email || contact.email_address) || undefined,
      phone: identity.phone || normalizeText(contact.phone || contact.phone_number, 80) || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      name: name || undefined,
      company: normalizeText(contact.company || contact.company_name, 180) || undefined,
    };
  }

  async requestJson(provider, path, options = {}) {
    const providerConfig = this.getProviderConfig(provider);
    const baseUrl = normalizeText(providerConfig.baseUrl || providerConfig.instanceUrl, 500).replace(/\/+$/, "");
    if (!baseUrl) {
      const error = new Error(`CRM ${provider} base URL is not configured`);
      error.code = "configuration_error";
      throw error;
    }
    const response = await this.fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeout: Number.isFinite(Number(this.config.requestTimeoutMs))
        ? Number(this.config.requestTimeoutMs)
        : 15000,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(`CRM ${provider} request failed with status ${response.status}`);
      error.code = "provider_error";
      error.status = response.status;
      error.provider_response = body;
      throw error;
    }
    return body || {};
  }

  async upsertNativeContact(provider, contact, identity, payload = {}) {
    const providerConfig = this.getProviderConfig(provider);
    const props = this.buildContactProperties(contact, identity);
    if (provider === "hubspot") {
      if (!identity.email) {
        const result = await this.requestJson(provider, "/crm/v3/objects/contacts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            "Content-Type": "application/json",
          },
          body: {
            properties: {
              phone: props.phone,
              firstname: props.firstName,
              lastname: props.lastName,
              company: props.company,
            },
          },
        });
        return {
          externalContactId: normalizeText(result?.id, 160) || stableId(`${provider}_contact`, [provider, identity.identity_key]),
          raw: result,
        };
      }
      const body = {
        inputs: [
          {
            idProperty: "email",
            id: identity.email,
            properties: {
              email: props.email,
              firstname: props.firstName,
              lastname: props.lastName,
              phone: props.phone,
              company: props.company,
            },
          },
        ],
      };
      const result = await this.requestJson(provider, "/crm/v3/objects/contacts/batch/upsert", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
      return {
        externalContactId: normalizeText(result?.results?.[0]?.id, 160) || stableId(`${provider}_contact`, [provider, identity.identity_key]),
        raw: result,
      };
    }
    if (provider === "airtable") {
      const table = encodeURIComponent(providerConfig.contactsTable || "Contacts");
      const result = await this.requestJson(provider, `/v0/${providerConfig.baseId}/${table}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
       },
        body: {
          performUpsert: { fieldsToMergeOn: ["Email"] },
          records: [
            {
              fields: {
                Email: props.email || identity.identity_key,
                Phone: props.phone || "",
                Name: props.name || "",
                "First Name": props.firstName || "",
                "Last Name": props.lastName || "",
                Company: props.company || "",
              },
            },
          ],
        },
      });
      return {
        externalContactId: normalizeText(result?.records?.[0]?.id, 160) || stableId(`${provider}_contact`, [provider, identity.identity_key]),
        raw: result,
      };
    }
    if (provider === "gohighlevel") {
      const result = await this.requestJson(provider, "/contacts/upsert", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: {
          locationId: providerConfig.locationId,
          email: props.email,
          phone: props.phone,
          firstName: props.firstName,
          lastName: props.lastName,
          name: props.name,
          source: payload.source || "voice_agent",
        },
      });
      return {
        externalContactId:
          normalizeText(result?.contact?.id || result?.id, 160) ||
          stableId(`${provider}_contact`, [provider, identity.identity_key]),
        raw: result,
      };
    }
    if (provider === "salesforce") {
      if (!identity.email) {
        const error = new Error("Salesforce CRM sync requires an email for native contact upsert");
        error.code = "validation_error";
        throw error;
      }
      const result = await this.requestJson(
        provider,
        `/services/data/v59.0/sobjects/Contact/Email/${encodeURIComponent(identity.email)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${providerConfig.accessToken}`,
            "Content-Type": "application/json",
          },
          body: {
            Email: props.email,
            Phone: props.phone,
            FirstName: props.firstName,
            LastName: props.lastName || props.name || "Unknown",
            Company__c: props.company,
          },
        },
      );
      return {
        externalContactId:
          normalizeText(result?.id || identity.external_id, 160) ||
          stableId(`${provider}_contact`, [provider, identity.identity_key]),
        raw: result,
      };
    }
    return null;
  }

  async createNativeActivity(provider, payload = {}) {
    const providerConfig = this.getProviderConfig(provider);
    const contactId = normalizeText(payload.contact_id || payload.external_contact_id, 160);
    const note = normalizeText(payload.note || payload.summary || payload.transcript_summary, 2000);
    const callSid = normalizeText(payload.call_sid || payload.callSid, 160);
    const activityType = normalizeText(payload.activity_type || "call_note", 80);
    if (provider === "hubspot") {
      const result = await this.requestJson(provider, "/crm/v3/objects/notes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: {
          properties: {
            hs_note_body: note || activityType,
            hs_timestamp: new Date().toISOString(),
          },
          associations: contactId
            ? [
                {
                  to: { id: contactId },
                  types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
                },
              ]
            : undefined,
        },
      });
      return normalizeText(result?.id, 160);
    }
    if (provider === "airtable") {
      const table = encodeURIComponent(providerConfig.activitiesTable || "Activities");
      const result = await this.requestJson(provider, `/v0/${providerConfig.baseId}/${table}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: {
          records: [
            {
              fields: {
                Type: activityType,
                Note: note,
                "Call SID": callSid,
                "Contact ID": contactId,
                Created: new Date().toISOString(),
              },
            },
          ],
        },
      });
      return normalizeText(result?.records?.[0]?.id, 160);
    }
    if (provider === "gohighlevel") {
      if (!contactId) return "";
      const result = await this.requestJson(provider, `/contacts/${encodeURIComponent(contactId)}/notes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: { body: note || activityType },
      });
      return normalizeText(result?.note?.id || result?.id, 160);
    }
    if (provider === "salesforce") {
      const result = await this.requestJson(provider, "/services/data/v59.0/sobjects/Task", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerConfig.accessToken}`,
          "Content-Type": "application/json",
        },
        body: {
          Subject: activityType === "support_ticket" ? "Post-call support escalation" : "Post-call voice note",
          Description: [note, callSid ? `Call SID: ${callSid}` : ""].filter(Boolean).join("\n"),
          WhoId: contactId || undefined,
          Status: "Completed",
          Priority: activityType === "support_ticket" ? "High" : "Normal",
        },
      });
      return normalizeText(result?.id, 160);
    }
    return "";
  }

  buildContactIdentity(contact = {}) {
    const email = normalizeEmail(contact.email || contact.email_address);
    const phone = normalizeText(contact.phone || contact.phone_number, 80);
    const externalId = normalizeText(contact.external_id || contact.crm_contact_id, 160);
    const localId = normalizeText(contact.contact_id || contact.customer_id || contact.id, 160);
    return {
      email,
      phone,
      external_id: externalId,
      local_contact_id: localId,
      identity_key: email || phone || externalId || localId,
    };
  }

  async upsertContact(payload = {}) {
    const provider = this.resolveProvider(payload.provider);
    const contact = safeObject(payload.contact || payload.customer || payload);
    const identity = this.buildContactIdentity(contact);
    if (!identity.identity_key) {
      const error = new Error("CRM contact sync requires an email, phone, external_id, or contact_id");
      error.code = "validation_error";
      throw error;
    }

    if (provider === "managed" && typeof this.invokeManagedEndpoint === "function") {
      const managed = await this.invokeManagedEndpoint("crm_contact_upsert", {
        ...payload,
        provider,
        contact,
      });
      return {
        provider,
        mode: "managed",
        contact_id: managed?.contact_id || managed?.external_contact_id || null,
        raw: managed || null,
      };
    }

    let native = null;
    if (provider !== "stub" && provider !== "managed" && this.isProviderConfigured(provider)) {
      native = await this.upsertNativeContact(provider, contact, identity, payload);
    }

    const externalContactId =
      normalizeText(contact.crm_contact_id || contact.external_contact_id, 160) ||
      normalizeText(native?.externalContactId, 160) ||
      stableId(`${provider}_contact`, [provider, identity.identity_key]);
    const record = {
      provider,
      local_contact_id: identity.local_contact_id || identity.identity_key,
      external_contact_id: externalContactId,
      email: identity.email || null,
      phone: identity.phone || null,
      status: provider === "stub" ? "stubbed" : native ? "synced" : "pending_provider_adapter",
      payload_json: JSON.stringify({
        contact,
        metadata: safeObject(payload.metadata),
        native: native?.raw || null,
      }),
    };
    if (this.db && typeof this.db.upsertCrmContactSyncRecord === "function") {
      await this.db.upsertCrmContactSyncRecord(record);
    }
    return {
      provider,
      mode: provider === "stub" ? "stub" : native ? "native" : "interface",
      contact_id: externalContactId,
      status: record.status,
      local_contact_id: record.local_contact_id,
    };
  }

  async attachCallNote(payload = {}) {
    const provider = this.resolveProvider(payload.provider);
    const contactId = normalizeText(payload.contact_id || payload.external_contact_id, 160);
    const callSid = normalizeText(payload.call_sid || payload.callSid, 160);
    const note = normalizeText(payload.note || payload.summary || payload.transcript_summary, 2000);
    let nativeActivityId = "";
    if (provider !== "stub" && provider !== "managed" && this.isProviderConfigured(provider)) {
      nativeActivityId = await this.createNativeActivity(provider, payload);
    }
    const activityId = nativeActivityId || stableId(`${provider}_activity`, [
      provider,
      contactId,
      callSid,
      note,
      payload.activity_type || "call_note",
    ]);
    const event = {
      provider,
      external_contact_id: contactId || null,
      activity_id: activityId,
      activity_type: normalizeText(payload.activity_type || "call_note", 80),
      status: provider === "stub" ? "stubbed" : nativeActivityId ? "synced" : "pending_provider_adapter",
      payload_json: JSON.stringify(payload),
    };
    if (this.db && typeof this.db.recordCrmActivitySyncEvent === "function") {
      await this.db.recordCrmActivitySyncEvent(event);
    }
    return {
      provider,
      mode: provider === "stub" ? "stub" : nativeActivityId ? "native" : "interface",
      activity_id: activityId,
      status: event.status,
    };
  }

  async attachEmailEvent(payload = {}) {
    return this.attachCallNote({
      ...payload,
      activity_type: payload.activity_type || "email_event",
      note: payload.note || payload.event_type || payload.status || "email_event",
    });
  }

  async createTicket(payload = {}) {
    return this.attachCallNote({
      ...payload,
      activity_type: "support_ticket",
      note: payload.summary || payload.note || "Post-call escalation summary",
    });
  }

  async syncPostCallRecord(payload = {}) {
    const provider = this.resolveProvider(payload.provider);
    const contactResult = await this.upsertContact({
      ...payload,
      provider,
      contact: payload.contact || payload.customer,
    });
    const call = safeObject(payload.call);
    const context = safeObject(payload.context);
    const note = payload.note || payload.summary || call.summary || context.transcript_summary || "";
    const activityResult = await this.attachCallNote({
      provider,
      contact_id: contactResult.contact_id,
      call_sid: call.call_sid || payload.call_sid || context.call_sid,
      note,
      context,
      metadata: payload.metadata,
    });
    return {
      provider,
      contact: contactResult,
      activity: activityResult,
    };
  }
}

module.exports = {
  CrmContactSyncService,
  normalizeProvider,
};
