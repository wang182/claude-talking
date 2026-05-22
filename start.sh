#!/bin/bash
cd "$(dirname "$0")"
echo "=== 小智桥接服务器 ==="
echo "IP: $(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1):8080"
echo ""

# Check whisper
if ! command -v whisper-cli &> /dev/null; then
  echo "⚠️  whisper-cli 未安装，语音识别不可用"
  echo "   运行 bash setup.sh 安装"
fi

# Start server
node server.js
