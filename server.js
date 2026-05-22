const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const audio = require('./audio');
const stt = require('./stt');
const tts = require('./tts');
const brain = require('./brain');
const config = require('./config');

const PORT = config.port || 8080;
const WSS_PORT = config.wssPort || 8080;

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

// Collect OPUS frames during listen
let currentSession = {
  sessionId: null,
  opusFrames: [],
  isListening: false,
  isProcessing: false,
  deviceSocket: null,
  state: 'idle', // idle | listening | processing | speaking
};

// ─── WebSocket Server ────────────────────────────────────────

const wss = new WebSocketServer({ port: WSS_PORT });
console.log(`[server] WebSocket server on ws://0.0.0.0:${WSS_PORT}`);

// ─── HTTP server (OTA + voice endpoint + static files) ────
const OTA_PORT = config.otaPort || 8081;

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  // ── POST /voice: accept WAV → STT → Claude → TTS → return WAV ──
  if (req.method === 'POST' && urlPath === '/voice') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const wavData = Buffer.concat(chunks);
        const resultWav = await handleVoiceRequest(wavData);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(resultWav);
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

  // ── POST (OTA): return WebSocket config ──
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const deviceId = req.headers['device-id'] || 'unknown';
      const localIP = getLocalIPSync();
      const response = {
        websocket: {
          uri: `ws://${localIP}:${WSS_PORT}`,
          heartbeat_interval: 30000,
          reconnect_interval: 5000,
          reconnect_max_retries: -1
        },
        activation: {
          code: "000000",
          message: "已连接到本地桥接服务器",
          timeout_ms: 60000
        },
        server_time: {
          timestamp: Date.now() / 1000,
          timezone_offset: new Date().getTimezoneOffset() * -1
        }
      };
      console.log(`[ota] device=${deviceId} → ${localIP}:${WSS_PORT}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (err) {
      console.error(`[ota] error: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

const otaServer = http.createServer(handleRequest);
otaServer.listen(OTA_PORT, () => {
  console.log(`[ota] HTTP endpoint on http://0.0.0.0:${OTA_PORT}`);
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

function getLocalIPSync() {
  try {
    const ifaces = require('os').networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && !name.startsWith('lo')) {
          return iface.address;
        }
      }
    }
  } catch {}
  return 'localhost';
}

