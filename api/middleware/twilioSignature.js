// Enhanced signature validation middleware with provider support
const twilio = require('twilio');
const crypto = require('crypto');
const config = require('../config');

/**
 * Validates webhook signature based on provider
 */
function validateSignatureByProvider(provider, req, url, body, signature) {
  switch (provider.toLowerCase()) {
    case 'twilio':
      return twilio.validateRequest(
        config.twilio.authToken,
        signature,
        url,
        body
      );
    
    case 'vonage': {
      // Vonage uses HMAC-SHA256
      if (!signature) return false;
      const apiSecret = config.vonage?.apiSecret;
      if (!apiSecret) return false;
      const hash = crypto
        .createHmac('sha256', apiSecret)
        .update(JSON.stringify(body))
        .digest('hex');
      return hash === signature;
    }
    
    case 'aws':
      // AWS signs via IAM in URL, no additional header validation needed
      return true;
    
    default:
      return true; // Unknown provider, allow through
  }
}

module.exports = function validateTwilioRequestFactory(provider = 'twilio') {
  return function validateTwilioRequest(req, res, next) {
    const normalizedProvider = (provider || 'twilio').toLowerCase();
    
    // Skip validation if no auth credentials configured
    if (normalizedProvider === 'twilio' && !config.twilio.authToken) {
      return next();
    }
    if (normalizedProvider === 'vonage' && !config.vonage?.apiSecret) {
      return next();
    }

    const signature = req.headers['x-twilio-signature'] || 
                      req.headers['x-vonage-signature'] ||
                      req.headers['authorization'];
    
    if (!signature) {
      console.warn(`⚠️ Webhook signature missing (provider: ${normalizedProvider})`);
      // Don't fail hard on missing signature - log and let through with warning
      return next();
    }

    const url = config.server.hostname
      ? `https://${config.server.hostname}${req.originalUrl}`
      : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const body = req.body || {};

    try {
      const valid = validateSignatureByProvider(normalizedProvider, req, url, body, signature);
      if (!valid) {
        console.warn(`❌ Invalid ${normalizedProvider} signature for ${req.path}`);
        return res.status(403).json({ error: `Invalid ${normalizedProvider} signature` });
      }
    } catch (err) {
      console.warn(`⚠️ Signature validation error (${normalizedProvider}):`, err.message);
      return res.status(403).json({ error: 'Signature validation failed' });
    }

    // Attach validated provider for use downstream
    req.verifiedProvider = normalizedProvider;
    next();
  };
};