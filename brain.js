const { spawn, execFile } = require('child_process');

// Find Claude Code binary
function findClaude() {
  const candidates = ['claude', '~/.local/bin/claude'];
  for (const cmd of candidates) {
    try {
      const expanded = cmd.replace('~', process.env.HOME || '');
      const which = require('child_process').execSync(`which ${expanded} 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
      if (which) return which;
    } catch {}
  }
  return 'claude'; // fallback
}

const CLAUDE_PATH = findClaude();

// Conversation history
let history = [];
const MAX_HISTORY = 20; // keep last 20 turns

// System prompt for voice mode
const SYSTEM_PROMPT = `你现在通过语音与用户对话。

规则：
- 用口语化的方式回复，像平时说话一样自然
- 可以回复多段内容，但保持口语化，不要念书面语长句
- 不要输出代码块、不要输出工具调用详情、不要输出Markdown格式
- 如果用户要求查看或修改代码，你可以正常使用工具操作
- 工具操作完后，用口语告诉用户结果即可`;

/**
 * Process user input through Claude Code
 * @param {string} text - user's speech text
 * @returns {Promise<string>} Claude's text response (for TTS)
 */
async function think(text) {
  // Build prompt with history
  const historyBlock = history.map(h =>
    `${h.role === 'user' ? '用户' : '助手'}：${h.content}`
  ).join('\n');

  const prompt = `${SYSTEM_PROMPT}

${historyBlock ? '对话历史：\n' + historyBlock + '\n' : ''}
用户说：${text}

请用口语回复：`;

  try {
    const response = await runClaude(prompt);
    // Clean up response
    const cleaned = cleanResponse(response);

    // Update history
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: cleaned });
    if (history.length > MAX_HISTORY * 2) {
      history = history.slice(-MAX_HISTORY * 2);
    }

    return cleaned;
  } catch (err) {
    console.error('[brain] claude error:', err.message);
    return `抱歉，我处理出错：${err.message}`;
  }
}

/**
 * Run claude --print with the given prompt
 */
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, ['--print', '--add-dir', '/Users/wang', '--add-dir', '/Users/wang/Desktop', '--dangerously-skip-permissions'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
      env: { ...process.env, CLAUDE_CODE_OUTPUT_MODE: 'plain' }
    });

    let output = '';
    let error = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      error += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 && !output) {
        reject(new Error(`claude exited with code ${code}: ${error}`));
      } else {
        resolve(output || error);
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start claude: ${err.message}`));
    });

    // Send prompt
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Clean Claude's response for TTS
 * Remove code blocks, markdown, tool details
 */
function cleanResponse(text) {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    // Remove lines that look like tool calls
    .replace(/^[─┌└│├┤┬┴┼┼┐┘└┴┬├─┼│]+.*$/gm, '')
    .replace(/^[>\s]*─+.*$/gm, '')
    .replace(/^\d+[:.].*$/gm, '')
    // Remove file paths
    .replace(/[\w./-]+\/\w+\.\w+/g, '某个文件')
    // Clean up extra whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reset conversation history
 */
function reset() {
  history = [];
}

/**
 * Get current history length
 */
function historySize() {
  return history.length;
}

module.exports = { think, reset, historySize };
