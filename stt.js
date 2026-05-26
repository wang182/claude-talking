const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const audio = require('./audio');

// ─── Install paths ──────────────────────────────────────────

const INSTALL_DIR = path.join(os.homedir(), '.whisper');
const WHISPER_VERSION = 'v1.7.4';

function getPlatform() {
  if (process.platform === 'darwin') {
    return 'macos-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
  }
  if (process.platform === 'win32') return 'windows-x64';
  return 'linux-x64';
}

function getBinaryName() {
  const base = `whisper-cli-${getPlatform()}`;
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function getBinaryPath() {
  return path.join(INSTALL_DIR, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
}

function getDefaultModelPath() {
  return path.join(INSTALL_DIR, 'ggml-small.bin');
}

// ─── Binary discovery ───────────────────────────────────────

function findWhisper() {
  // Check install dir first
  const binPath = getBinaryPath();
  if (fs.existsSync(binPath)) return binPath;

  const isWin = process.platform === 'win32';
  const whichCmd = isWin ? 'where' : 'which';

  const candidates = ['whisper-cli', 'whisper', 'whisper-cpp'];
  const commonPaths = isWin ? [] : [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/usr/local/bin/whisper',
  ];
  for (const p of [...commonPaths, ...candidates]) {
    try {
      const found = execFileSync(whichCmd, [p], { encoding: 'utf8' }).trim().split('\n')[0];
      if (found) return found;
    } catch {}
  }
  return null;
}

let whisperPath = findWhisper();
let modelPath = process.env.WHISPER_MODEL || '';

// ─── Download helpers ───────────────────────────────────────

function downloadUrl(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (uri) => {
      https.get(uri, { headers: { 'User-Agent': 'claude-talking/1.0' } }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try { fs.unlinkSync(dest); } catch {}
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          try { fs.unlinkSync(dest); } catch {}
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'], 10);
        let downloaded = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total && onProgress) onProgress(Math.round(downloaded / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    };
    doGet(url);
  });
}

// ─── Setup (download binary + model if missing) ─────────────

async function downloadBinary(onProgress) {
  const url = `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_VERSION}/${getBinaryName()}`;
  const dest = getBinaryPath();

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  if (onProgress) onProgress(0);
  await downloadUrl(url, dest, onProgress);

  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  whisperPath = dest;
}

async function downloadModel(onProgress) {
  const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
  const dest = getDefaultModelPath();

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  if (onProgress) onProgress(0);
  await downloadUrl(url, dest, onProgress);

  modelPath = dest;
}

async function ensureSetup(onProgress) {
  // onProgress({ stage: 'binary'|'model'|'done', percent: 0-100, label: '...' })

  const needsBinary = !whisperPath;
  const needsModel = !fs.existsSync(getDefaultModelPath());

  if (needsBinary) {
    if (onProgress) onProgress({ stage: 'binary', percent: 0, label: '下载 Whisper 引擎...' });
    await downloadBinary((pct) => {
      if (onProgress) onProgress({ stage: 'binary', percent: pct, label: '下载 Whisper 引擎...' });
    });
  }

  if (needsModel) {
    if (onProgress) onProgress({ stage: 'model', percent: 0, label: '下载语音模型 (ggml-small, ~450MB)...' });
    await downloadModel((pct) => {
      if (onProgress) onProgress({ stage: 'model', percent: pct, label: '下载语音模型 (ggml-small, ~450MB)...' });
    });
  }

  if (onProgress) onProgress({ stage: 'done', percent: 100, label: '设置完成' });
}

function setModel(model) {
  modelPath = model;
}

// ─── Transcription ──────────────────────────────────────────

async function transcribe(pcm16) {
  if (!whisperPath) {
    console.warn('[stt] whisper not found, trying Python fallback');
    return transcribePython(pcm16);
  }

  const tmpFile = path.join(os.tmpdir(), `stt_${Date.now()}.wav`);
  const wav = audio.pcmToWav(pcm16, 16000);
  fs.writeFileSync(tmpFile, wav);

  try {
    const args = ['-f', tmpFile, '-l', 'zh', '-otxt', '--no-prints', '-t', '4'];
    if (modelPath) args.push('-m', modelPath);

    const result = await new Promise((resolve, reject) => {
      const child = execFile(whisperPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Whisper failed: ${err.message}`));
          return;
        }
        const outFile = tmpFile + '.txt';
        try {
          const text = fs.readFileSync(outFile, 'utf8').trim();
          resolve(text);
        } catch {
          resolve(stdout.trim());
        }
      });
    });

    return toSimplified(result);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(tmpFile + '.txt'); } catch {}
  }
}

// ─── Chinese text normalization ─────────────────────────────

function toSimplified(text) {
  try {
    const result = execFileSync('opencc', ['-c', 't2s'], {
      input: text,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return result || text;
  } catch {
    return text;
  }
}

// ─── Python fallback ────────────────────────────────────────

async function transcribePython(pcm16) {
  const tmpFile = path.join(os.tmpdir(), `stt_${Date.now()}.wav`);
  const wav = audio.pcmToWav(pcm16, 16000);
  fs.writeFileSync(tmpFile, wav);

  try {
    const script = `
import sys
try:
    import whisper
    model = whisper.load_model("base")
    result = model.transcribe(${JSON.stringify(tmpFile)}, language="zh")
    print(result["text"].strip())
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
    const result = await new Promise((resolve, reject) => {
      execFile('python3', ['-c', script], { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Python whisper failed: ${err.message}`));
        else resolve(stdout.trim());
      });
    });
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function isAvailable() {
  if (whisperPath) return true;
  try {
    require('child_process').execSync('python3 -c "import whisper" 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {}
  return false;
}

module.exports = { transcribe, setModel, isAvailable, ensureSetup };
