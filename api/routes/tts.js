const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const fetch = require('node-fetch');
const { deepgram: deepgramConfig } = require('../config');

class TextToSpeechService extends EventEmitter {
  constructor() {
    super();
    this.nextExpectedIndex = 0;
    this.speechBuffer = {};
    this.defaultVoiceModel = deepgramConfig.voiceModel || 'aura-asteria-en';
    this.activeVoiceModel = this.defaultVoiceModel;
    
    // Validate required environment variables
    if (!deepgramConfig.apiKey) {
      console.error('❌ DEEPGRAM_API_KEY is not set');
    }
    if (!deepgramConfig.voiceModel) {
      console.warn('⚠️ VOICE_MODEL not set, using default');
    }
    
    console.log(`🎵 TTS Service initialized with voice model: ${this.defaultVoiceModel}`);
  }

  setVoiceModel(voiceModel) {
    if (voiceModel && typeof voiceModel === 'string' && voiceModel.trim().length > 0) {
      this.activeVoiceModel = voiceModel.trim();
      console.log(`🎙️ TTS voice model set to: ${this.activeVoiceModel}`.cyan);
    }
  }

  resetVoiceModel() {
    this.activeVoiceModel = this.defaultVoiceModel;
  }

  async generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;

    if (!partialResponse) { 
      console.warn('⚠️ TTS: No partialResponse provided');
      return; 
    }

    console.log(`🎵 TTS generating for: "${partialResponse.substring(0, 50)}..."`.cyan);

    try {
      const voiceModel = this.activeVoiceModel || this.defaultVoiceModel;
      const url = `https://api.deepgram.com/v1/speak?model=${voiceModel}&encoding=mulaw&sample_rate=8000&container=none`;
      
      console.log(`🌐 Making TTS request to: ${url}`.gray);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${deepgramConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: partialResponse,
        }),
        timeout: 10000 // 10 second timeout
      });

      console.log(`📡 TTS Response status: ${response.status}`.blue);

      if (response.status === 200) {
        try {
          const blob = await response.blob();
          const audioArrayBuffer = await blob.arrayBuffer();
          const base64String = Buffer.from(audioArrayBuffer).toString('base64');
          
          console.log(`✅ TTS audio generated, size: ${base64String.length} chars`.green);
          
          this.emit('speech', partialResponseIndex, base64String, partialResponse, interactionCount);
        } catch (processingError) {
          console.error('❌ Error processing TTS audio response:', processingError);
          throw processingError;
        }
      } else {
        const errorText = await response.text();
        console.error('❌ Deepgram TTS error:');
        console.error('Status:', response.status);
        console.error('Status Text:', response.statusText);
        console.error('Error Response:', errorText);
        
        // Try to parse error details
        try {
          const errorData = JSON.parse(errorText);
          console.error('Error Details:', errorData);
        } catch (parseError) {
          console.error('Could not parse error response as JSON');
        }
        
        throw new Error(`TTS API error: ${response.status} - ${response.statusText}`);
      }
    } catch (err) {
      console.error('❌ Error occurred in TextToSpeech service:', err.message);
      console.error('Error stack:', err.stack);
      
      // Emit an error event so the caller can handle it
      this.emit('error', err);
      
      // Don't throw the error to prevent crashing the call
      // Instead, try to continue without this audio
    }
  }
}

module.exports = { TextToSpeechService };
