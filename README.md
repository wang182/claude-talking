# Claude Talking

Voice assistant for [Claude Code](https://claude.ai) — talk to Claude using your microphone, listen to responses via TTS, and optionally connect over WebSocket from an ESP32-S3 device.

## Features

- 🎙️ **Voice input** (STT via whisper.cpp)
- 🔊 **Voice output** (TTS via Microsoft Edge TTS)
- ⌨️ **Text input** — fall back to typing when you prefer
- 💬 **Markdown rendering** — bold, italic, code blocks in responses
- 🤔 **Thinking indicator** — visual feedback while Claude processes
- 💻 **macOS Desktop app** — packaged with Electron for native experience
- 🌐 **Web server** — browser-based interface on `localhost:8080`
- 📡 **ESP32-S3 bridge** — real-time voice chat from IoT devices (WebSocket + OPUS)

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌───────────┐
│  Mic / Text  │ ──▶ │  STT     │ ──▶ │  Claude  │ ──▶ │   TTS     │
│  (Browser)   │     │ (whisper)│     │  (Code)  │     │ (EdgeTTS) │
└─────────────┘     └──────────┘     └──────────┘     └───────────┘
                                                        │
                                                        ▼
                                                 ┌─────────────┐
                                                 │  Speaker     │
                                                 │  (Browser)   │
                                                 └─────────────┘
```

## Quick Start

### Requirements

- Node.js >= 18
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) compiled (`whisper-cli` in PATH)
- A whisper model (e.g. `ggml-small.bin`)
- Claude Code CLI installed and authenticated

### Install & Run (Web)

```bash
npm install
npm start
```

Open `http://localhost:8080` in your browser.

### Desktop App (macOS)

```bash
cd desktop
npm install
npm start
```

Or build a distributable:

```bash
cd desktop
npm run build
# Output: desktop/dist/Claude桌面助手-*.dmg
```

### Configuration

Edit `config.json`:

```json
{
  "stt": { "model": "/path/to/ggml-model.bin" },
  "tts": { "voice": "zh-CN-XiaoxiaoNeural", "rate": "+10%" },
  "claude": { "maxHistory": 20, "timeout": 120000 }
}
```

The Claude model is read from `~/.claude/settings.json` (`env.ANTHROPIC_MODEL`).

---

# Claude 语音助手

[Claude Code](https://claude.ai) 的语音助手 — 用麦克风与 Claude 对话，或通过 WebSocket 从 ESP32-S3 设备连接。

## 功能

- 🎙️ **语音输入**（通过 whisper.cpp 语音识别）
- 🔊 **语音输出**（通过微软 Edge TTS）
- ⌨️ **文字输入** — 不想说话时直接打字
- 💬 **Markdown 渲染** — 加粗、斜体、代码块正常显示
- 🤔 **思考指示器** — Claude 处理时显示加载动画
- 💻 **macOS 桌面应用** — Electron 打包，原生体验
- 🌐 **Web 服务器** — 浏览器访问 `localhost:8080`
- 📡 **ESP32-S3 桥接** — 物联网设备实时语音对话（WebSocket + OPUS）

## 架构

```
┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌───────────┐
│  麦克风/文字  │ ──▶ │  语音识别  │ ──▶ │  Claude  │ ──▶ │  语音合成  │
│  (浏览器)    │     │ (whisper) │     │  (Code)  │     │ (EdgeTTS) │
└─────────────┘     └──────────┘     └──────────┘     └───────────┘
                                                        │
                                                        ▼
                                                 ┌─────────────┐
                                                 │   扬声器     │
                                                 │  (浏览器)    │
                                                 └─────────────┘
```

## 快速开始

### 依赖

- Node.js >= 18
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) 已编译（`whisper-cli` 在 PATH 中）
- whisper 模型（如 `ggml-small.bin`）
- Claude Code CLI 已安装并登录

### 安装和运行（Web）

```bash
npm install
npm start
```

浏览器访问 `http://localhost:8080`。

### 桌面应用（macOS）

```bash
cd desktop
npm install
npm start
```

打包分发版：

```bash
cd desktop
npm run build
# 输出: desktop/dist/Claude桌面助手-*.dmg
```

### 配置

编辑 `config.json`：

```json
{
  "stt": { "model": "/path/to/ggml-model.bin" },
  "tts": { "voice": "zh-CN-XiaoxiaoNeural", "rate": "+10%" },
  "claude": { "maxHistory": 20, "timeout": 120000 }
}
```

Claude 模型从 `~/.claude/settings.json` 的 `env.ANTHROPIC_MODEL` 动态读取。
