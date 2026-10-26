const crypto = require("node:crypto");

const CONSENT_SOURCES = new Set(["web_form", "written", "verbal", "other"]);
const OPTOUT_SOURCES = new Set(["recipient_request", "operator_report", "provider_report", "other"]);

function policyError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizePolicyInput(input = {}, kind) {
  const businessId = String(input.businessId || input.business_id || "").trim();
  const destination = String(input.destination || input.phone || "").trim();
  const eventKey = String(input.eventKey || input.event_key || "").trim();
  const source = String(input.source || "").trim().toLowerCase();
  const occurredAt = String(input.occurredAt || input.occurred_at || "").trim();
  const recordedByTelegramId = String(input.recordedByTelegramId || "").trim() || null;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\+[1-9]\d{7,14}$/.test(destination) ||
      !/^[A-Za-z0-9._:-]{8,180}$/.test(eventKey) ||
      !(kind === "consent" ? CONSENT_SOURCES : OPTOUT_SOURCES).has(source) ||
      (recordedByTelegramId !== null && !/^\d{1,20}$/.test(recordedByTelegramId))) {
    throw policyError("call_e_contact_policy_invalid", "CALL-E contact policy event is invalid");
  }
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMs) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)) {
    throw policyError("call_e_contact_policy_invalid", "Policy event time must include a timezone");
  }
  const occurredIso = new Date(occurredMs).toISOString();
  if (occurredMs > Date.now() + 5 * 60 * 1000) {
    throw policyError("call_e_contact_policy_invalid", "Policy event time cannot be in the future");
  }
  let expiresAt = null;
  let evidenceReference = null;
  if (kind === "consent") {
    evidenceReference = String(input.evidenceReference || input.evidence_reference || "").trim();
    const rawExpiry = String(input.expiresAt || input.expires_at || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(evidenceReference)) {
      throw policyError("call_e_consent_evidence_required", "An opaque consent evidence reference is required");
    }
    if (rawExpiry) {
      const expiryMs = Date.parse(rawExpiry);
      if (!Number.isFinite(expiryMs) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(rawExpiry) || expiryMs <= occurredMs) {
        throw policyError("call_e_consent_expiry_invalid", "Consent expiry must follow the recorded consent time");
      }
      expiresAt = new Date(expiryMs).toISOString();
    }
  }
  const normalized = {
    businessId,
    destination,
    eventKey,
    source,
    occurredAt: occurredIso,
    expiresAt,
    evidenceReference,
    eventType: kind === "consent" ? "consent_granted" : "opted_out",
    recordedByTelegramId,
  };
  normalized.requestHash = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze(normalized);
}

class CallEContactPolicyService {
  constructor(options = {}) {
    this.db = options.db;
  }

  async recordConsent(input = {}) {
    const event = normalizePolicyInput(input, "consent");
    if (typeof this.db?.insertCallEContactPolicyEvent !== "function") {
      throw policyError("call_e_contact_policy_unavailable", "CALL-E contact policy storage is unavailable", 503);
    }
    const result = await this.db.insertCallEContactPolicyEvent(event);
    if (result?.conflict) throw policyError("call_e_contact_policy_idempotency_conflict", "Policy event key was used for different evidence", 409);
    return { recorded: result?.inserted === true, idempotentReplay: result?.replay === true };
  }

  async recordOptOut(input = {}) {
    const event = normalizePolicyInput(input, "optout");
    if (typeof this.db?.insertCallEContactPolicyEvent !== "function") {
      throw policyError("call_e_contact_policy_unavailable", "CALL-E contact policy storage is unavailable", 503);
    }
    const result = await this.db.insertCallEContactPolicyEvent(event);
    if (result?.conflict) throw policyError("call_e_contact_policy_idempotency_conflict", "Policy event key was used for different evidence", 409);
    return { recorded: result?.inserted === true, idempotentReplay: result?.replay === true };
  }

  async checkEligibility(input = {}) {
    const businessId = String(input.businessId || input.business_id || "").trim();
    const destination = String(input.destination || input.phone || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\+[1-9]\d{7,14}$/.test(destination)) {
      return { eligible: false, reason: "scope_or_destination_invalid" };
    }
    if (typeof this.db?.getCallEContactPolicyEligibility !== "function") {
      return { eligible: false, reason: "policy_storage_unavailable" };
    }
    try {
      return await this.db.getCallEContactPolicyEligibility({ business_id: businessId, destination });
    } catch {
      return { eligible: false, reason: "policy_storage_unavailable" };
    }
  }
}

module.exports = { CallEContactPolicyService, normalizePolicyInput };
