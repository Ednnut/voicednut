"use strict";

const crypto = require("node:crypto");
const querystring = require("node:querystring");

function getHeader(req, name) {
  if (typeof req?.get === "function") {
    const value = req.get(name);
    if (value !== undefined) return value;
  }
  return req?.headers?.[name.toLowerCase()];
}

function appendParamValues(params, key, value) {
  if (value === null || value === undefined) return false;
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
    return false;
  }
  params.set(
    key,
    [...(params.get(key) || []), ...values.map((item) => String(item))],
  );
  return true;
}

function sortParamEntries(params) {
  return [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([key, values]) =>
      [...values].sort().map((value) => [key, value]),
    );
}

function getCanonicalRequestBase(req, method) {
  const forwardedProto = String(getHeader(req, "x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const protocol = String(req?.protocol || forwardedProto || "https")
    .replace(/:$/, "")
    .toLowerCase();
  const forwardedHost = String(getHeader(req, "x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || String(getHeader(req, "host") || "").trim();
  const requestTarget = String(req?.originalUrl || req?.url || "");
  if (!host || !requestTarget.startsWith("/") || !["http", "https"].includes(protocol)) {
    return null;
  }

  let url;
  try {
    url = new URL(requestTarget, `${protocol}://${host}`);
  } catch {
    return null;
  }

  const queryParams = new Map();
  const parsedQuery = querystring.parse(url.search.slice(1));
  for (const [key, value] of Object.entries(parsedQuery)) {
    if (!appendParamValues(queryParams, key, value)) return null;
  }
  const sortedQuery = sortParamEntries(queryParams);
  const queryString = sortedQuery
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  let base = `${url.protocol}//${url.host}${url.pathname}`;

  if (method === "GET") {
    return queryString ? `${base}?${queryString}` : base;
  }

  const postParams = new Map();
  const body = req?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (!appendParamValues(postParams, key, value)) return null;
    }
  } else if (body !== undefined && body !== null && body !== "") {
    return null;
  }

  const sortedPostParams = sortParamEntries(postParams);
  if (queryString || sortedPostParams.length > 0) {
    base += `?${queryString}`;
  }
  if (queryString && sortedPostParams.length > 0) {
    base += ".";
  }
  if (sortedPostParams.length > 0) {
    base += sortedPostParams.map(([key, value]) => `${key}${value}`).join("");
  }
  return base;
}

function matchesSignature(authToken, signedPayload, providedSignature) {
  const expected = crypto
    .createHmac("sha256", authToken)
    .update(signedPayload)
    .digest();
  return String(providedSignature || "")
    .split(",")
    .some((signature) => {
      const provided = Buffer.from(signature.trim(), "base64");
      return (
        expected.length === provided.length &&
        crypto.timingSafeEqual(expected, provided)
      );
    });
}

function validatePlivoSignatureV3(req, authToken) {
  const token = String(authToken || "");
  const nonce = String(getHeader(req, "x-plivo-signature-v3-nonce") || "").trim();
  if (!token || !nonce || nonce.length > 256) return false;

  const method = String(req?.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") return false;
  const base = getCanonicalRequestBase(req, method);
  if (!base) return false;
  const signedPayload = `${base}.${nonce}`;

  return [
    getHeader(req, "x-plivo-signature-v3"),
    getHeader(req, "x-plivo-signature-ma-v3"),
  ].some((signature) => matchesSignature(token, signedPayload, signature));
}

module.exports = { validatePlivoSignatureV3 };