wss.on('connection', (ws, req) => {
  const clientId = req.headers['client-id'] || 'unknown';
  const deviceId = req.headers['device-id'] || 'unknown';
  console.log(`[server] device connected: ${deviceId}`);

  let helloReceived = false;
  let helloTimeout = null;

  // Expect hello within 10s
  helloTimeout = setTimeout(() => {
    if (!helloReceived) {
      console.log(`[server] hello timeout for ${deviceId}`);
      ws.close();
    }
  }, 10000);

  ws.on('message', async (data) => {
    try {
      if (data instanceof Buffer || data instanceof ArrayBuffer) {
        await handleBinary(ws, Buffer.isBuffer(data) ? data : Buffer.from(data));
      } else {
        const msg = JSON.parse(data.toString());
        handleJson(ws, msg);
      }
    } catch (err) {
      console.error('[server] message error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[server] device disconnected: ${deviceId}`);
    if (helloTimeout) clearTimeout(helloTimeout);
    if (currentSession.deviceSocket === ws) {
      currentSession.state = 'idle';
      currentSession.isListening = false;
      currentSession.isProcessing = false;
    }
  });

  // ── JSON Handlers ────────────────

  function handleJson(ws, msg) {
    switch (msg.type) {
      case 'hello':
        helloReceived = true;
        if (helloTimeout) clearTimeout(helloTimeout);

        console.log(`[hello] device=${deviceId}, transport=${msg.transport}`);

        // Respond with server hello
        ws.send(JSON.stringify({
          type: 'hello',
          transport: 'websocket',
          session_id: msg.session_id || generateId(),
          audio_params: {
            format: 'opus',
            sample_rate: 24000,
            channels: 1,
            frame_duration: 60
          }
        }));

        currentSession.deviceSocket = ws;
        break;

      case 'listen':
        handleListen(ws, msg);
        break;

      case 'abort':
        console.log(`[abort] reason: ${msg.reason}`);
        currentSession.state = 'idle';
        currentSession.isListening = false;
        currentSession.isProcessing = false;
        currentSession.opusFrames = [];
        break;

      case 'mcp':
        // MCP device control response - log for now
        console.log('[mcp] device response:', JSON.stringify(msg.payload));
        break;

      default:
        console.log(`[server] unknown msg type: ${msg.type}`);
    }
  }

  function handleListen(ws, msg) {
    const { state, mode } = msg;
    currentSession.sessionId = msg.session_id || currentSession.sessionId;

    switch (state) {
      case 'start':
        console.log(`[listen] start (mode: ${mode})`);
        currentSession.state = 'listening';
        currentSession.isListening = true;
        currentSession.opusFrames = [];
        break;

      case 'stop':
        console.log(`[listen] stop — processing ${currentSession.opusFrames.length} frames`);
        currentSession.isListening = false;
        currentSession.state = 'processing';
        processSpeech(ws, currentSession.opusFrames);
        currentSession.opusFrames = [];
        break;

      case 'detect':
        console.log(`[listen] wake word detected: ${msg.text || ''}`);
        break;
    }
  }

  async function handleBinary(ws, buf) {
    if (currentSession.isListening) {
      // Collect OPUS frames
      currentSession.opusFrames.push(buf);
    } else {
      // May be early frames before listen:start — buffer or drop
      if (currentSession.state === 'idle') {
        currentSession.opusFrames.push(buf);
      }
    }
  }
});

// ─── Speech Processing Pipeline ─────────────────────────────

async function processSpeech(ws, opusFrames) {
  if (opusFrames.length === 0) {
    currentSession.state = 'idle';
    return;
  }

  try {
    // Step 1: Decode OPUS → PCM
    const pcmChunks = [];
    for (const frame of opusFrames) {
      try {
        const decoded = audio.decodeOpusFrame(frame);
        pcmChunks.push(decoded);
      } catch (err) {
        console.error('[decode] bad frame:', err.message);
      }
    }

    if (pcmChunks.length === 0) {
      currentSession.state = 'idle';
      return;
    }

    const pcm16 = Buffer.concat(pcmChunks);

    // Step 2: STT
    console.log('[stt] transcribing...');
    let text;
    try {
      text = await stt.transcribe(pcm16);
      console.log(`[stt] result: "${text}"`);
    } catch (err) {
      console.error('[stt] error:', err.message);
      text = '';
    }

    if (!text) {
      sendTTS(ws, '我没听清楚，能再说一遍吗？');
      return;
    }

    // Send STT result to device for display
    safeSend(ws, JSON.stringify({
      session_id: currentSession.sessionId,
      type: 'stt',
      text
    }));

    // Step 3: Brain (Claude Code)
    console.log('[brain] thinking...');
    let reply;
    try {
      reply = await brain.think(text);
    } catch (err) {
      console.error('[brain] error:', err.message);
      reply = '抱歉，我处理出错了。';
    }

    console.log(`[brain] reply: "${reply.slice(0, 100)}${reply.length > 100 ? '...' : ''}"`);

    // Send emotion/expression to device
    safeSend(ws, JSON.stringify({
      session_id: currentSession.sessionId,
      type: 'llm',
      emotion: 'happy',
      text: '😀'
    }));

    // Step 4: TTS
    await sendTTS(ws, reply);

  } catch (err) {
    console.error('[process] pipeline error:', err.message);
  } finally {
    currentSession.state = 'idle';
  }
}

async function sendTTS(ws, text) {
  if (!text) return;

  try {
    // Signal TTS start
    safeSend(ws, JSON.stringify({
      session_id: currentSession.sessionId,
      type: 'tts',
      state: 'start'
    }));

    currentSession.state = 'speaking';

    // Generate TTS audio (returns WAV buffer, 24kHz 16-bit mono)
    const wavData = await tts.synthesize(text);

    // Extract PCM (skip 44-byte WAV header)
    const pcmData = wavData.slice(44);
    const sampleRate = 24000;
    const frameSize = Math.floor(sampleRate * 0.06);
    const frameBytes = frameSize * 2;

    // Encode and stream OPUS frames
    const encoder = audio.getEncoder();
    for (let offset = 0; offset < pcmData.length; offset += frameBytes) {
      const chunk = pcmData.slice(offset, offset + frameBytes);
      if (chunk.length < frameBytes) {
        const padded = Buffer.alloc(frameBytes, 0);
        chunk.copy(padded);
        try { safeSend(ws, encoder.encode(padded)); } catch (e) {}
        break;
      }
      try { safeSend(ws, encoder.encode(chunk)); } catch (e) {}
    }

    // Signal TTS stop
    safeSend(ws, JSON.stringify({
      session_id: currentSession.sessionId,
      type: 'tts',
      state: 'stop'
    }));
  } catch (err) {
    console.error('[tts] error:', err.message);
    safeSend(ws, JSON.stringify({
      session_id: currentSession.sessionId,
      type: 'tts',
      state: 'stop'
    }));
  }
}

// ─── Helpers ────────────────────────────────────────────────

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(data);
  } catch (e) {}
}

function generateId() {
  return 'xxxx'.replace(/x/g, () => Math.random().toString(36).charAt(2));
}

// ─── Terminal text input (for testing without ESP32) ────────

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

console.log('\n=== 小智桥接服务器 ===');
console.log(`TTS 引擎: Edge TTS (${config.tts.voice || 'zh-CN-XiaoxiaoNeural'})`);
console.log('');

(async () => {
  const ip = await getLocalIP();
  console.log(`📡 WebSocket 服务器: ws://${ip}:${WSS_PORT}`);
  console.log(`🔗 OTA 端点: http://${ip}:${OTA_PORT}`);
  console.log(`📱 Web 客户端: http://${ip}:${OTA_PORT}/`);
  console.log(`📱 Web(HTTPS): https://${ip}:${SSL_PORT}/`);
  console.log('📝 ESP32 固件改 CONFIG_OTA_URL 为此地址并重刷');
  console.log('📝 在终端输入文字即可对话 (输入 /help 查看命令)');
  console.log('');
  startRepl();
})();

// ─── HTTP Voice Request Handler ──────────────────────────

async function handleVoiceRequest(wavData) {
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

  // TTS
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
