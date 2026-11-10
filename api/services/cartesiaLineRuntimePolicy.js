"use strict";

function resolveCartesiaLineRuntime(callConfig = {}, cartesiaConfig = {}) {
  const settings = callConfig?.script_policy?.agent_config?.voice_agent_settings;
  if (String(settings?.provider || "").trim().toLowerCase() !== "cartesia_line") {
    return { selected: false, reason: "cartesia_line_not_selected" };
  }
  if (String(callConfig?.script_policy?.lifecycle_state || "").trim().toLowerCase() !== "live") {
    return { selected: false, reason: "cartesia_line_script_not_live" };
  }
  if (cartesiaConfig.lineAgentEnabled !== true) {
    return { selected: false, reason: "cartesia_line_disabled" };
  }
  if (cartesiaConfig.dataHandlingReviewed !== true) {
    return { selected: false, reason: "cartesia_line_data_handling_not_reviewed" };
  }
  if (!String(cartesiaConfig.apiKey || "").trim()) {
    return { selected: false, reason: "cartesia_not_configured" };
  }
  const agentId = String(settings.agent_id || "").trim();
  if (!/^agent_[A-Za-z0-9_-]{6,128}$/.test(agentId)) {
    return { selected: false, reason: "cartesia_line_agent_id_invalid" };
  }
  return {
    selected: true,
    provider: "cartesia_line",
    agentId,
  };
}

module.exports = { resolveCartesiaLineRuntime };
