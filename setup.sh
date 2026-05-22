#!/bin/bash
# Setup script for xiaozhi-bridge
# Install dependencies for STT (whisper.cpp) and configure the bridge

set -e

echo "=== 小智桥接服务器 依赖安装 ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 需要 Node.js，请先安装"
    exit 1
fi
echo "✅ Node.js $(node --version)"

# Install npm dependencies
echo ""
echo "📦 安装 npm 依赖..."
npm install

# Check/Install whisper.cpp for STT
echo ""
echo "🎙️  语音识别 (STT) 配置..."

WHISPER_CMD=""
for cmd in whisper whisper-cli whisper-cpp; do
    if command -v $cmd &> /dev/null; then
        WHISPER_CMD=$cmd
        break
    fi
done

if [ -n "$WHISPER_CMD" ]; then
    echo "✅ 已安装: $WHISPER_CMD"
else
    echo ""
    echo "是否安装 whisper.cpp？（语音识别必选）"
    echo "1) 用 Homebrew 安装 (推荐)"
    echo "2) 从源码编译"
    echo "3) 跳过，稍后手动安装"
    read -p "请选择 [1/2/3]: " choice

    case $choice in
        1)
            echo "📦 通过 Homebrew 安装..."
            if ! command -v brew &> /dev/null; then
                echo "❌ 需要 Homebrew，请先安装: https://brew.sh"
                echo "或者选择选项 2 从源码编译"
            else
                if brew tap homebrew/custom 2>/dev/null; then true; fi
                brew install whisper-cpp 2>/dev/null || brew install whisper 2>/dev/null || {
                    echo "⚠️  Homebrew 安装失败，从源码编译..."
                    build_whisper
                }
            fi
            ;;
        2)
            build_whisper
            ;;
        *)
            echo "跳过 whisper.cpp 安装"
            ;;
    esac
fi

# Download whisper model (base, supports Chinese)
if command -v whisper &> /dev/null || command -v whisper-cli &> /dev/null; then
    MODEL_DIR="${HOME}/.whisper-models"
    MODEL_FILE="${MODEL_DIR}/ggml-base.bin"

    if [ ! -f "$MODEL_FILE" ]; then
        echo ""
        echo "📥 下载语音识别模型 (ggml-base.bin, ~150MB)..."
        mkdir -p "$MODEL_DIR"
        echo "从 HuggingFace 下载..."
        curl -L -o "$MODEL_FILE" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
            --progress-bar

        if [ -f "$MODEL_FILE" ]; then
            echo "✅ 模型已下载: ${MODEL_FILE}"
        else
            echo "❌ 下载失败，请手动下载:"
            echo "   curl -L -o ~/.whisper-models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
        fi
    else
        echo "✅ 模型已存在: ${MODEL_FILE}"
    fi

    # Update config
    echo "📝 更新配置..."
    cat > config.json << CONFIGEOF
{
  "port": 8080,
  "wssPort": 8080,
  "stt": {
    "engine": "whisper",
    "model": "${MODEL_FILE}"
  },
  "tts": {
    "voice": "Eddy (中文（中国大陆）)",
    "rate": 200
  },
  "claude": {
    "maxHistory": 20,
    "timeout": 120000
  }
}
CONFIGEOF
    echo "✅ 配置已更新"
fi

# Check TTS
echo ""
echo "🔊 语音合成 (TTS) 检查..."
if command -v say &> /dev/null; then
    echo "✅ macOS say 可用"
    CHINESE_VOICE=$(say -v '?' | grep "zh_CN" | head -1 | awk -F'  ' '{print $1}' | xargs)
    if [ -n "$CHINESE_VOICE" ]; then
        echo "   中文语音: $CHINESE_VOICE"
    else
        echo "   未找到中文语音，将用英文语音"
    fi
else
    echo "❌ 未找到 say 命令"
fi

# Check Claude Code
echo ""
echo "🤖 Claude Code 检查..."
if command -v claude &> /dev/null; then
    echo "✅ claude 可用 ($(claude --version 2>/dev/null || echo 'unknown'))"
else
    echo "❌ 未找到 claude 命令"
    echo "   请确保 Claude Code 已安装"
fi

echo ""
echo "========================================"
echo "🎉 安装完成！"
echo ""
echo "启动服务器:"
echo "  cd $(pwd) && npm start"
echo ""
echo "然后在小智固件中配置 WebSocket 地址:"
echo "  ws://你的Mac局域网IP:8080"
echo "========================================"

function build_whisper() {
    echo "📦 从源码编译 whisper.cpp..."
    if ! command -v git &> /dev/null; then
        echo "❌ 需要 git"
        return 1
    fi

    TMP_DIR=$(mktemp -d)
    cd "$TMP_DIR"
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
    cd whisper.cpp
    make -j $(sysctl -n hw.logicalcpu)

    # Install to /usr/local/bin or ~/.local/bin
    BIN_DIR="${HOME}/.local/bin"
    mkdir -p "$BIN_DIR"
    cp main "$BIN_DIR/whisper"
    echo "✅ whisper.cpp 编译完成，安装到 ${BIN_DIR}/whisper"

    # Add to PATH if not already
    if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
        echo "export PATH=\"\$PATH:${BIN_DIR}\"" >> "${HOME}/.zshrc"
        echo "已将 ${BIN_DIR} 添加到 PATH (~/.zshrc)"
    fi

    export PATH="$PATH:${BIN_DIR}"
    WHISPER_CMD="${BIN_DIR}/whisper"
    cd - > /dev/null
    rm -rf "$TMP_DIR"
}
