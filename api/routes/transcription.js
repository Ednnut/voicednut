require('colors');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('../config');

const CARTESIA_API_VERSION = '2026-08-14';

class CartesiaInkRealtimeTranscriptionService extends EventEmitter {
  constructor(options = {}) {
    super();
    const apiKey = String(options.apiKey ?? config.tts?.cartesia?.apiKey ?? '').trim();
    if (!apiKey) throw new Error('Cartesia Ink is selected but CARTESIA_API_KEY is not configured');
    const sampleRate = Number(options.sampleRate || 8000);
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new Error('Cartesia Ink sample rate must be an integer between 8000 and 48000');
    }
    const rawEncoding = String(options.encoding || 'mulaw').toLowerCase();
    const encoding = ({
      linear16: 'pcm_s16le',
      pcm_s16le: 'pcm_s16le',
      mulaw: 'pcm_mulaw',
      ulaw: 'pcm_mulaw',
      pcm_mulaw: 'pcm_mulaw',
    })[rawEncoding];
    if (!encoding) throw new Error('Cartesia Ink audio encoding is unsupported by the VOICEDNUT bridge');
    this.closed = false;
    this.closeRequested = false;
    this.finalResult = '';
    this.WebSocket = options.WebSocketImpl || WebSocket;
    const query = new URLSearchParams({
      model: 'ink-2',
      encoding,
      sample_rate: String(sampleRate),
      cartesia_version: CARTESIA_API_VERSION,
    });
    this.connection = new this.WebSocket(`wss://api.cartesia.ai/stt/turns/websocket?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 10000)),
    });
    this.closeTimer = null;
    this.connection.on('open', () => this.emit('open'));
    this.connection.on('message', (message) => this.handleMessage(message));
    this.connection.on('error', () => {
      this.emitSafeError(new Error('Cartesia Ink realtime connection failed'));
    });
    this.connection.on('close', (code) => {
      this.closed = true;
      this.clearCloseTimer();
      if (!this.closeRequested) this.emit('close', { code });
    });
  }

  emitSafeError(error) {
    if (this.listenerCount('error')) this.emit('error', error);
  }

  clearCloseTimer() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  handleMessage(message) {
    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(message) ? message.toString('utf8') : String(message));
    } catch {
      this.emitSafeError(new Error('Cartesia Ink returned an invalid realtime event'));
      return;
    }
    if (!event || typeof event.type !== 'string') {
      this.emitSafeError(new Error('Cartesia Ink returned an invalid realtime event'));
      return;
    }
    if (event.type === 'turn.update' || event.type === 'turn.eager_end') {
      if (typeof event.transcript === 'string') this.emit('utterance', event.transcript);
      return;
    }
    if (event.type === 'turn.start') {
      this.emit('speechStart');
      return;
    }
    if (event.type === 'turn.end') {
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      if (transcript) this.emit('transcription', transcript);
      return;
    }
    if (event.type === 'error') {
      const status = Number.isInteger(event.status_code) ? ` (${event.status_code})` : '';
      const error = new Error(`Cartesia Ink realtime request failed${status}`);
      if (typeof event.error_code === 'string') {
        error.code = event.error_code.replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
      }
      this.emitSafeError(error);
      return;
    }
    if (event.type === 'done') {
      this.closed = true;
      this.clearCloseTimer();
      if (this.connection.readyState === (this.WebSocket.OPEN || 1)) this.connection.close(1000);
    }
  }

  send(payload) {
    if (this.closed || this.closeRequested || this.connection.readyState !== (this.WebSocket.OPEN || 1)) return;
    try {
      const audio = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'base64');
      if (audio.length) this.connection.send(audio, { binary: true });
    } catch {
      this.emitSafeError(new Error('Unable to send audio to Cartesia Ink'));
    }
  }

  sendBuffer(buffer) {
    if (Buffer.isBuffer(buffer)) this.send(buffer);
  }

  close() {
    if (this.closed || this.closeRequested) return;
    this.closeRequested = true;
    if (this.connection.readyState !== (this.WebSocket.OPEN || 1)) {
      this.closed = true;
      this.connection.close();
      return;
    }
    try {
      this.connection.send(JSON.stringify({ type: 'close' }));
      this.closeTimer = setTimeout(() => {
        this.closed = true;
        this.connection.close();
      }, 2500);
      this.closeTimer.unref?.();
    } catch {
      this.closed = true;
      this.connection.close();
    }
  }
}


class TranscriptionService extends EventEmitter {
  constructor(options = {}) {
    super();
    const provider = String(options.provider || config.transcription?.provider || 'deepgram').trim().toLowerCase();
    if (provider === 'cartesia') return new CartesiaInkRealtimeTranscriptionService(options);
    if (provider !== 'deepgram') throw new Error(`Unsupported transcription provider: ${provider}`);
    const apiKey = String(config.deepgram?.apiKey || '').trim();
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY is not configured');
    }
    const deepgram = createClient(apiKey);
    const encoding = options.encoding || 'mulaw';
    const sampleRate = options.sampleRate || 8000;
    const model = options.model || config.deepgram.model;
    this.closed = false;
    this.dgConnection = deepgram.listen.live({
      encoding: encoding,
      sample_rate: String(sampleRate),
      model: model,
      punctuate: true,
      interim_results: true,
      endpointing: 200,
      utterance_end_ms: 1000
    });

    this.finalResult = '';
    this.speechFinal = false; // used to determine if we have seen speech_final=true indicating that deepgram detected a natural pause in the speakers speech. 

    this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('STT -> Deepgram connection open'.green);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Transcript, (transcriptionEvent) => {
      const alternatives = transcriptionEvent.channel?.alternatives;
      let text = '';
      if (alternatives) {
        text = alternatives[0]?.transcript;
      }

      // if we receive an UtteranceEnd and speech_final has not already happened then we should consider this the end of of the human speech and emit the transcription
      if (transcriptionEvent.type === 'UtteranceEnd') {
        if (!this.speechFinal) {
          console.log(`UtteranceEnd received before speechFinal, emit the text collected so far: ${this.finalResult}`.yellow);
          this.emit('transcription', this.finalResult);
          return;
        } else {
          console.log('STT -> Speech was already final when UtteranceEnd recevied'.yellow);
          return;
        }
      }

      // console.log(text, "is_final: ", transcription?.is_final, "speech_final: ", transcription.speech_final);
      // if is_final that means that this chunk of the transcription is accurate and we need to add it to the finalResult
      if (transcriptionEvent.is_final === true && text.trim().length > 0) {
        this.finalResult += ` ${text}`;
        // if speech_final and is_final that means this text is accurate and it's a natural pause in the speakers speech. We need to send this to the assistant for processing
        if (transcriptionEvent.speech_final === true) {
          this.speechFinal = true; // this will prevent a utterance end which shows up after speechFinal from sending another response
          this.emit('transcription', this.finalResult);
          this.finalResult = '';
        } else {
          // if we receive a message without speechFinal reset speechFinal to false, this will allow any subsequent utteranceEnd messages to properly indicate the end of a message
          this.speechFinal = false;
        }
      } else {
        this.emit('utterance', text);
      }
    });

    this.dgConnection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error('STT -> deepgram error');
      console.error(error);
      this.emit('error', error);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Warning, (warning) => {
      console.error('STT -> deepgram warning');
      console.error(warning);
      this.emit('warning', warning);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Metadata, (metadata) => {
      console.log('STT -> deepgram metadata');
      console.log(metadata);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Close, (event) => {
      const closedByClient = this.closed === true;
      this.closed = true;
      console.log('STT -> Deepgram connection closed'.yellow);
      if (closedByClient) {
        return;
      }
      this.emit('close', event);
    });
  }

  /**
   * Send the payload to Deepgram
   * @param {String|Buffer} payload Base64 audio or raw buffer
   */
  send(payload) {
    if (!this.closed && this.dgConnection.getReadyState() === 1) {
      try {
        if (Buffer.isBuffer(payload)) {
          this.dgConnection.send(payload);
        } else {
          this.dgConnection.send(Buffer.from(payload, 'base64'));
        }
      } catch (error) {
        this.emit('error', error);
      }
    }
  }

  sendBuffer(buffer) {
    if (!this.closed && this.dgConnection.getReadyState() === 1 && Buffer.isBuffer(buffer)) {
      try {
        this.dgConnection.send(buffer);
      } catch (error) {
        this.emit('error', error);
      }
    }
  }

  close() {
    try {
      if (!this.dgConnection) return;
      if (this.closed) return;
      this.closed = true;
      if (typeof this.dgConnection.finish === 'function') {
        this.dgConnection.finish();
        return;
      }
      if (typeof this.dgConnection.requestClose === 'function') {
        this.dgConnection.requestClose();
      }
    } catch (error) {
      this.emit('error', error);
    }
  }
}

module.exports = { TranscriptionService, CartesiaInkRealtimeTranscriptionService };
