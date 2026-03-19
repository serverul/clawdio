const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');

class TTSEngine {
  constructor(config) {
    this.config = config;
    this.backend = config.ttsBackend || 'edge';
    this.tempDir = path.join(__dirname, '..', 'temp');

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async synthesize(text, language = 'ro') {
    if (!text || text.trim() === '') {
      console.warn('TTS: Empty text, skipping synthesis');
      return { audio: Buffer.alloc(0), format: 'mp3', voice: '' };
    }

    const safeText = text.slice(0, 4900); // Leave room for safety

    if (this.backend === 'elevenlabs') {
      return this.synthesizeWithElevenLabs(safeText, language);
    } else {
      return this.synthesizeWithEdge(safeText, language);
    }
  }

  async synthesizeWithEdge(text, language) {
    const voiceMap = {
      'ro': 'ro-RO-AlinaNeural',
      'en': 'en-US-AriaNeural',
      'en-uk': 'en-GB-SoniaNeural',
      'fr': 'fr-FR-DeniseNeural',
      'de': 'de-DE-KatjaNeural',
      'es': 'es-ES-ElviraNeural',
      'it': 'it-IS-ElsaNeural',
      'pt': 'pt-BR-FranciscaNeural',
      'pl': 'pl-PL-ZofiaNeural',
      'nl': 'nl-NL-ColetteNeural',
    };

    const voice = voiceMap[language] || voiceMap['en'];

    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);

      const result = await tts.toFile(this.tempDir, text);
      const audioPath = result?.audioFilePath;
      if (!audioPath || !fs.existsSync(audioPath)) {
        throw new Error('Edge TTS did not return an audio file');
      }

      const audioBuffer = fs.readFileSync(audioPath);
      this.cleanTemp(audioPath);

      return {
        audio: audioBuffer,
        format: 'webmOpus',
        voice: voice,
      };
    } catch (error) {
      console.error('Edge TTS error:', error.message);
      throw error;
    }
  }

  async synthesizeWithElevenLabs(text, language) {
    const apiKey = this.config.elevenLabsApiKey;
    if (!apiKey) {
      throw new Error('ElevenLabs API key is required for ElevenLabs TTS backend');
    }

    const voiceId = this.config.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM';

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ElevenLabs API error ${response.status}: ${errText}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      return {
        audio: audioBuffer,
        format: 'mp3',
        voice: voiceId,
      };
    } catch (error) {
      console.error('ElevenLabs TTS error:', error.message);
      throw error;
    }
  }

  cleanTemp(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('TTS: Error cleaning temp file:', error.message);
    }
  }
}

module.exports = TTSEngine;
