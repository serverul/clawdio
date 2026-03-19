const fs = require('fs');
const path = require('path');

class STTEngine {
  constructor(config) {
    this.config = config;
    this.backend = config.sttBackend || 'openai';
    this.tempDir = path.join(__dirname, '..', 'temp');

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async transcribe(audioBuffer, language = 'ro') {
    if (!audioBuffer || audioBuffer.length < 100) {
      console.warn('STT: Audio buffer too small or empty');
      return '';
    }

    if (this.backend === 'openai') {
      return this.transcribeWithOpenAI(audioBuffer, language);
    } else {
      return this.transcribeLocal(audioBuffer, language);
    }
  }

  async transcribeWithOpenAI(audioBuffer, language) {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key is required for OpenAI STT backend');
    }

    // Save audio to temp WAV file
    const tempFile = path.join(this.tempDir, `stt_${Date.now()}.wav`);

    // Write a minimal WAV header for raw PCM
    const wavBuffer = this.pcmToWav(audioBuffer, 48000, 16, 1);
    fs.writeFileSync(tempFile, wavBuffer);

    try {
      const fileStream = fs.createReadStream(tempFile);
      const formData = new (require('form-data'))();
      formData.append('file', fileStream, { filename: 'audio.wav', contentType: 'audio/wav' });
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      formData.append('response_format', 'json');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI STT API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      return data.text || '';
    } catch (error) {
      console.error('OpenAI STT error:', error.message);
      throw error;
    } finally {
      this.cleanTemp(tempFile);
    }
  }

  async transcribeLocal(audioBuffer, language) {
    // Placeholder: returns a simulated transcription
    // Replace with whisper.cpp or faster-whisper for real local STT
    console.log('Local STT: Simulating transcription...');

    await new Promise(resolve => setTimeout(resolve, 500));

    const mockTranscriptions = [
      'Salut OpenClaw, ce faci?',
      'Ce vreme este afară?',
      'Poți să mă ajuți cu proiectul meu?',
      'Spune-mi o glumă te rog.',
      'Mulțumesc pentru ajutor.',
    ];

    return mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
  }

  pcmToWav(pcmBuffer, sampleRate = 48000, bitsPerSample = 16, channels = 1) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  cleanTemp(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('STT: Error cleaning temp file:', error.message);
    }
  }
}

module.exports = STTEngine;
