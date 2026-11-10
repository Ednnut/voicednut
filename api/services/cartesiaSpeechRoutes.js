const express = require('express');

const AUDIO_CONTENT_TYPES = [
  'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4',
];

function registerCartesiaSpeechRoutes(app, options = {}) {
  const service = options.service;
  const requireAdminToken = options.requireAdminToken;
  const limiter = options.limiter || ((_req, _res, next) => next());
  if (!app || !service || typeof requireAdminToken !== 'function') {
    throw new Error('Cartesia speech routes require an app, service, and admin authorization');
  }

  app.get('/admin/cartesia/speech/voices', requireAdminToken, limiter, async (req, res) => {
    try {
      const voices = await service.listVoices(req.query);
      return res.json({ success: true, ...voices });
    } catch (error) {
      const status = Number(error.statusCode) || 502;
      return res.status(status).json({
        success: false,
        error: status < 500 ? error.message : 'Cartesia voice catalog is temporarily unavailable',
      });
    }
  });

  app.post(
    '/admin/cartesia/speech/transcriptions',
    requireAdminToken,
    limiter,
    express.raw({ type: AUDIO_CONTENT_TYPES, limit: '15mb' }),
    async (req, res) => {
      try {
        const contentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!AUDIO_CONTENT_TYPES.includes(contentType)) {
          return res.status(415).json({ success: false, error: 'Unsupported Cartesia Ink audio media type' });
        }
        const language = req.query.language === undefined ? 'en' : String(req.query.language);
        const wordTimestamps = req.query.word_timestamps === 'true';
        if (req.query.word_timestamps !== undefined && !['true', 'false'].includes(String(req.query.word_timestamps))) {
          return res.status(400).json({ success: false, error: 'word_timestamps must be true or false' });
        }
        const transcript = await service.transcribeAudio({
          audio: req.body,
          mimeType: contentType,
          language,
          wordTimestamps,
        });
        return res.json({ success: true, transcript });
      } catch (error) {
        const status = Number(error.statusCode) || 502;
        return res.status(status).json({
          success: false,
          error: status < 500 ? error.message : 'Cartesia transcription is temporarily unavailable',
        });
      }
    },
  );
}

module.exports = { AUDIO_CONTENT_TYPES, registerCartesiaSpeechRoutes };
