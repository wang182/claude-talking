const { EdgeTTS } = require('node-edge-tts');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ttsConfig = { voice: 'zh-CN-XiaoxiaoNeural', rate: 'default' };
try {
  ttsConfig = require('./config').tts || ttsConfig;
} catch (e) {}

/**
 * Generate speech audio from text using Microsoft Edge TTS
 * @param {string} text - text to speak
 * @param {object} options
 * @param {string} options.voice - Edge TTS voice name (default: zh-CN-XiaoxiaoNeural)
 * @param {string} options.rate - speech rate like '+10%' (default: from config)
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesize(text, options = {}) {
  const voice = options.voice || ttsConfig.voice;
  const rate = options.rate || ttsConfig.rate || 'default';

  const tmpMp3 = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);

  try {
    const tts = new EdgeTTS({ voice, rate });
    await tts.ttsPromise(text, tmpMp3);
    return fs.readFileSync(tmpMp3);
  } catch (err) {
    console.error('[tts] error:', err.message);
    throw err;
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch {}
  }
}

/**
 * Get available Chinese voices (Edge TTS)
 */
function getChineseVoices() {
  const voices = [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-XiaoyiNeural',
    'zh-CN-YunjianNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-YunyangNeural',
    'zh-CN-YunzeNeural',
    'zh-CN-XiaohanNeural',
    'zh-CN-XiaomengNeural',
    'zh-CN-XiaomoNeural',
    'zh-CN-XiaoruiNeural',
    'zh-CN-XiaoshuangNeural',
    'zh-CN-XiaoxuanNeural',
    'zh-CN-XiaoyuNeural',
    'zh-CN-XiaozhenNeural',
  ];
  return Promise.resolve(voices);
}

module.exports = { synthesize, getChineseVoices };
