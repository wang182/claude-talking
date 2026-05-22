const { spawn } = require('child_process');

// ─── Find Claude Code binary ──────────────────────────────────
function findClaude() {
  const candidates = ['claude', '~/.local/bin/claude'];
  for (const cmd of candidates) {
    try {
      const expanded = cmd.replace('~', process.env.HOME || '');
      const which = require('child_process').execSync(`which ${expanded} 2>/dev/null || echo ""`, { encoding: 'utf8' }).trim();
      if (which) return which;
    } catch {}
  }
  return 'claude';
}

const CLAUDE_PATH = findClaude();

// ─── Conversation state ──────────────────────────────────────
let isFirstMessage = true;

const SYSTEM_PROMPT = `你叫克劳德，你是老板的工作助手，老板是你的上级。全程使用简体中文。

规则：
- 用口语化的方式回复，像平时说话一样自然
- 可以回复多段内容，但保持口语化，不要念书面语长句
- 不要输出代码块、不要输出工具调用详情、不要输出Markdown格式
- 如果老板要求查看或修改代码，你可以正常使用工具操作
- 工具操作完后，用口语告诉老板结果即可`;

/**
 * Build Claude Code CLI arguments
 */
function buildArgs() {
  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--effort', 'high',
    '--add-dir', '/Users/wang',
    '--add-dir', '/Users/wang/Desktop',
  ];
  if (!isFirstMessage) {
    args.push('--continue');
  }
  return args;
}

/**
 * Build prompt text — include system prompt only on first message
 */
function buildPrompt(text) {
  if (isFirstMessage) {
    return `${SYSTEM_PROMPT}\n\n用户说：${text}`;
  }
  return `用户说：${text}`;
}

// ─── Warmup ────────────────────────────────────────────────
let warmupPromise = null;

/**
 * Start a Claude session in the background so the first real
 * user message uses --continue and is much faster.
 */
async function warmup() {
  if (warmupPromise) return warmupPromise;
  warmupPromise = runClaude(`${SYSTEM_PROMPT}\n\n（初始化准备完毕）`)
    .then(() => {
      isFirstMessage = false;
    })
    .catch(err => {
      console.error('[brain] warmup failed:', err.message);
      isFirstMessage = true;
      warmupPromise = null;
    });
  return warmupPromise;
}

/**
 * Process user input through Claude Code (one-shot --print with --continue)
 * @param {string} text - user's speech text
 * @returns {Promise<string>} Claude's response
 */
async function think(text) {
  // If warmup is still in progress, wait for it first
  if (warmupPromise) {
    await warmupPromise;
    warmupPromise = null;
  }

  const prompt = buildPrompt(text);

  try {
    const response = await runClaude(prompt);
    isFirstMessage = false;
    return cleanResponse(response);
  } catch (err) {
    console.error('[brain] claude error:', err.message);
    // If --continue fails (e.g. lost session), fall back to fresh session
    if (!isFirstMessage) {
      isFirstMessage = true;
      try {
        const prompt2 = `${SYSTEM_PROMPT}\n\n用户说：${text}`;
        const response = await runClaude(prompt2);
        isFirstMessage = false;
        return cleanResponse(response);
      } catch (err2) {
        return `抱歉，我处理出错：${err2.message}`;
      }
    }
    return `抱歉，我处理出错：${err.message}`;
  }
}

/**
 * Run claude --print with the given prompt
 */
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, buildArgs(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
      env: { ...process.env, CLAUDE_CODE_OUTPUT_MODE: 'plain' },
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

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Clean Claude's response for TTS
 */
function cleanResponse(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/^[─┌└│├┤┬┴┼┼┐┘└┴┬├─┼│]+.*$/gm, '')
    .replace(/^[>\s]*─+.*$/gm, '')
    .replace(/^\d+[:.].*$/gm, '')
    .replace(/[\w./-]+\/\w+\.\w+/g, '某个文件')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reset conversation — starts fresh session on next call
 */
function reset() {
  isFirstMessage = true;
}

/**
 * Get conversation state
 */
function historySize() {
  return isFirstMessage ? 0 : 1;
}

module.exports = { think, reset, historySize, warmup };
