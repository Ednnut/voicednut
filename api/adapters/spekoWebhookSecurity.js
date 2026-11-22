const crypto = require("crypto");

function getHeader(headers, name) {
  const expected = String(name || "").toLowerCase();
  const key = Object.keys(headers || {}).find(
    (candidate) => candidate.toLowerCase() === expected,
  );
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function decodeSecret(value) {
  const secret = String(value || "").trim();
  if (!secret.startsWith("whsec_")) return null;
  const encoded = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length ? decoded : null;
}

function isSpekoWebhookSecret(value) {
  return decodeSecret(value) !== null;
}

function verifySpekoWebhook(options = {}) {
  const secret = String(options.secret || "").trim();
  const headers = options.headers || {};
  const rawBody = String(options.rawBody ?? "");
  const webhookId = getHeader(headers, "webhook-id");
  const timestamp = getHeader(headers, "webhook-timestamp");
  const signatureHeader = getHeader(headers, "webhook-signature");
  const toleranceSeconds = Math.max(
    1,
    Number(options.toleranceSeconds) || 300,
  );

  if (!webhookId || !timestamp || !signatureHeader) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) >
      toleranceSeconds
  ) {
    return false;
  }

  const secretBytes = decodeSecret(secret);
  if (!secretBytes) return false;

  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest();
  const candidates = signatureHeader
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return candidates.some((candidate) => {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    let suppliedSignature;
    try {
      suppliedSignature = Buffer.from(encoded, "base64");
    } catch {
      return false;
    }
    return (
      suppliedSignature.length === expectedSignature.length &&
      crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    );
  });
}

function verifySpekoAgentToolWebhook(options = {}) {
  const secret = String(options.secret || "").trim();
  const headers = options.headers || {};
  const rawBody = String(options.rawBody ?? "");
  const webhookId = getHeader(headers, "webhook-id");
  const timestamp = getHeader(headers, "webhook-timestamp");
  const signatureHeader = getHeader(headers, "webhook-signature");
  const toleranceSeconds = Math.max(1, Number(options.toleranceSeconds) || 300);
  if (!secret || !webhookId || !timestamp || !signatureHeader) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds
  ) {
    return false;
  }

  const keys = [];
  const decoded = decodeSecret(secret);
  if (decoded) keys.push(decoded);
  const raw = Buffer.from(secret, "utf8");
  if (raw.length >= 16 && !keys.some((key) => key.equals(raw))) keys.push(raw);
  if (!keys.length) return false;

  const expected = `${webhookId}.${timestamp}.${rawBody}`;
  const signatures = signatureHeader.split(/\s+/).filter(Boolean);
  return signatures.some((candidate) => {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    let supplied;
    try {
      supplied = Buffer.from(encoded, "base64");
    } catch (_error) {
      return false;
    }
    return keys.some((key) => {
      const digest = crypto.createHmac("sha256", key).update(expected, "utf8").digest();
      return supplied.length === digest.length && crypto.timingSafeEqual(supplied, digest);
    });
  });
}

module.exports = {
  isSpekoWebhookSecret,
  verifySpekoWebhook,
  verifySpekoAgentToolWebhook,
};
