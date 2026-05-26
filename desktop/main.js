const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// When launched from Finder, PATH may not include user-installed binaries.
// Extend PATH so child processes can find claude, whisper-cli etc.
if (app.isPackaged) {
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/homebrew/sbin',
  ];
  const existing = process.env.PATH || '';
  const added = extraPaths.filter(p => !existing.includes(p)).join(':');
  if (added) process.env.PATH = `${added}:${existing}`;
}

// Resolve module paths for dev (__dirname/..) vs packaged (process.resourcesPath/lib)
function libPath(mod) {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'lib')
    : path.join(__dirname, '..');
  return path.join(dir, mod);
}

function requireLib(mod) {
  return require(libPath(mod));
}

// When packaged, add bundled node_modules to module resolution path
if (app.isPackaged) {
  module.paths.push(path.join(process.resourcesPath, 'lib', 'node_modules'));
}

// Validate critical modules exist before starting
const checkPaths = [
  libPath('stt'), libPath('brain'), libPath('tts'),
  path.join(os.homedir(), '.whisper-models', 'ggml-base.bin'),
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
    title: 'Claude语音助手',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();
  // Warm up Claude immediately — cold start takes ~10-20s, so start ASAP
  requireLib('brain').warmup().then(() => {
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
  try { requireLib('brain').reset(); } catch {}
});

// ─── Load core modules lazily (after app starts) ─────────────
let stt, brain, tts;
function loadModules() {
  if (!stt) {
    stt = requireLib('stt');
    brain = requireLib('brain');
    tts = requireLib('tts');
    const config = requireLib('config');
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

// ─── Step-by-step handlers (for voice mode with thinking indicator) ───

ipcMain.handle('transcribe-audio', async (_event, wavArrayBuffer) => {
  loadModules();
  const pcmData = Buffer.from(wavArrayBuffer).slice(44);
  const text = await stt.transcribe(pcmData);
  return { ok: true, text };
});

ipcMain.handle('think-text', async (_event, text) => {
  loadModules();
  const reply = await brain.think(text);
  return { ok: true, reply };
});

ipcMain.handle('synthesize-text', async (_event, text) => {
  loadModules();
  const resultWav = await tts.synthesize(stripMarkdown(text));
  return { ok: true, wavBase64: resultWav.toString('base64') };
});

ipcMain.handle('process-audio-with-image', async (_event, wavArrayBuffer, imageBase64) => {
  try {
    loadModules();
    const model = getModelName();
    if (!supportsVision(model)) {
      return { ok: false, error: `当前模型 ${model} 不支持图片分析，请使用 Claude 系列模型` };
    }
    const pcmData = Buffer.from(wavArrayBuffer).slice(44);
    const text = await stt.transcribe(pcmData);
    if (!text) throw new Error('语音识别失败');

    // Build prompt with image reference
    const extMatch = imageBase64.match(/^data:image\/(\w+);base64,/);
    const ext = extMatch ? extMatch[1] : 'jpg';
    const imagePath = path.join(app.getPath('temp'), `vision_${Date.now()}.${ext}`);
    const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(imagePath, Buffer.from(raw, 'base64'));
    const prompt = `用户说：${text}\n\n用户还上传了一张图片，图片路径: ${imagePath}\n请读取这张图片查看内容，然后回复用户。`;

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
  const model = getModelName();
  return { stt: sttAvailable, model, vision: supportsVision(model) };
});

// ─── Model detection & capability check ────────────────────

function getModelName() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.env?.ANTHROPIC_MODEL || '未知';
    }
  } catch {}
  return '未知';
}

function supportsVision(model) {
  // Claude 3+ models all support vision. Only Claude models have vision.
  return /^claude-/i.test(model);
}

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

ipcMain.handle('process-text-with-image', async (_event, text, imageBase64) => {
  try {
    loadModules();
    const model = getModelName();
    if (!supportsVision(model)) {
      return { ok: false, error: `当前模型 ${model} 不支持图片分析，请使用 Claude 系列模型` };
    }
    // Save image to temp and reference in the prompt
    const extMatch = imageBase64.match(/^data:image\/(\w+);base64,/);
    const ext = extMatch ? extMatch[1] : 'png';
    const imagePath = path.join(app.getPath('temp'), `vision_${Date.now()}.${ext}`);
    const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(imagePath, Buffer.from(raw, 'base64'));
    const prompt = text
      ? `${text}\n\n用户还上传了一张图片，图片路径: ${imagePath}\n请先读取这张图片查看内容，然后回复用户。`
      : `用户上传了一张图片，图片路径: ${imagePath}\n请先读取这张图片查看内容，然后回复。`;
    const reply = await brain.think(prompt);
    const resultWav = await tts.synthesize(stripMarkdown(reply));
    try { fs.unlinkSync(imagePath); } catch {}
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
