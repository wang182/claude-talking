const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const audio = require('./audio');

// ─── Install paths ──────────────────────────────────────────

const INSTALL_DIR = path.join(os.homedir(), '.whisper');
const WHISPER_VERSION = 'v1.8.4';

function getBinaryName() {
  // macOS/Linux: direct binary; Windows: inside a ZIP
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'whisper-cli-macos-arm64' : 'whisper-cli-macos-x64';
  }
  if (process.platform === 'win32') return 'whisper-bin-x64.zip';
  return 'whisper-cli-linux-x64';
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

function downloadBuffer(url, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-talking/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      const total = parseInt(res.headers['content-length'], 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        downloaded += chunk.length;
        if (total && onProgress) onProgress(Math.round(downloaded / total * 100));
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ─── Setup (download binary + model if missing) ─────────────

async function downloadBinary(onProgress) {
  const isWin = process.platform === 'win32';
  const binUrl = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${getBinaryName()}`;
  const dest = getBinaryPath();

  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  if (isWin) {
    // Windows: download ZIP into memory and extract whisper-cli.exe
    if (onProgress) onProgress(0);
    const zipBuf = await downloadBuffer(binUrl, (pct) => {
      if (onProgress) onProgress(Math.round(pct * 0.7)); // 70% for download
    });
    // Extract ZIP to temp dir, find whisper-cli.exe, copy to install dir
    const tmpDir = path.join(os.tmpdir(), `whisper_extract_${Date.now()}`);
    const tmpZip = tmpDir + '.zip';
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpZip, zipBuf);
    try {
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force`
      ], { stdio: 'pipe' });
      // Find whisper-cli.exe in extracted files
      const files = fs.readdirSync(tmpDir, { recursive: true });
      const exe = files.find(f => path.basename(f).toLowerCase() === 'whisper-cli.exe');
      if (exe) {
        fs.copyFileSync(path.join(tmpDir, exe), dest);
        whisperPath = dest;
      } else {
        throw new Error('whisper-cli.exe not found in downloaded ZIP');
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(tmpZip); } catch {}
    }
    if (onProgress) onProgress(100);
  } else {
    // macOS/Linux: download binary directly
    if (onProgress) onProgress(0);
    await downloadUrl(binUrl, dest, onProgress);
    fs.chmodSync(dest, 0o755);
    whisperPath = dest;
  }
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
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const result = await new Promise((resolve, reject) => {
      execFile(pyCmd, ['-c', script], { timeout: 120000 }, (err, stdout, stderr) => {
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
  const pythons = process.platform === 'win32' ? ['python', 'python3'] : ['python3'];
  for (const py of pythons) {
    try {
      require('child_process').execSync(`${py} -c "import whisper" 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch {}
  }
  return false;
}

module.exports = { transcribe, setModel, isAvailable, ensureSetup };
