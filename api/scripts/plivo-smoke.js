#!/usr/bin/env node

const fetch = require("node-fetch");
const PlivoVoiceAdapter = require("../adapters/PlivoVoiceAdapter");

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function redact(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function normalizeHost(value = "") {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function buildHttpsUrl(path, override = "") {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  const host = normalizeHost(process.env.SERVER || process.env.PLIVO_SMOKE_SERVER || "");
  return host ? `https://${host}${path}` : "";
}

function isHttpsUrl(value = "") {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function createReport() {
  const checks = [];
  return {
    checks,
    pass(name, details = {}) {
      checks.push({ name, status: "pass", details });
    },
    fail(name, error, details = {}) {
      checks.push({
        name,
        status: "fail",
        error: String(error?.message || error || "failed"),
        details,
      });
    },
    skip(name, reason, details = {}) {
      checks.push({ name, status: "skip", reason, details });
    },
    print() {
      const pass = checks.filter((check) => check.status === "pass").length;
      const fail = checks.filter((check) => check.status === "fail").length;
      const skip = checks.filter((check) => check.status === "skip").length;
      console.log("Plivo smoke report");
      console.log(`Summary: pass=${pass} fail=${fail} skip=${skip} total=${checks.length}`);
      for (const check of checks) {
        const tag =
          check.status === "pass"
            ? "[PASS]"
            : check.status === "skip"
              ? "[SKIP]"
              : "[FAIL]";
        const suffix =
          check.error
            ? ` :: ${check.error}`
            : check.reason
              ? ` :: ${check.reason}`
              : "";
        console.log(`${tag} ${check.name}${suffix}`);
      }
      return { pass, fail, skip, total: checks.length };
    },
  };
}

function getPlivoConfig() {
  return {
    authId: process.env.PLIVO_AUTH_ID || "",
    authToken: process.env.PLIVO_AUTH_TOKEN || "",
    apiBaseUrl: process.env.PLIVO_API_BASE_URL || "https://api.plivo.com",
    voiceFrom: process.env.PLIVO_VOICE_FROM_NUMBER || process.env.PLIVO_FROM_NUMBER || "",
    smsFrom: process.env.PLIVO_SMS_FROM_NUMBER || process.env.PLIVO_FROM_NUMBER || "",
    answerUrl: buildHttpsUrl("/plivo/answer", process.env.PLIVO_ANSWER_URL),
    eventUrl: buildHttpsUrl("/plivo/events", process.env.PLIVO_EVENT_URL),
    callTo: process.env.PLIVO_SMOKE_CALL_TO || process.env.PLIVO_SMOKE_TO_NUMBER || "",
    smsTo: process.env.PLIVO_SMOKE_SMS_TO || process.env.PLIVO_SMOKE_TO_NUMBER || "",
    smsText:
      process.env.PLIVO_SMOKE_SMS_TEXT ||
      "Voicednut Plivo smoke test. Reply STOP to opt out.",
  };
}

function validateOfflineConfig(report, cfg) {
  const missing = [];
  if (!cfg.authId) missing.push("PLIVO_AUTH_ID");
  if (!cfg.authToken) missing.push("PLIVO_AUTH_TOKEN");
  if (!cfg.voiceFrom) missing.push("PLIVO_VOICE_FROM_NUMBER or PLIVO_FROM_NUMBER");
  if (!cfg.smsFrom) missing.push("PLIVO_SMS_FROM_NUMBER or PLIVO_FROM_NUMBER");
  if (!cfg.answerUrl) missing.push("SERVER or PLIVO_ANSWER_URL");
  if (!cfg.eventUrl) missing.push("SERVER or PLIVO_EVENT_URL");

  if (missing.length) {
    report.fail("config.required_env", `Missing ${missing.join(", ")}`);
    return false;
  }
  report.pass("config.required_env", {
    auth_id: redact(cfg.authId),
    voice_from: cfg.voiceFrom,
    sms_from: cfg.smsFrom,
    answer_url: cfg.answerUrl,
    event_url: cfg.eventUrl,
  });
  return true;
}

async function runPreflight(report) {
  const baseUrl = String(
    process.env.PROVIDER_PREFLIGHT_BASE_URL ||
      process.env.PLIVO_SMOKE_PREFLIGHT_BASE_URL ||
      "",
  ).replace(/\/+$/, "");
  const token = String(process.env.ADMIN_API_TOKEN || process.env.API_SECRET || "").trim();
  if (!baseUrl || !token) {
    report.skip(
      "api.preflight",
      "Set PROVIDER_PREFLIGHT_BASE_URL and ADMIN_API_TOKEN/API_SECRET to run API preflight",
    );
    return;
  }

  for (const channel of ["call", "sms"]) {
    const url = new URL(`${baseUrl}/admin/provider/preflight`);
    url.searchParams.set("channel", channel);
    url.searchParams.set("provider", "plivo");
    url.searchParams.set(
      "network",
      boolFrom(process.env.PLIVO_SMOKE_PREFLIGHT_NETWORK, false) ? "1" : "0",
    );
    url.searchParams.set(
      "reachability",
      boolFrom(process.env.PLIVO_SMOKE_PREFLIGHT_REACHABILITY, false) ? "1" : "0",
    );
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-admin-token": token },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      report.fail(`api.preflight.${channel}`, payload?.error || `HTTP ${response.status}`, {
        summary: payload?.summary || null,
      });
      continue;
    }
    report.pass(`api.preflight.${channel}`, {
      summary: payload.summary || null,
    });
  }
}

