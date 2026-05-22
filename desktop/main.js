const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

app.whenReady().then(() => {
  createWindow();
  // Warm up Claude immediately — cold start takes ~10-20s, so start ASAP
  require('../brain').warmup().then(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('warmup-ready');
    }
  }).catch(() => {
    // Warmup failure is non-critical; first message will cold start
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('warmup-ready');
    }
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { require('../brain').reset(); } catch {}
});

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

function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*]*?)\*\*/g, '$1')
    .replace(/\*([^*]*?)\*/g, '$1')
    .replace(/`([^`]*?)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/^[-*+]\s/gm, '')
    .replace(/^\d+\.\s/gm, '')
    .replace(/^>\s/gm, '')
    .trim();
}

async function processAudio(wavBuffer) {
  loadModules();

  // Extract PCM payload (skip 44-byte WAV header)
  const pcmData = wavBuffer.slice(44);

  // Step 1: STT
  const text = await stt.transcribe(pcmData);
  if (!text) throw new Error('语音识别失败');

  // Step 2: Brain (Claude Code)
  const reply = await brain.think(text);

  // Step 3: TTS (strip markdown so asterisks etc aren't read aloud)
  const resultWav = await tts.synthesize(stripMarkdown(reply));

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
    const resultWav = await tts.synthesize(stripMarkdown(reply));
    try { fs.unlinkSync(imagePath); } catch {}

    return { ok: true, text, reply, wavBase64: resultWav.toString('base64') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-status', async () => {
  loadModules();
  const sttAvailable = stt.isAvailable ? stt.isAvailable() : true;

  // Read model from Claude Code settings
  let model = '未知';
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      model = settings.env?.ANTHROPIC_MODEL || model;
    }
  } catch {}

  return { stt: sttAvailable, model };
});

// ─── Text input processing ────────────────────────────────────

ipcMain.handle('process-text', async (_event, text) => {
  try {
    loadModules();
    if (!text || !text.trim()) return { ok: false, error: '输入不能为空' };
    const reply = await brain.think(text);
    const resultWav = await tts.synthesize(stripMarkdown(reply));
    return {
      ok: true,
      text: text,
      reply: reply,
      wavBase64: resultWav.toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
