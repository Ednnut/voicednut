const { VapiApiError } = require("./vapiClient");

const PHONE_FIELDS = ["id", "name", "number", "provider", "status", "assistantId", "squadId", "workflowId"];
const PAGE_FIELDS = ["currentPage", "totalPages", "totalItems"];

function safeText(value, maxLength = 200) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

class VapiPhoneNumberService {
  constructor(options = {}) {
    this.client = options.client;
  }

  async list(query = {}) {
    if (!this.client || typeof this.client.listPhoneNumbers !== "function" || !this.client.isConfigured()) {
      throw new VapiApiError("Vapi phone number inventory is not configured", { code: "vapi_not_configured" });
    }
    const validScalar = (value) => value === undefined || typeof value === "string" || typeof value === "number";
    const rawPage = query.page === undefined ? 1 : Number(query.page);
    const rawLimit = query.limit === undefined ? 100 : Number(query.limit);
    const search = query.search === undefined ? "" : typeof query.search === "string" ? query.search.trim() : null;
    if (
      !validScalar(query.page) || !validScalar(query.limit) || search === null ||
      !Number.isSafeInteger(rawPage) || rawPage < 1 || rawPage > 100000 ||
      !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000 ||
      search.length > 100
    ) {
      throw new VapiApiError("Phone number inventory query is invalid", { code: "vapi_phone_number_query_invalid" });
    }

    const payload = await this.client.listPhoneNumbers({ page: rawPage, limit: rawLimit, search });
    if (
      !payload || !Array.isArray(payload.results) || !payload.metadata ||
      typeof payload.metadata !== "object" || Array.isArray(payload.metadata)
    ) {
      throw new VapiApiError("Vapi phone number list response was invalid", { code: "vapi_invalid_phone_number_list" });
    }
    const phoneNumbers = payload.results.slice(0, rawLimit).map((phone) => {
      if (!phone || typeof phone !== "object" || !safeText(phone.id)) {
        throw new VapiApiError("Vapi phone number list response was invalid", { code: "vapi_invalid_phone_number_list" });
      }
      const result = {};
      for (const field of PHONE_FIELDS) result[field] = safeText(phone[field]);
      result.serverConfigured = Boolean(safeText(phone.server?.url));
      result.serverCredentialConfigured = Boolean(safeText(phone.server?.credentialId));
      return result;
    });
    const pagination = {};
    for (const field of PAGE_FIELDS) {
      const value = Number(payload.metadata[field]);
      pagination[field] = Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    pagination.hasNextPage = payload.metadata.hasNextPage === true;
    pagination.nextCursor = safeText(payload.metadata.nextCursor, 500);
    return { phoneNumbers, pagination };
  }
}

module.exports = { VapiPhoneNumberService };
