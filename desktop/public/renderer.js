// ─── Audio Capture ──────────────────────────────────────────
let audioCtx = null;
let micStream = null;
let scriptNode = null;
let pcmChunks = [];
let isRecording = false;
let isProcessing = false;

const TARGET_SAMPLE_RATE = 16000;

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

// ─── Start / Stop Recording ─────────────────────────────────

async function startRecording() {
  if (isRecording || isProcessing) return;

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

    const source = ctx.createMediaStreamSource(micStream);
    const inputSampleRate = ctx.sampleRate;

    pcmChunks = [];

    scriptNode = ctx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
    };

    source.connect(scriptNode);
    scriptNode.connect(ctx.destination);

    isRecording = true;
    setStatus('recording', '🎙️ 录音中...');
    updateMicButton(true);
  } catch (err) {
    setStatus('error', '麦克风权限被拒绝');
    console.error('Mic error:', err);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  // Cleanup audio graph
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  setStatus('busy', '⏳ 处理中...');
  updateMicButton(false, true);

  // Concatenate all PCM chunks
  const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const allSamples = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of pcmChunks) {
    allSamples.set(chunk, offset);
    offset += chunk.length;
  }

  setTimeout(() => processAudioData(allSamples), 50);
}

// ─── Process Audio Data ────────────────────────────────────

async function processAudioData(rawSamples) {
  isProcessing = true;

  try {
    const ctx = audioCtx;
    const inputRate = ctx ? ctx.sampleRate : 48000;
    const downsampled = downsample(rawSamples, inputRate);

    const wavBuffer = encodeWAV(downsampled, TARGET_SAMPLE_RATE);
    const logSize = (wavBuffer.byteLength / 1024).toFixed(0);
    showLog(`发送 ${logSize}KB`);

    const result = await window.api.processAudio(wavBuffer);

    if (!result.ok) {
      setStatus('error', `错误: ${result.error}`);
      showLog(result.error);
      addMessage('user', '(语音输入失败)');
      isProcessing = false;
      return;
    }

    showLog(`识别: ${result.text}`);
    addMessage('user', result.text);

    setStatus('busy', '🔊 播放中...');

    // Play response
    await playWavBase64(result.wavBase64);

    addMessage('assistant', result.reply);
    setStatus('ready', '就绪');
    showLog('');
  } catch (err) {
    setStatus('error', err.message);
    showLog(err.message);
  }

  isProcessing = false;
}

// ─── Audio Playback ────────────────────────────────────────

async function playWavBase64(base64) {
  return new Promise(async (resolve) => {
    try {
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const ctx = await getAudioContext();
      ctx.decodeAudioData(bytes.buffer, (buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => resolve();
        source.start();
      }, () => resolve());
    } catch {
      resolve(); // Don't hang on playback error
    }
  });
}

// ─── Camera ─────────────────────────────────────────────────

let cameraStream = null;
let cameraEnabled = false;

async function toggleCamera() {
  const preview = document.getElementById('cameraPreview');
  const section = document.getElementById('cameraSection');

  if (cameraEnabled) {
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    cameraEnabled = false;
    preview.srcObject = null;
    section.classList.add('hidden');
    document.getElementById('cameraToggle').classList.remove('active');
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    preview.srcObject = cameraStream;
    cameraEnabled = true;
    section.classList.remove('hidden');
    document.getElementById('cameraToggle').classList.add('active');
  } catch {
    setStatus('error', '摄像头不可用');
  }
}

function captureFrame() {
  if (!cameraEnabled || !cameraStream) return null;
  const video = document.getElementById('cameraPreview');
  const canvas = document.getElementById('cameraCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.7).split(',')[1]; // base64
}

// ─── UI ─────────────────────────────────────────────────────

function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  dot.className = 'dot ' + state;
  statusText.textContent = text;
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
  msg.textContent = text;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// ─── Event Listeners ───────────────────────────────────────

const micButton = document.getElementById('micButton');
const cameraToggle = document.getElementById('cameraToggle');

micButton.addEventListener('mousedown', startRecording);
micButton.addEventListener('mouseup', stopRecording);
micButton.addEventListener('mouseleave', () => {
  if (isRecording) stopRecording();
});

// Touch support
micButton.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
});
micButton.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});

cameraToggle.addEventListener('click', toggleCamera);

// ─── Init ───────────────────────────────────────────────────

(async function init() {
  try {
    const ctx = await getAudioContext();
    // Resume if suspended (autoplay policy)
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {}

  // Pre-check status
  try {
    const status = await window.api.checkStatus();
    if (!status.stt) {
      setStatus('error', 'STT 不可用，请安装 whisper.cpp');
    }
  } catch {}

  // Keyboard shortcut: space to talk
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space' && !e.repeat && !isRecording && !isProcessing) {
      e.preventDefault();
      startRecording();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && isRecording) {
      e.preventDefault();
      stopRecording();
    }
  });
})();
