const crypto = require("node:crypto");

const ALLOWED_CAMPAIGN_FIELDS = new Set([
  "name", "templateId", "template_id", "templateVersion", "template_version",
  "mappingId", "mapping_id", "phoneNumberId", "phone_number_id", "timeZone", "time_zone",
  "callingWindow", "calling_window", "callingWindowStart", "callingWindowEnd",
  "callingDays", "calling_days", "scheduledStartAt", "scheduled_start_at",
  "maxConcurrency", "max_concurrency", "maxRetries", "max_retries",
  "retryDelayMinutes", "retry_delay_minutes", "idempotencyKey", "idempotency_key",
]);

function campaignError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSummary(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const summary = JSON.parse(value);
    return summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  } catch {
    return {};
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeCampaignInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !ALLOWED_CAMPAIGN_FIELDS.has(key))) {
    throw campaignError("vapi_campaign_invalid", "Campaign request contains unsupported fields");
  }
  const name = String(input.name || "").trim();
  const templateId = positiveInteger(input.templateId ?? input.template_id);
  const templateVersion = positiveInteger(input.templateVersion ?? input.template_version);
  const mappingId = positiveInteger(input.mappingId ?? input.mapping_id);
  const phoneNumberId = String(input.phoneNumberId ?? input.phone_number_id ?? "").trim();
  const timeZone = String(input.timeZone ?? input.time_zone ?? "").trim();
  const window = input.callingWindow || input.calling_window || {};
  if (!window || typeof window !== "object" || Array.isArray(window) ||
      Object.keys(window).some((key) => !["start", "end"].includes(key))) {
    throw campaignError("vapi_campaign_invalid", "Campaign calling window is invalid");
  }
  const windowStart = String(window.start || input.callingWindowStart || "").trim();
  const windowEnd = String(window.end || input.callingWindowEnd || "").trim();
  const rawDays = input.callingDays ?? input.calling_days ?? [1, 2, 3, 4, 5];
  const maxConcurrency = Number(input.maxConcurrency ?? input.max_concurrency ?? 1);
  const maxRetries = Number(input.maxRetries ?? input.max_retries ?? 0);
  const retryDelayMinutes = Number(input.retryDelayMinutes ?? input.retry_delay_minutes ?? (maxRetries ? 60 : 0));
  const scheduledStartAt = String(input.scheduledStartAt ?? input.scheduled_start_at ?? "").trim();

  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) ||
      !templateId || !templateVersion || !mappingId ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(phoneNumberId) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(windowStart) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(windowEnd) || windowStart >= windowEnd ||
      !Array.isArray(rawDays) || rawDays.length < 1 || rawDays.length > 7 ||
      rawDays.some((day) => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 7) ||
      !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20 ||
      !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 ||
      !Number.isSafeInteger(retryDelayMinutes) ||
      (maxRetries === 0 ? retryDelayMinutes !== 0 : retryDelayMinutes < 5 || retryDelayMinutes > 1440)) {
    throw campaignError("vapi_campaign_invalid", "Campaign settings are invalid");
  }
  const callingDays = [...new Set(rawDays.map(Number))].sort((left, right) => left - right);
  if (callingDays.length !== rawDays.length) {
    throw campaignError("vapi_campaign_invalid", "Calling days must be unique");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw campaignError("vapi_campaign_invalid", "A valid IANA time zone is required");
  }
  let scheduledAt = null;
  if (scheduledStartAt) {
    const parsed = Date.parse(scheduledStartAt);
    if (!Number.isFinite(parsed) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduledStartAt)) {
      throw campaignError("vapi_campaign_invalid", "scheduled_start_at must include an explicit time zone");
    }
    if (parsed <= Date.now()) throw campaignError("vapi_campaign_invalid", "scheduled_start_at must be in the future");
    scheduledAt = new Date(parsed).toISOString();
  }
  return {
    name,
    provider: "vapi",
    templateId,
    templateVersion,
    mappingId,
    phoneNumberId,
    timeZone,
    callingWindowStart: windowStart,
    callingWindowEnd: windowEnd,
    callingDays,
    scheduledStartAt: scheduledAt,
    maxConcurrency,
    maxRetries,
    retryDelayMinutes,
    status: "draft",
  };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{8,180}$/.test(key) ? key : "";
}

