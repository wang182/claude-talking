const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Validate critical modules exist before starting
const checkPaths = [
  '../stt', '../brain', '../tts', '../audio',
  '/Users/wang/.whisper-models/ggml-base.bin',
];
for (const p of checkPaths) {
  if (p.endsWith('.bin')) {
    if (!fs.existsSync(p)) console.warn(`[warn] STT model not found: ${p}`);
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
    frame: true,
    backgroundColor: '#1a1a2e',
    title: 'Claude桌面助手',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ─── Load core modules lazily (after app starts) ─────────────
let stt, brain, tts, audio;
function loadModules() {
  if (!stt) {
    stt = require('../stt');
    brain = require('../brain');
    tts = require('../tts');
    audio = require('../audio');
    const config = require('../config');
    if (config.stt?.model) stt.setModel(config.stt.model);
  }
}

// ─── Audio processing pipeline ──────────────────────────────

async function processAudio(wavBuffer) {
  loadModules();

  // Extract PCM payload (skip 44-byte WAV header)
  const pcmData = wavBuffer.slice(44);

  // Step 1: STT
  const text = await stt.transcribe(pcmData);
  if (!text) throw new Error('语音识别失败');

  // Step 2: Brain (Claude Code)
  const reply = await brain.think(text);

  // Step 3: TTS
  const resultWav = await tts.synthesize(reply);

  return { text, reply, wav: resultWav };
}

ipcMain.handle('process-audio', async (_event, wavArrayBuffer) => {
  try {
    const result = await processAudio(Buffer.from(wavArrayBuffer));
    return {
      ok: true,
      text: result.text,
      reply: result.reply,
      wavBase64: result.wav.toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('process-audio-with-image', async (_event, wavArrayBuffer, imageBase64) => {
  try {
    loadModules();
    const pcmData = Buffer.from(wavArrayBuffer).slice(44);
    const text = await stt.transcribe(pcmData);
    if (!text) throw new Error('语音识别失败');

    // Build prompt with image reference
    const imagePath = path.join(app.getPath('temp'), `vision_${Date.now()}.jpg`);
    fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'));
    const prompt = `用户说：${text}\n\n（用户还拍了一张照片，见附件 ${imagePath}）`;

    const reply = await brain.think(prompt);
    const resultWav = await tts.synthesize(reply);
    try { fs.unlinkSync(imagePath); } catch {}

    return { ok: true, text, reply, wavBase64: resultWav.toString('base64') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-status', async () => {
  loadModules();
  const sttAvailable = stt.isAvailable ? stt.isAvailable() : true;
  return { stt: sttAvailable };
});
