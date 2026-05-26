// ─── Audio Capture ──────────────────────────────────────────
let audioCtx = null;
let micStream = null;
let scriptNode = null;
let pcmChunks = [];
let isRecording = false;
let isProcessing = false;
let pendingStart = false; // track async setup in progress
let currentAudio = null;  // reference to active TTS Audio element
let continuousMode = false;
let ttsEnabled = true;

const TARGET_SAMPLE_RATE = 16000;

// VAD (Voice Activity Detection) for continuous mode
const SILENCE_THRESHOLD = 0.008; // RMS below this = silence
const SILENCE_TIMEOUT_MS = 1200; // auto-stop after this much silence
const MIN_CHUNKS_FOR_VAD = 6;    // wait for ~500ms before VAD kicks in
let lastSoundTime = 0;
let chunkCount = 0;

async function getAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// ─── WAV Encoding (raw PCM Float32 → WAV ArrayBuffer) ──────

function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write samples (Float32 → Int16)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ─── Downsample (from AudioContext rate → 16kHz) ───────────

function downsample(samples, fromRate) {
  if (fromRate === TARGET_SAMPLE_RATE) return samples;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const newLength = Math.floor(samples.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    result[i] = samples[Math.floor(i * ratio)];
  }
  return result;
}

// ─── Start / Stop Recording (toggle mode) ───────────────────

async function startRecording() {
  if (isRecording || isProcessing || pendingStart) return;
  cancelPlayback(); // stop any ongoing TTS
  pendingStart = true;

  try {
    const ctx = await getAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: { ideal: 48000 },
      },
    });

    // Check if user cancelled while we were setting up
    if (!pendingStart) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
      return;
    }

    const source = ctx.createMediaStreamSource(micStream);

    pcmChunks = [];
    chunkCount = 0;
    lastSoundTime = Date.now();
    scriptNode = ctx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      pcmChunks.push(data);
      chunkCount++;

      // VAD: auto-stop on silence in continuous mode
      if (continuousMode && chunkCount > MIN_CHUNKS_FOR_VAD) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > SILENCE_THRESHOLD) {
          lastSoundTime = Date.now();
        } else if (Date.now() - lastSoundTime > SILENCE_TIMEOUT_MS) {
          stopRecording();
        }
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(ctx.destination);

    isRecording = true;
    pendingStart = false;
    setStatus('recording', '🎙️ 录音中...');
    updateMicButton(true);
    document.getElementById('hintText').textContent = '点击停止';
  } catch (err) {
    pendingStart = false;
    setStatus('error', '麦克风权限被拒绝');
    console.error('Mic error:', err);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  // Cancel if no audio captured
  if (pcmChunks.length === 0) {
    cleanupAudio();
    setStatus('ready', '就绪');
    updateMicButton(false);
    document.getElementById('hintText').textContent = '点击说话';
    return;
  }

  // Cleanup audio graph
  cleanupAudio();

  setStatus('busy', '⏳ 处理中...');
  updateMicButton(false, true);
  document.getElementById('hintText').textContent = '处理中...';

  // Concatenate all PCM chunks
  const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const allSamples = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of pcmChunks) {
    allSamples.set(chunk, offset);
    offset += chunk.length;
  }

  processAudioData(allSamples);
}

function cancelRecording() {
  continuousMode = false;
  if (pendingStart) pendingStart = false;
  if (isRecording) isRecording = false;
  cleanupAudio();
  setStatus('ready', '就绪');
  updateMicButton(false);
  document.getElementById('hintText').textContent = '点击说话';
  showLog('');
}

