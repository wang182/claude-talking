const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const audio = require('./audio');

// Try to find whisper binary
function findWhisper() {
  const candidates = ['whisper-cli', 'whisper', 'whisper-cpp'];
  const commonPaths = [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/usr/local/bin/whisper',
  ];
  for (const p of [...commonPaths, ...candidates]) {
    try {
      const which = require('child_process').execFileSync('which', [p], { encoding: 'utf8' }).trim();
      if (which) return which;
    } catch {}
  }
  // Try PATH lookup
  for (const cmd of candidates) {
    try {
      const result = require('child_process').execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (result) return result;
    } catch {}
  }
  return null;
}

let whisperPath = findWhisper();
let modelPath = process.env.WHISPER_MODEL || '';

function setModel(model) {
  modelPath = model;
}

/**
 * Transcribe PCM audio buffer to text using whisper.cpp
 * @param {Buffer} pcm16 - 16-bit PCM audio data at 16kHz
 * @returns {Promise<string>} transcribed text
 */
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
    if (modelPath) {
      args.push('-m', modelPath);
    }

    const result = await new Promise((resolve, reject) => {
      const child = execFile(whisperPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Whisper failed: ${err.message}`));
          return;
        }
        // whisper-cli --output-txt writes to <file>.txt
        const outFile = tmpFile + '.txt';
        try {
          const text = fs.readFileSync(outFile, 'utf8').trim();
          resolve(text);
        } catch {
          // Fallback to stdout
          resolve(stdout.trim());
        }
      });
    });

    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(tmpFile + '.txt'); } catch {}
  }
}

/**
 * Fallback: use Python openai-whisper
 */
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

/**
 * Check if STT is available
 */
function isAvailable() {
  if (whisperPath) return true;
  try {
    require('child_process').execSync('python3 -c "import whisper" 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {}
  return false;
}

module.exports = { transcribe, setModel, isAvailable };
