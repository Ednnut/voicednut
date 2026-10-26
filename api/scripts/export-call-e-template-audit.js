#!/usr/bin/env node

const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const sqlite3 = require("sqlite3").verbose();
const { previewCallETemplate } = require("../adapters/callETemplateAdapter");

const SYNTHETIC_PHONE = "+14155550123";
const SYNTHETIC_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
});
const FINGERPRINT_FIELDS = Object.freeze([
  "prompt",
  "first_message",
  "configuration",
  "config_json",
  "voice_model",
  "default_profile",
  "objective_tags",
  "payment_enabled",
  "payment_connector",
  "payment_amount",
  "payment_currency",
  "payment_policy",
  "payment_description",
  "payment_start_message",
  "payment_success_message",
  "payment_failure_message",
  "payment_retry_message",
  "supports_payment",
  "supports_digit_capture",
  "requires_otp",
  "allow_terminator",
  "terminator_char",
]);
const LIFECYCLE_STATES = new Set(["draft", "review", "approved", "live"]);

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function isEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function sanitizeLifecycle(value) {
  const state = String(value || "").trim().toLowerCase();
  return LIFECYCLE_STATES.has(state) ? state : "unknown";
}

function sanitizeUnsupported(values) {
  return [...new Set(values.map((value) => {
    const item = String(value || "");
    return item.startsWith("configuration.") && item !== "configuration.invalid_json"
      ? "configuration.custom_key"
      : item;
  }))];
}

function readSnapshot(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildTemplateAuditRecord({ templateId, version, source, snapshot, currentLifecycle, usage }) {
  const row = readSnapshot(snapshot);
  if (!row) {
    return {
      templateId,
      version,
      source,
      lifecycleState: sanitizeLifecycle(currentLifecycle),
      usage,
      snapshotValid: false,
      compatibility: { compatible: false, missing: ["valid_template_snapshot"], unsupported: [] },
    };
  }

  const normalized = {
    ...row,
    id: templateId,
    version,
    lifecycle_state: sanitizeLifecycle(row.lifecycle_state || currentLifecycle),
  };
  const fingerprintInputs = Object.fromEntries(FINGERPRINT_FIELDS.map((key) => [key, normalized[key] ?? null]));
  const preview = previewCallETemplate(normalized, {
    phone: SYNTHETIC_PHONE,
    resultSchema: SYNTHETIC_RESULT_SCHEMA,
  });

  return {
    templateId,
    version,
    source,
    lifecycleState: normalized.lifecycle_state,
    usage,
    snapshotValid: true,
    contentFingerprint: digest({ templateId, version, fingerprintInputs }),
    fingerprintInputHashes: Object.fromEntries(FINGERPRINT_FIELDS.map((key) => [key, digest(normalized[key] ?? null)])),
    dependencies: {
      voiceModelConfigured: hasValue(normalized.voice_model),
      profileConfigured: hasValue(normalized.default_profile),
      objectivesConfigured: hasValue(normalized.objective_tags),
      paymentConnectorConfigured: hasValue(normalized.payment_connector),
      paymentPolicyConfigured: hasValue(normalized.payment_policy),
    },
    featureFlags: {
      paymentEnabled: isEnabled(normalized.payment_enabled),
      supportsPayment: isEnabled(normalized.supports_payment),
      supportsDigitCapture: isEnabled(normalized.supports_digit_capture),
      requiresOtp: isEnabled(normalized.requires_otp),
      allowsTerminator: isEnabled(normalized.allow_terminator),
    },
    compatibility: {
      compatibleWithSyntheticCallsV2Inputs: preview.compatible,
      missing: [...preview.missing],
      unsupported: sanitizeUnsupported(preview.unsupported),
      schemaErrors: [...preview.schemaErrors],
    },
  };
}

function buildSanitizedTemplateAudit(templateRows, versionRows, usageByVersion = {}) {
  const records = [];
  const versionKeys = new Set();
  const readUsage = (templateId, version) => usageByVersion[`${templateId}:${version}`] || {
    vapiCallEvents: 0,
    vapiCampaignDrafts: 0,
    callEReconciliationRecords: 0,
  };

  for (const versionRow of versionRows) {
    const templateId = Number(versionRow.template_id);
    const version = Number(versionRow.version);
    if (!Number.isSafeInteger(templateId) || templateId <= 0 || !Number.isSafeInteger(version) || version <= 0) continue;
    const key = `${templateId}:${version}`;
    versionKeys.add(key);
    const current = templateRows.find((row) => Number(row.id) === templateId && Number(row.version) === version);
    records.push(buildTemplateAuditRecord({
      templateId,
      version,
      source: "version_snapshot",
      usage: readUsage(templateId, version),
      snapshot: versionRow.snapshot,
      currentLifecycle: current?.lifecycle_state,
    }));
  }

  for (const row of templateRows) {
    const templateId = Number(row.id);
    const version = Number(row.version);
    if (!Number.isSafeInteger(templateId) || templateId <= 0 || !Number.isSafeInteger(version) || version <= 0) continue;
    if (versionKeys.has(`${templateId}:${version}`)) continue;
    records.push(buildTemplateAuditRecord({
      templateId,
      version,
      source: "current_row_without_snapshot",
      usage: readUsage(templateId, version),
      snapshot: row,
      currentLifecycle: row.lifecycle_state,
    }));
  }

  records.sort((left, right) => left.templateId - right.templateId || left.version - right.version);
  return {
    schemaVersion: 1,
    containsSensitiveHashes: true,
    rawTemplateContentIncluded: false,
    templates: records,
  };
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
  });
}