function cleanupAudio() {
  if (scriptNode) {
    try { scriptNode.disconnect(); } catch {}
    scriptNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
}

// ─── Process Audio Data ────────────────────────────────────

async function processAudioData(rawSamples) {
  isProcessing = true;

  try {
    const ctx = audioCtx;
    const inputRate = ctx ? ctx.sampleRate : 48000;
    const downsampled = downsample(rawSamples, inputRate);
    const wavBuffer = encodeWAV(downsampled, TARGET_SAMPLE_RATE);

    // Step 1: STT — transcribe audio
    showLog('识别中...');
    const sttResult = await window.api.transcribeAudio(wavBuffer);
    if (!sttResult.ok || !sttResult.text) {
      setStatus('ready', '就绪');
      showLog('');
      addMessage('user', '(语音输入失败)');
      isProcessing = false;
      return;
    }

    const text = sttResult.text;
    showLog(`识别: ${text}`);
    addMessage('user', text);

    // Step 2: Thinking — show indicator in conversation (same as text mode)
    showThinking();
    setStatus('busy', '思考中...');

    // Step 3: Brain — get Claude's reply
    const thinkResult = await window.api.thinkText(text);
    hideThinking();

    if (!thinkResult.ok || !thinkResult.reply) {
      setStatus('ready', '就绪');
      showLog('');
      addMessage('assistant', `(错误: ${thinkResult.reply || '无回复'})`);
      isProcessing = false;
      return;
    }

    const reply = thinkResult.reply;
    addMessage('assistant', reply);

    // Unblock immediately so user can send next message while TTS plays
    setStatus('ready', '就绪');
    showLog('');
    document.getElementById('hintText').textContent = continuousMode
      ? '连续对话中，按 Esc 退出'
      : '点击说话 / 空格键连续对话';
    isProcessing = false;

    // Step 4: TTS — synthesize and play in background
    if (ttsEnabled) {
      const ttsResult = await window.api.synthesizeText(reply);
      if (ttsResult.ok && ttsResult.wavBase64) {
        await playAudioBase64(ttsResult.wavBase64);
        if (continuousMode) {
          setTimeout(() => {
            if (continuousMode && !isRecording && !isProcessing) {
              startRecording();
            }
          }, 600);
        }
      }
    }

    setStatus('ready', '就绪');
  } catch (err) {
    hideThinking();
    setStatus('error', err.message);
    showLog(err.message);
    document.getElementById('hintText').textContent = '点击说话';
    isProcessing = false;
  }
}

// ─── Audio Playback (MP3 via blob URL) ─────────────────────

async function playAudioBase64(base64) {
  return new Promise((resolve) => {
    try {
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      const done = () => {
        if (currentAudio === audio) currentAudio = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    } catch {
      currentAudio = null;
      resolve();
    }
  });
}

function cancelPlayback() {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.src = '';
    } catch {}
    currentAudio = null;
  }
}

// ─── UI ─────────────────────────────────────────────────────

const DOT_COLORS = { ready: '#2ecc71', busy: '#f39c12', error: '#e74c3c' };
let modelName = '';

function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  dot.className = 'dot';
  dot.style.background = DOT_COLORS[state] || '#e74c3c';
  statusText.textContent = text;
}

function setModelLabel(text) {
  document.getElementById('modelLabel').textContent = text;
}

function updateMicButton(recording, processing) {
  const btn = document.getElementById('micButton');
  const ring = document.getElementById('pulseRing');
  btn.classList.toggle('recording', recording);
  btn.classList.toggle('processing', processing);
  ring.classList.toggle('active', recording);
}

function showLog(text) {
  const box = document.getElementById('logBox');
  const el = document.getElementById('logText');
  el.textContent = text;
  box.style.display = text ? 'block' : 'none';
}

function addMessage(role, text) {
  const container = document.getElementById('conversation');
  const msg = document.createElement('div');
  msg.className = `msg msg-${role}`;
  if (role === 'assistant') {
    msg.innerHTML = renderMarkdown(text);
  } else if (text.includes('<img') || text.includes('<svg')) {
    msg.innerHTML = text;
  } else {
    msg.textContent = text;
  }
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// ─── Markdown Renderer ────────────────────────────────────

function renderMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Protect code blocks from other transforms
  const codeBlocks = [];
  html = html.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Inline code
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+?)\*/g, (m, content) => {
    if (content.trim() && !content.startsWith(' ')) {
      return `<em>${content}</em>`;
    }
    return m;
  });

  // Restore code blocks with proper HTML
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    let block = codeBlocks[parseInt(idx)];
    block = block.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });
    return block;
  });

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ─── Thinking Indicator ───────────────────────────────────

let thinkingEl = null;

function showThinking() {
  if (thinkingEl) return;
  const container = document.getElementById('conversation');
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'msg msg-thinking';
  thinkingEl.id = 'thinkingIndicator';
  thinkingEl.innerHTML = '🤔 思考中<span class="thinking-dots"><span></span><span></span><span></span></span>';
  container.appendChild(thinkingEl);
  container.scrollTop = container.scrollHeight;
}

function hideThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

// ─── Image Attachment ──────────────────────────────────────

let pendingImageBase64 = null;
let pendingImageName = '';

function setPendingImage(base64, name) {
  pendingImageBase64 = base64;
  pendingImageName = name;
  const preview = document.getElementById('imagePreview');
  const img = document.getElementById('previewImg');
  img.src = base64;
  preview.style.display = 'block';
}

function clearPendingImage() {
  pendingImageBase64 = null;
  pendingImageName = '';
  const preview = document.getElementById('imagePreview');
  preview.style.display = 'none';
  document.getElementById('previewImg').src = '';
}

document.getElementById('imageBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    setPendingImage(ev.target.result, file.name);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

document.getElementById('removeImageBtn').addEventListener('click', clearPendingImage);

// Support pasting images from clipboard
document.getElementById('textInput').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        setPendingImage(ev.target.result, 'clipboard.png');
      };
      reader.readAsDataURL(blob);
      break;
    }
  }
});

// ─── Text Input ────────────────────────────────────────────

