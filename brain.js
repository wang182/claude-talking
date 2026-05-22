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

// ─── Persistent Claude Code session (via PTY) ─────────────────
let proc = null;
let ready = false;

// System prompt
const SYSTEM_PROMPT = `你现在通过语音与用户对话，全程使用简体中文。

规则：
- 用口语化的方式回复，像平时说话一样自然
- 可以回复多段内容，但保持口语化，不要念书面语长句
- 不要输出代码块、不要输出工具调用详情、不要输出Markdown格式
- 如果用户要求查看或修改代码，你可以正常使用工具操作
- 工具操作完后，用口语告诉用户结果即可`;

/**
 * Spawn claude via `script` (PTY) so it stays in interactive mode
 * even though we're piping stdin/stdout.
 */
function startSession() {
  return new Promise((resolve) => {
    const args = [
      '-q', '/dev/null',               // script flags: quiet, discard timing
      CLAUDE_PATH,
      '--add-dir', '/Users/wang',
      '--add-dir', '/Users/wang/Desktop',
      '--dangerously-skip-permissions',
      '--effort', 'high',
    ];

    proc = spawn('script', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_OUTPUT_MODE: 'plain' },
    });

    // Log stderr for debugging
    proc.stderr.on('data', (d) => process.stderr.write(`[brain:err] ${d}`));
    proc.on('exit', () => { proc = null; ready = false; });

    // Wait for first shell prompt, then send system prompt
    waitForPrompt(() => {
      proc.stdin.write(SYSTEM_PROMPT + '\n');
      waitForPrompt(() => {
        ready = true;
        resolve();
      });
    });
  });
}

/**
 * Wait for the next shell prompt `> ` at end of PTY output
 */
function waitForPrompt(callback) {
  let acc = '';
  const handler = (data) => {
    acc += stripAnsi(data.toString());
    if (isAtPrompt(acc)) {
      proc.stdout.removeListener('data', handler);
      callback();
    }
  };
  proc.stdout.on('data', handler);
}

/**
 * Check if text ends at `> ` prompt
 */
function isAtPrompt(text) {
  const idx = text.lastIndexOf('\n');
  if (idx === -1) return false;
  return /^>\s*$/.test(text.slice(idx + 1));
}

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
             .replace(/\x1B\][0-9;]*\x1B\\/g, '')
             .replace(/\r/g, '');
}

/**
 * Ensure session is running
 */
function ensureSession() {
  if (proc && ready) return Promise.resolve();
  return startSession();
}

/**
 * Process user input through the persistent Claude Code session.
 * @param {string} text - user's speech text
 * @returns {Promise<string>} Claude's spoken response
 */
async function think(text) {
  await ensureSession();
  ready = false;

  let response = '';

  return new Promise((resolve) => {
    const handler = (data) => {
      response += stripAnsi(data.toString());
      if (isAtPrompt(response)) {
        proc.stdout.removeListener('data', handler);
        ready = true;
        const result = response.replace(/\n>\s*$/, '').trim();
        resolve(cleanResponse(result));
      }
    };

    proc.stdout.on('data', handler);
    proc.stdin.write(text + '\n');

    setTimeout(() => {
      proc.stdout.removeListener('data', handler);
      ready = true;
      const result = response.replace(/\n>\s*$/, '').trim();
      resolve(cleanResponse(result) || '(timeout)');
    }, 120000);
  });
}

/**
 * Clean Claude's response for TTS
 */
function cleanResponse(text) {
  return text
    .replace(/^> .*(\n|$)/gm, '')         // input echo
    .replace(/```[\s\S]*?```/g, '')       // code blocks
    .replace(/`[^`]+`/g, '')              // inline code
    .replace(/^[─┌└│├┤┬┴┼┐┘]+.*$/gm, '') // box-drawing chars
    .replace(/^[>\s]*─+.*$/gm, '')        // lines with >
    .replace(/^\d+[:.].*$/gm, '')         // numbered lines
    .replace(/[\w./-]+\/\w+\.\w+/g, '某个文件')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reset — kill session
 */
function reset() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    proc = null;
  }
  ready = false;
}

function historySize() {
  return ready ? 1 : 0;
}

module.exports = { think, reset, historySize };
