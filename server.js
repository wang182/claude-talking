const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const stt = require('./stt');
const tts = require('./tts');
const brain = require('./brain');
const config = require('./config');

const PORT = config.port || 8080;

// Initialize modules from config
if (config.stt && config.stt.model) {
  stt.setModel(config.stt.model);
  console.log(`[init] STT model: ${config.stt.model}`);
}
if (config.stt && !stt.isAvailable()) {
  console.log('[warn] STT not available — install whisper.cpp or use Python whisper');
}
if (config.tts) {
  tts.getChineseVoices().then(voices => {
    console.log(`[init] TTS voices available: ${voices.length > 0 ? voices.join(', ') : 'none (will use default)'}`);
  }).catch(() => {});
}
if (config.claude) {
  console.log(`[init] Claude Code: ${require('child_process').execSync('which claude 2>/dev/null && claude --version 2>/dev/null || echo "not found"').toString().trim()}`);
}

// ─── HTTP server (voice endpoint + static files) ────────────

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  // ── POST /voice: accept WAV → STT → Claude → TTS → return WAV ──
  if (req.method === 'POST' && urlPath === '/voice') {
    const query = req.url.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const ttsEnabled = params.get('tts') !== '0';
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const wavData = Buffer.concat(chunks);
        const result = await handleVoiceRequest(wavData, ttsEnabled);
        if (ttsEnabled) {
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          res.end(result);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: result }));
        }
      } catch (err) {
        console.error('[voice] error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET: serve static files from public/ ──
  if (req.method === 'GET') {
    const filePath = urlPath === '/' ? '/index.html' : urlPath;
    const fullPath = path.join(__dirname, 'public', filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(fullPath));
      return;
    }
    res.writeHead(404); res.end();
    return;
  }

  res.writeHead(404); res.end();
}

const httpServer = http.createServer(handleRequest);
httpServer.listen(PORT, () => {
  console.log(`[server] HTTP server on http://0.0.0.0:${PORT}`);
});

// ── HTTPS server (for Safari mic access) ──
const SSL_PORT = config.sslPort || 8082;
try {
  const httpsOpts = {
    key: fs.readFileSync(path.join(__dirname, 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'server.crt'))
  };
  const httpsServer = https.createServer(httpsOpts, handleRequest);
  httpsServer.listen(SSL_PORT, () => {
    console.log(`[ssl] HTTPS endpoint on https://0.0.0.0:${SSL_PORT}`);
  });
} catch (e) {
  console.log('[ssl] HTTPS disabled:', e.message);
}

// ─── Terminal text input ────────────────────────────────────

async function handleTextInput(text) {
  if (!text.trim()) return;
  console.log(`\n👤 ${text}`);

  try {
    console.log('🧠 thinking...');
    const start = Date.now();
    const reply = await brain.think(text);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`🤖 ${reply} (${elapsed}s)`);

    // Also do TTS so user can hear
    try {
      console.log('🔊 speaking...');
      const wavData = await tts.synthesize(reply);
      const tmpWav = path.join(os.tmpdir(), `tts_test_${Date.now()}.wav`);
      fs.writeFileSync(tmpWav, wavData);
      execFile('afplay', [tmpWav], { timeout: 60000 }, () => {});
      setTimeout(() => { try { fs.unlinkSync(tmpWav); } catch {} }, 1000);
    } catch (ttsErr) {
      console.log(`[tts] ${ttsErr.message}`);
    }
  } catch (err) {
    console.log(`❌ ${err.message}`);
  }
}

const readline = require('readline');
function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (line) => {
    if (line.trim().toLowerCase() === '/reset') {
      brain.reset();
      console.log('对话已重置');
      return;
    }
    if (line.trim().toLowerCase() === '/help') {
      console.log('/reset - 重置对话');
      console.log('/quit  - 退出');
      return;
    }
    if (line.trim().toLowerCase() === '/quit') {
      process.exit(0);
    }
    await handleTextInput(line);
    rl.prompt();
  });
  rl.prompt();
  return rl;
}

console.log('\n=== Claude Talking 服务器 ===');
console.log(`TTS 引擎: Edge TTS (${config.tts.voice || 'zh-CN-XiaoxiaoNeural'})`);
console.log('');

(async () => {
  const ip = await getLocalIP();
  console.log(`📱 Web 客户端: http://${ip}:${PORT}/`);
  console.log(`📱 Web(HTTPS): https://${ip}:${SSL_PORT}/`);
  console.log('📝 在终端输入文字即可对话 (输入 /help 查看命令)');
  console.log('');
  startRepl();
})();

// ─── HTTP Voice Request Handler ──────────────────────────

async function handleVoiceRequest(wavData, ttsEnabled = true) {
  // Extract PCM from WAV (skip 44-byte header)
  const pcmData = wavData.slice(44);

  // STT
  console.log('[voice] transcribing...');
  const text = await stt.transcribe(pcmData);
  console.log(`[voice] stt: "${text}"`);
  if (!text) throw new Error('语音识别失败');

  // Brain
  console.log('[voice] thinking...');
  const reply = await brain.think(text);
  const snippet = reply.slice(0, 100);
  console.log(`[voice] reply: "${snippet}${reply.length > 100 ? '...' : ''}"`);

  // TTS (skip if disabled)
  if (!ttsEnabled) {
    console.log('[voice] tts disabled, returning text');
    return reply;
  }

  console.log('[voice] synthesizing...');
  const resultWav = await tts.synthesize(reply);

  return resultWav;
}

function getLocalIP() {
  return new Promise((resolve) => {
    try {
      const ifaces = require('os').networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal && !name.startsWith('lo')) {
            resolve(iface.address);
            return;
          }
        }
      }
    } catch {}
    resolve('localhost');
  });
}
