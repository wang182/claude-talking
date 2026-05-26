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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);

  return Buffer.concat([header, pcm16]);
}

module.exports = { float32ToInt16, pcmToWav };
