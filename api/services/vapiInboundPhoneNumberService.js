const { VapiApiError } = require("./vapiClient");

function isPhoneNumberId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function validateServerConfiguration(configuration) {
  const urlText = String(configuration?.url || "").trim();
  const credentialId = String(configuration?.credentialId || "").trim();
  try {
    const url = new URL(urlText);
    if (
      url.protocol !== "https:" || url.pathname.replace(/\/+$/, "") !== "/webhook/vapi" ||
      url.username || url.password || url.search || url.hash || !credentialId
    ) return false;
    return true;
  } catch {
    return false;
  }
}

class VapiInboundPhoneNumberService {
  constructor(options = {}) {
    this.client = options.client;
    this.getInboundRoute = options.getInboundRoute;
    this.serverConfiguration = options.serverConfiguration || null;
  }

  async configure(phoneNumberId) {
    const id = String(phoneNumberId || "").trim();
    if (!isPhoneNumberId(id)) {
      throw new VapiApiError("A valid Vapi phone number UUID is required", { code: "vapi_invalid_phone_number_id" });
    }
    if (!this.client || !this.client.isConfigured() || typeof this.client.getPhoneNumber !== "function" || typeof this.client.updatePhoneNumber !== "function") {
      throw new VapiApiError("Vapi phone number management is not configured", { code: "vapi_not_configured" });
    }
    if (!validateServerConfiguration(this.serverConfiguration)) {
      throw new VapiApiError("A secured HTTPS Vapi webhook URL and credential are required", { code: "vapi_webhook_configuration_invalid" });
    }
    const route = typeof this.getInboundRoute === "function" ? await this.getInboundRoute(id) : null;
    if (!route?.vapi_assistant_id) {
      throw new VapiApiError("An active local inbound assistant route is required", { code: "vapi_inbound_route_missing" });
    }

    const phone = await this.client.getPhoneNumber(id);
    if (!phone || String(phone.id || "") !== id) {
      throw new VapiApiError("Vapi phone number response did not match the requested ID", { code: "vapi_invalid_phone_number" });
    }
    if (phone.status && String(phone.status).toLowerCase() !== "active") {
      throw new VapiApiError("Only active Vapi phone numbers can be configured", { code: "vapi_phone_number_not_active" });
    }
    if (phone.workflowId || phone.assistantId || phone.squadId) {
      throw new VapiApiError("A Vapi assistant, squad, or workflow is assigned to this number; clear that assignment in Vapi before enabling dynamic assistant routing", { code: "vapi_phone_number_configuration_conflict" });
    }
    const currentServer = phone.server && typeof phone.server === "object" && !Array.isArray(phone.server)
      ? phone.server
      : {};
    const existingUrl = String(currentServer.url || phone.serverUrl || "").trim();
    const existingCredential = String(currentServer.credentialId || "").trim();
    if (
      (existingUrl && existingUrl !== this.serverConfiguration.url) ||
      (existingCredential && existingCredential !== this.serverConfiguration.credentialId)
    ) {
      throw new VapiApiError("This number has a different server URL or credential configured; resolve it in Vapi first", { code: "vapi_phone_number_configuration_conflict" });
    }

    const alreadyConfigured = existingUrl === this.serverConfiguration.url &&
      existingCredential === this.serverConfiguration.credentialId;
    if (!alreadyConfigured) {
      await this.client.updatePhoneNumber(id, {
        server: {
          ...currentServer,
          url: this.serverConfiguration.url,
          credentialId: this.serverConfiguration.credentialId,
        },
      });
    }
    return {
      phone_number_id: id,
      configured: true,
      server_url_configured: true,
      server_credential_configured: true,
      already_configured: alreadyConfigured,
    };
  }
}

module.exports = { VapiInboundPhoneNumberService, isPhoneNumberId, validateServerConfiguration };