async function hasTable(db, tableName) {
  const rows = await all(db, "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", [tableName]);
  return rows.length > 0;
}

function openReadOnly(dbPath) {
  const uri = `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(uri, sqlite3.OPEN_READONLY | sqlite3.OPEN_URI, (error) => {
      if (error) {
        db.close(() => reject(new Error("Unable to open the supplied SQLite file read-only")));
        return;
      }
      resolve(db);
    });
  });
}

async function exportTemplateAudit(dbPath) {
  const db = await openReadOnly(dbPath);
  try {
    const templateRows = await all(db, `
      SELECT id, version, lifecycle_state, prompt, first_message, voice_model,
        objective_tags, supports_payment, supports_digit_capture, requires_otp,
        default_profile, allow_terminator, terminator_char, payment_enabled,
        payment_connector, payment_amount, payment_currency, payment_policy,
        payment_description, payment_start_message, payment_success_message,
        payment_failure_message, payment_retry_message
      FROM call_templates
      ORDER BY id
    `);
    const versionRows = await all(db, `
      SELECT template_id, version, snapshot
      FROM call_template_versions
      ORDER BY template_id, version
    `);
    const usageByVersion = {};
    const usageQueries = [
      ["vapi_call_events", "vapiCallEvents", "template_version"],
      ["vapi_call_campaigns", "vapiCampaignDrafts", "template_version"],
      ["call_e_reconciliation", "callEReconciliationRecords", "template_version"],
    ];
    for (const [tableName, outputKey, versionColumn] of usageQueries) {
      if (!await hasTable(db, tableName)) continue;
      const rows = await all(db, `
        SELECT template_id, ${versionColumn} AS version, COUNT(*) AS count
        FROM ${tableName}
        WHERE template_id IS NOT NULL AND ${versionColumn} IS NOT NULL
        GROUP BY template_id, ${versionColumn}
      `);
      for (const row of rows) {
        const key = `${Number(row.template_id)}:${Number(row.version)}`;
        usageByVersion[key] ||= { vapiCallEvents: 0, vapiCampaignDrafts: 0, callEReconciliationRecords: 0 };
        usageByVersion[key][outputKey] = Number(row.count) || 0;
      }
    }
    return buildSanitizedTemplateAudit(templateRows, versionRows, usageByVersion);
  } catch {
    throw new Error("The supplied SQLite file does not contain the expected CALL-E template audit tables");
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

function readDbPath(args) {
  const index = args.indexOf("--db");
  if (index < 0 || !args[index + 1]) return null;
  return path.resolve(args[index + 1]);
}

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: node scripts/export-call-e-template-audit.js --db <approved-sanitized-sqlite-copy>\n");
    return;
  }
  const dbPath = readDbPath(args);
  if (!dbPath) throw new Error("--db <approved-sanitized-sqlite-copy> is required");
  const audit = await exportTemplateAudit(dbPath);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSanitizedTemplateAudit,
  buildTemplateAuditRecord,
  exportTemplateAudit,
  openReadOnly,
  readDbPath,
};