async function sendTextMessage() {
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  const hasImage = !!pendingImageBase64;
  if ((!text && !hasImage) || isProcessing) return;

  cancelPlayback();

  const imageBase64 = pendingImageBase64;
  clearPendingImage();

  input.value = '';
  input.style.height = '36px';
  isProcessing = true;

  // Show user message
  if (hasImage) {
    const img = `<img class="attached-image" src="${imageBase64}" alt="attached image">`;
    addMessage('user', text ? text + img : img);
  } else {
    addMessage('user', text);
  }
  showThinking();

  try {
    const result = hasImage
      ? await window.api.processTextWithImage(text, imageBase64)
      : await window.api.thinkText(text);

    hideThinking();
    if (!result.ok || !result.reply) {
      setStatus('ready', '就绪');
      addMessage('assistant', `(${result.reply || result.error || '无回复'})`);
      isProcessing = false;
      input.focus();
      return;
    }

    addMessage('assistant', result.reply);
    isProcessing = false;
    input.focus();

    // TTS in background
    if (ttsEnabled) {
      const ttsResult = await window.api.synthesizeText(result.reply);
      if (ttsResult.ok && ttsResult.wavBase64) {
        await playAudioBase64(ttsResult.wavBase64);
      }
    }

    setStatus('ready', '就绪');
  } catch (err) {
    hideThinking();
    setStatus('error', err.message);
    addMessage('assistant', `(错误: ${err.message})`);
    isProcessing = false;
  }
}

// ─── Event Listeners (toggle mode) ──────────────────────────

const micButton = document.getElementById('micButton');

function toggleMic() {
  if (isProcessing) return;
  if (isRecording || pendingStart) {
    stopRecording();
  } else {
    continuousMode = false;
    document.getElementById('hintText').textContent = '点击停止';
    startRecording();
  }
}

function startContinuousMode() {
  if (isRecording || isProcessing || pendingStart) return;
  continuousMode = true;
  document.getElementById('hintText').textContent = '连续对话中，按 Esc 退出';
  startRecording();
}

function exitContinuousMode() {
  continuousMode = false;
  cancelRecording();
  document.getElementById('hintText').textContent = '点击说话';
}

micButton.addEventListener('click', toggleMic);

// TTS toggle
document.getElementById('ttsToggle').addEventListener('click', () => {
  ttsEnabled = !ttsEnabled;
  const btn = document.getElementById('ttsToggle');
  btn.textContent = ttsEnabled ? '🔊' : '🔇';
  btn.classList.toggle('muted', !ttsEnabled);
  btn.title = ttsEnabled ? '语音播报开关' : '语音已关闭';
  showLog(ttsEnabled ? '语音播报已开启' : '语音播报已关闭');
  setTimeout(() => showLog(''), 1500);
});

// Right-click to cancel
micButton.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  exitContinuousMode();
});

// Touch support
micButton.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startContinuousMode();
});

// Text input events
const textInput = document.getElementById('textInput');
const sendButton = document.getElementById('sendButton');

// Auto-resize textarea
function autoResize() {
  textInput.style.height = '36px';
  textInput.style.height = Math.min(textInput.scrollHeight, 90) + 'px';
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendTextMessage();
  }
});

textInput.addEventListener('input', autoResize);

sendButton.addEventListener('click', sendTextMessage);

// ─── Init ───────────────────────────────────────────────────

(async function init() {
  try {
    const ctx = await getAudioContext();
    // Resume if suspended (autoplay policy)
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {}

  // Show warmup status — "就绪" only after 阿玲 is actually ready
  setStatus('busy', '启动中...');

  // Listen for warmup complete
  window.api.onWarmupReady(async () => {
    if (document.getElementById('statusText').textContent === '启动中...') {
      try {
        const status = await window.api.checkStatus();
        modelName = status.model ? `${status.model} (effort: high) |` : '';
        setModelLabel(modelName);
        setStatus('ready', '就绪');
      } catch {
        setStatus('ready', '就绪');
      }
    }
  });

  // Setup overlay — first-launch whisper download
  window.api.onSetupStart(() => {
    const overlay = document.getElementById('setupOverlay');
    if (overlay) overlay.style.display = 'flex';
  });

  window.api.onSetupProgress((info) => {
    const fill = document.getElementById('setupProgressFill');
    const pct = document.getElementById('setupPercent');
    const desc = document.getElementById('setupDesc');
    if (fill) fill.style.width = `${info.percent}%`;
    if (pct) pct.textContent = `${info.percent}%`;
    if (desc) desc.textContent = info.label || '';
  });

  window.api.onSetupDone((ok) => {
    const overlay = document.getElementById('setupOverlay');
    if (overlay) overlay.style.display = 'none';
  });

  // Pre-check status
  try {
    const status = await window.api.checkStatus();
    if (!status.stt) {
      setStatus('error', 'STT 不可用，请安装 whisper.cpp');
    }
  } catch {}

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Escape') {
      e.preventDefault();
      exitContinuousMode();
      return;
    }
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      if (isRecording || pendingStart) {
        stopRecording(); // single mode: stop
      } else if (continuousMode) {
        exitContinuousMode();
      } else {
        startContinuousMode(); // idle: start continuous conversation
      }
    }
  });
})();
