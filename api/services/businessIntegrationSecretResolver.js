const SECRET_REFERENCE_PREFIX = "env://";
const ALLOWED_ENV_NAME = /^BUSINESS_INTEGRATION_SECRET_[A-Z][A-Z0-9_]{0,94}$/;

function businessIntegrationSecretError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class BusinessIntegrationSecretResolver {
  constructor(options = {}) {
    this.env = options.env || process.env;
  }

  async resolve(secretReference) {
    // Business/connection ownership must be validated by the caller before resolving this opaque reference.
    const reference = typeof secretReference === "string" ? secretReference.trim() : "";
    if (!reference.startsWith(SECRET_REFERENCE_PREFIX)) {
      throw businessIntegrationSecretError(
        "business_integration_secret_reference_invalid",
        "Business integration secret reference is invalid",
      );
    }
    const envName = reference.slice(SECRET_REFERENCE_PREFIX.length);
    if (!ALLOWED_ENV_NAME.test(envName)) {
      throw businessIntegrationSecretError(
        "business_integration_secret_reference_invalid",
        "Business integration secret reference is invalid",
      );
    }
    const value = this.env[envName];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw businessIntegrationSecretError(
        "business_integration_secret_unavailable",
        "Business integration secret is unavailable",
      );
    }
    return value;
  }
}

module.exports = {
  BusinessIntegrationSecretResolver,
  SECRET_REFERENCE_PREFIX,
  ALLOWED_ENV_NAME,
};
