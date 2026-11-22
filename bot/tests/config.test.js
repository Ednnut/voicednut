const assert = require("node:assert/strict");

process.env.ADMIN_TELEGRAM_ID = "123456";
process.env.ADMIN_TELEGRAM_USERNAME = "voicednut_test";
process.env.API_URL = "https://api.example.test/";
process.env.TEMPLATES_API_URL = "https://api.example.test/";
process.env.SCRIPTS_API_URL = "https://api.example.test/";
process.env.BOT_TOKEN = "123456:testing-token";
process.env.API_SECRET = "test-api-secret";

const config = require("../config");

assert.equal(config.apiUrl, "https://api.example.test");
assert.equal(config.scriptsApiUrl, "https://api.example.test");
assert.equal(
  config.normalizeApiBaseUrl("https://api.example.test/", "API_URL"),
  "https://api.example.test",
);
assert.throws(
  () => config.normalizeApiBaseUrl("https://api.example.test/api", "API_URL"),
  /API origin only/,
);
assert.throws(
  () => config.normalizeApiBaseUrl("ftp://api.example.test", "API_URL"),
  /HTTP\(S\) API origin/,
);

process.stdout.write("Bot API URL configuration tests passed.\n");
