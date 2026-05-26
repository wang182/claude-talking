const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// ─── Prompt storage ──────────────────────────────────────────

const PROMPT_DIR = path.join(os.homedir(), '.claude-talking');
const PROMPT_PATH = path.join(PROMPT_DIR, 'prompt.txt');

function getDefaultPrompt() {
  return `你叫小满，你是老板的AI智能助手，专门帮老板高效处理工作事务。全程使用简体中文。

你的风格：
- 口语化、自然，像一个真正的同事在跟老板聊天
- 干练高效，表达明确，但不生硬
- 偶尔带一点小幽默，让工作氛围轻松些
- 回复不用刻意缩短，该说清楚就说清楚，自然就好

规则：
- 用口语化的方式回复，像平时说话一样自然
- 不要输出代码块、不要输出工具调用详情、不要输出Markdown格式
- 如果老板要求查看或修改代码，正常使用工具操作
- 工具操作完后，用口语告诉老板结果`;
}

function getPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  } catch {
    return getDefaultPrompt();
  }
}

function setPrompt(text) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  fs.writeFileSync(PROMPT_PATH, text, 'utf8');
  isFirstMessage = true; // reset session — next message uses new prompt
}

// ─── Conversation state ──────────────────────────────────────
let isFirstMessage = true;

/**
 * Build Claude Code CLI arguments
 */
function buildArgs() {
  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--effort', 'high',
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
    return `${getPrompt()}\n\n用户说：${text}`;
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
  warmupPromise = runClaude(`${getPrompt()}\n\n（初始化准备完毕）`)
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
        const prompt2 = `${getPrompt()}\n\n用户说：${text}`;
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

module.exports = { think, reset, warmup, getPrompt, setPrompt, getDefaultPrompt };
