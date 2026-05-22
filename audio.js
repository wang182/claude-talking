const { OpusEncoder } = require('@discordjs/opus');

// Decoder for uplink: ESP32 → Server (16kHz, mono, 60ms frames)
let decoder = null;
function getDecoder() {
  if (!decoder) decoder = new OpusEncoder(16000, 1, 60);
  return decoder;
}

// Encoder for downlink: Server → ESP32 (24kHz, mono, 60ms frames)
let encoder = null;
function getEncoder() {
  if (!encoder) encoder = new OpusEncoder(24000, 1, 60);
  return encoder;
}

/**
 * Decode one OPUS frame to 16-bit PCM buffer
 */
function decodeOpusFrame(frame) {
  return getDecoder().decode(frame, 960); // 60ms × 16kHz = 960 samples
}

/**
 * Encode 16-bit PCM buffer to OPUS frame
 */
function encodeOpusFrame(pcm) {
  return getEncoder().encode(pcm);
}

/**
 * Convert Float32 PCM array to 16-bit Int16 buffer
 */
function float32ToInt16(float32) {
  const len = float32.length;
  const buf = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

/**
 * Convert Int16 buffer to WAV format (16kHz, mono, 16-bit)
 */
function pcmToWav(pcm16, sampleRate = 16000) {
  const dataLen = pcm16.length;
  const header = Buffer.alloc(44);
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // chunk size
  header.writeUInt16LE(1, 20);         // PCM format
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);

  return Buffer.concat([header, pcm16]);
}

module.exports = { getDecoder, getEncoder, decodeOpusFrame, encodeOpusFrame, float32ToInt16, pcmToWav };