async function runLiveCall(report, cfg) {
  if (!cfg.callTo) {
    report.skip("live.call", "Set PLIVO_SMOKE_CALL_TO or PLIVO_SMOKE_TO_NUMBER");
    return;
  }
  if (!isHttpsUrl(cfg.answerUrl) || !isHttpsUrl(cfg.eventUrl)) {
    report.fail("live.call", "PLIVO_ANSWER_URL and PLIVO_EVENT_URL must be HTTPS for live calls");
    return;
  }
  const adapter = new PlivoVoiceAdapter(
    {
      authId: cfg.authId,
      authToken: cfg.authToken,
      apiBaseUrl: cfg.apiBaseUrl,
      voice: {
        fromNumber: cfg.voiceFrom,
      },
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  const callSid = `plivo-smoke-${Date.now()}`;
  const response = await adapter.createOutboundCall({
    to: cfg.callTo,
    from: cfg.voiceFrom,
    callSid,
    answerUrl: cfg.answerUrl,
    eventUrl: cfg.eventUrl,
  });
  report.pass("live.call", {
    call_sid: callSid,
    request_uuid: response?.request_uuid || null,
    call_uuid: response?.call_uuid || response?.uuid || null,
  });
}

async function runLiveSms(report, cfg) {
  if (!cfg.smsTo) {
    report.skip("live.sms", "Set PLIVO_SMOKE_SMS_TO or PLIVO_SMOKE_TO_NUMBER");
    return;
  }
  const response = await fetch(
    `${cfg.apiBaseUrl.replace(/\/+$/, "")}/v1/Account/${encodeURIComponent(cfg.authId)}/Message/`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.authId}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: cfg.smsFrom,
        dst: cfg.smsTo,
        text: cfg.smsText,
      }),
    },
  );
  const body = await response.json().catch(async () => ({
    raw: await response.text().catch(() => ""),
  }));
  if (!response.ok) {
    report.fail("live.sms", body?.error || body?.message || `HTTP ${response.status}`);
    return;
  }
  const messageUuid = Array.isArray(body?.message_uuid)
    ? body.message_uuid[0]
    : body?.message_uuid || body?.messageUuid || null;
  report.pass("live.sms", {
    message_uuid: messageUuid,
    api_id: body?.api_id || null,
  });
}

async function main() {
  const report = createReport();
  const cfg = getPlivoConfig();
  const live = boolFrom(process.env.PLIVO_SMOKE_LIVE, false);

  validateOfflineConfig(report, cfg);
  await runPreflight(report);

  if (!live) {
    report.skip("live.call", "Set PLIVO_SMOKE_LIVE=1 to place a real Plivo call");
    report.skip("live.sms", "Set PLIVO_SMOKE_LIVE=1 to send a real Plivo SMS");
  } else {
    await runLiveCall(report, cfg);
    await runLiveSms(report, cfg);
  }

  const summary = report.print();
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`Plivo smoke failed: ${error?.message || error}`);
  process.exit(2);
});
