// Reusable Twilio signature validation middleware
const twilio = require('twilio');

module.exports = function validateTwilioRequestFactory() {
  return function validateTwilioRequest(req, res, next) {
    const shouldValidate = String(process.env.TWILIO_VALIDATE_SIGNATURE || 'false').toLowerCase() !== 'false';
    if (!shouldValidate || !process.env.TWILIO_AUTH_TOKEN) {
      if (shouldValidate === false) {
        console.warn('⚠️ Twilio signature validation disabled via TWILIO_VALIDATE_SIGNATURE=false'.yellow);
      }
      return next();
    }

    const signature = req.headers['x-twilio-signature'];
    const url = process.env.SERVER ? `https://${process.env.SERVER}${req.originalUrl}` : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params = req.body || {};

    try {
      const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params);
      if (!valid) return res.status(403).send('Invalid Twilio signature');
    } catch (err) {
      console.warn('Twilio signature validation error', err.message || err);
      return res.status(403).send('Invalid Twilio signature');
    }

    next();
  };
};