function projectCampaign(record) {
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).filter(([key]) =>
    key !== "request_hash" && key !== "idempotency_key",
  ));
}

class VapiCallCampaignService {
  constructor(options = {}) {
    this.db = options.db;
    this.getTemplate = options.getTemplate;
    this.getMapping = options.getMapping;
  }

  async createDraft(input = {}) {
    const campaign = normalizeCampaignInput(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey ?? input.idempotency_key);
    if (!idempotencyKey) throw campaignError("vapi_campaign_idempotency_required", "A valid campaign idempotency key is required");
    if (typeof this.getTemplate !== "function" || typeof this.getMapping !== "function" ||
        typeof this.db?.getVapiCallCampaignByIdempotencyKey !== "function" ||
        typeof this.db?.insertVapiCallCampaign !== "function") {
      throw campaignError("vapi_campaign_unavailable", "Vapi campaign planning is unavailable");
    }

    const requestHash = crypto.createHash("sha256").update(JSON.stringify(campaign)).digest("hex");
    const existing = await this.db.getVapiCallCampaignByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw campaignError("vapi_campaign_idempotency_conflict", "Idempotency key was used for different campaign settings");
      return { campaign: projectCampaign(existing), idempotentReplay: true };
    }

    const template = await this.getTemplate(campaign.templateId);
    if (!template) throw campaignError("vapi_campaign_template_not_found", "Campaign template was not found");
    if (Number(template.id) !== campaign.templateId || Number(template.version || 1) !== campaign.templateVersion ||
        String(template.lifecycle_state || "").toLowerCase() !== "live") {
      throw campaignError("vapi_campaign_template_stale", "Campaign requires the exact current live template version");
    }
    const mapping = await this.getMapping(campaign.mappingId);
    if (!mapping || Number(mapping.id) !== campaign.mappingId || Number(mapping.template_id) !== campaign.templateId ||
        Number(mapping.template_version) !== campaign.templateVersion || mapping.compatibility_status !== "compatible" ||
        mapping.mapping_status !== "provisioned" || mapping.sync_status !== "synced" || !String(mapping.vapi_assistant_id || "").trim()) {
      throw campaignError("vapi_campaign_mapping_not_ready", "Campaign requires a current compatible and synced Vapi mapping");
    }
    if (parseSummary(mapping.summary).unsupported?.length) {
      throw campaignError("vapi_campaign_template_unsupported", "Campaign template contains behavior not supported by its Vapi mapping");
    }
    if (typeof this.db?.getVapiCallCampaignByIdempotencyKey !== "function" || typeof this.db?.insertVapiCallCampaign !== "function") {
      throw campaignError("vapi_campaign_unavailable", "Vapi campaign persistence is unavailable");
    }

    const record = {
      campaign_id: crypto.randomUUID(),
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      name: campaign.name,
      provider: campaign.provider,
      template_id: campaign.templateId,
      template_version: campaign.templateVersion,
      mapping_id: campaign.mappingId,
      phone_number_id: campaign.phoneNumberId,
      time_zone: campaign.timeZone,
      calling_window_start: campaign.callingWindowStart,
      calling_window_end: campaign.callingWindowEnd,
      calling_days_json: JSON.stringify(campaign.callingDays),
      scheduled_start_at: campaign.scheduledStartAt,
      max_concurrency: campaign.maxConcurrency,
      max_retries: campaign.maxRetries,
      retry_delay_minutes: campaign.retryDelayMinutes,
      status: "draft",
    };
    const inserted = await this.db.insertVapiCallCampaign(record);
    if (!inserted) {
      const raced = await this.db.getVapiCallCampaignByIdempotencyKey(idempotencyKey);
      if (raced?.request_hash === requestHash) return { campaign: projectCampaign(raced), idempotentReplay: true };
      throw campaignError("vapi_campaign_idempotency_conflict", "Idempotency key was used for different campaign settings");
    }
    const created = await this.db.getVapiCallCampaignByIdempotencyKey(idempotencyKey);
    return { campaign: projectCampaign(created), idempotentReplay: false };
  }
}

module.exports = { VapiCallCampaignService, normalizeCampaignInput, normalizeIdempotencyKey };
