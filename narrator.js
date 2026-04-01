#!/usr/bin/env node

// Claude Code Narrator — Audio co-pilot for Claude Code
// Zero dependencies. Pure Node.js stdlib. macOS only (uses `say` + `afplay`).
// Reads hook JSON from stdin, speaks a narration, outputs JSON to stdout.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execSync, spawn } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const CONFIG_PATH = path.join(HOME, '.claude', 'narrator.json');
const MUTE_FILE = path.join(HOME, '.claude', 'narrator-muted');
const TMP_DIR = '/tmp';
const TMP_PREFIX = 'claude-narrator-';
const CACHE_DIR = path.join(HOME, '.claude', 'narrator-cache');
const SESSION_REGISTRY = '/tmp/claude-narrator-sessions.json';

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  voice: 'Samantha',
  rate: 210,
  volume: 0.5,
  tts: 'say',                // 'say' (macOS built-in) or 'elevenlabs'
  elevenlabs: null,           // { apiKey, voiceId?, model? }
  narrateTools: ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'Agent'],
  skipTools: [],
  narrateFailures: true,
  maxContextItems: 15,
  repetitionThreshold: 3,
  destructiveAlertSound: '/System/Library/Sounds/Basso.aiff',
  // Extra voices for concurrent sessions. Session 0 uses main voice/rate above.
  // Each entry: { voice, rate } for say, or { voice, rate, elevenLabsVoiceId } for ElevenLabs
  sessionVoices: [
    { voice: 'Daniel (Enhanced)', rate: 200 },
    { voice: 'Karen (Enhanced)', rate: 205 },
    { voice: 'Tessa (Enhanced)', rate: 200 },
  ],
};

// ─── Generic description filters ────────────────────────────────────────────

const GENERIC_DESC = [
  /^executes?\s/i,
  /^reads?\s+a\s+file/i,
  /^writes?\s+(a\s+)?file/i,
  /^performs?\s/i,
  /^runs?\s+a?\s?command/i,
  /^the\s+command\s+to\s+execute/i,
];

// ─── Destructive command patterns ───────────────────────────────────────────

const DESTRUCTIVE = [
  /\brm\s+(-\w+\s+)*-r/i,
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bsudo\s+rm\b/i,
  /\bdocker\s+system\s+prune\b/i,
];

// ─── Session detection ──────────────────────────────────────────────────────
// Each Claude Code session gets a distinct voice + phrasing style so you can
// tell concurrent sessions apart by ear.

const STALE_SESSION_MS = 30 * 60 * 1000; // 30 min without activity → expired

function getSessionNumber() {
  const myId = String(process.ppid);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(SESSION_REGISTRY, 'utf8'));
  } catch {
    registry = { sessions: {} };
  }

  const now = Date.now();

  // Expire stale sessions
  for (const [pid, info] of Object.entries(registry.sessions)) {
    if (now - info.lastSeen > STALE_SESSION_MS) delete registry.sessions[pid];
  }

  // Register or refresh this session
  if (!registry.sessions[myId]) {
    const used = new Set(Object.values(registry.sessions).map((s) => s.number));
    let num = 0;
    while (used.has(num)) num++;
    registry.sessions[myId] = { number: num, lastSeen: now };
  } else {
    registry.sessions[myId].lastSeen = now;
  }

  const sessionNum = registry.sessions[myId].number;
  try { fs.writeFileSync(SESSION_REGISTRY, JSON.stringify(registry), 'utf8'); } catch { /* ignore */ }
  return sessionNum;
}

function statePath(sessionNum) {
  return `/tmp/claude-narrator-state-${sessionNum}.json`;
}

// ─── Conversational prefixes ────────────────────────────────────────────────
// Each session rotates through its own set so concurrent sessions sound distinct.

const SESSION_PREFIXES = [
  // Session 0 — casual permission
  [
    (a) => `Can I ${a}?`,
    (a) => `Mind if I ${a}?`,
    (a) => `Let me ${a}`,
    (a) => `Going to ${a}`,
    (a) => `I'd like to ${a}`,
  ],
  // Session 1 — polite / questioning
  [
    (a) => `Should I ${a}?`,
    (a) => `Would you like me to ${a}?`,
    (a) => `Shall I ${a}?`,
    (a) => `How about I ${a}?`,
    (a) => `OK if I ${a}?`,
  ],
  // Session 2 — brief / direct
  [
    (a) => `Quick ${a}`,
    (a) => `Need to ${a}`,
    (a) => `Just going to ${a}`,
    (a) => `Time to ${a}`,
    (a) => `About to ${a}`,
  ],
  // Session 3 — confident / narrating
  [
    (a) => `Now I'll ${a}`,
    (a) => `Next up, ${a}`,
    (a) => `Alright, ${a}`,
    (a) => `On it — ${a}`,
    (a) => `Here we go, ${a}`,
  ],
];
let prefixIndex = 0;
let activeSession = 0;

function askStyle(action) {
  const prefixes = SESSION_PREFIXES[activeSession % SESSION_PREFIXES.length];
  const fn = prefixes[prefixIndex % prefixes.length];
  prefixIndex++;
  return fn(action);
}

// ─── Bash command templates ─────────────────────────────────────────────────
// Values are now verb phrases (no prefix) — prefix is applied by askStyle()

const BASH_TEMPLATES = [
  [/^git\s+status/,          'check git status'],
  [/^git\s+diff/,            'review the changes'],
  [/^git\s+log/,             'check git history'],
  [/^git\s+add/,             'stage the changes'],
  [/^git\s+commit/,          'commit the changes'],
  [/^git\s+push\s+.*--force/,'force push to remote'],
  [/^git\s+push\s+.*-f\b/,  'force push to remote'],
  [/^git\s+push/,            'push to remote'],
  [/^git\s+pull/,            'pull from remote'],
  [/^git\s+checkout/,        'switch branches'],
  [/^git\s+branch/,          'manage branches'],
  [/^git\s+merge/,           'merge branches'],
  [/^git\s+rebase/,          'rebase'],
  [/^git\s+stash/,           'stash changes'],
  [/^git\s+reset\s+--hard/,  'reset git history'],
  [/^git\s+clone/,           'clone a repository'],
  [/^(npm|yarn|pnpm)\s+run\s+(test|spec)/i, 'run the tests'],
  [/^(npm|yarn|pnpm)\s+test/i, 'run the tests'],
  [/^pytest\b/,              'run the tests'],
  [/^jest\b/,                'run the tests'],
  [/^cargo\s+test/,          'run the tests'],
  [/^go\s+test/,             'run the tests'],
  [/^(npm|yarn|pnpm)\s+run\s+build/i, 'build the project'],
  [/^(npm|yarn|pnpm)\s+run\s+dev/i,   'start the dev server'],
  [/^(npm|yarn|pnpm)\s+run\s+lint/i,  'run the linter'],
  [/^(npm|pip|yarn|pnpm)\s+install/i,  'install dependencies'],
  [/^pip\s+install/i,        'install dependencies'],
  [/^cargo\s+build/,         'build the project'],
  [/^go\s+build/,            'build the project'],
  [/^rm\s+-rf\b/,            'delete some files'],
  [/^rm\s/,                  'delete a file'],
  [/^ls\b/,                  'list the directory'],
  [/^find\s/,                'search for files'],
  [/^mkdir\b/,               'create a directory'],
  [/^docker\s/,              'run docker'],
  [/^docker-compose\s/,      'run docker compose'],
  [/^curl\s/,                'make a network request'],
  [/^wget\s/,                'make a network request'],
  [/^gh\s/,                  'use GitHub CLI'],
  [/^cat\s/,                 'read a file'],
  [/^cd\s/,                  'change directory'],
  [/^cp\s/,                  'copy some files'],
  [/^mv\s/,                  'move some files'],
  [/^chmod\s/,               'change permissions'],
  [/^echo\s/,                'run echo'],
  [/^python3?\s/,            'run Python'],
  [/^node\s/,                'run Node'],
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch { /* fall through */ }
  return { ...DEFAULTS };
}

function loadState(stPath) {
  try {
    if (fs.existsSync(stPath)) {
      const raw = fs.readFileSync(stPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch { /* fall through */ }
  return { lastTool: null, consecutiveCount: 0, lastTimestamp: 0, recentActions: [] };
}

function saveState(stPath, state) {
  try {
    fs.writeFileSync(stPath, JSON.stringify(state), 'utf8');
  } catch { /* ignore */ }
}

function friendlyPath(filePath) {
  if (!filePath) return '';

  // Strip home dir prefix
  let p = filePath.replace(new RegExp(`^${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '~');
  // Strip common project prefixes
  p = p.replace(/^~\/Documents\/projects\/[^/]+\//, '');
  p = p.replace(/^~\/[^/]+\//, '');

  const parts = p.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const parentDir = parts.length > 1 ? parts[parts.length - 2] : '';

  // ── Index/page/layout files → "the [parent] page" ──
  if (/^(index|page|layout|route)\.(ts|tsx|js|jsx|py)$/.test(fileName)) {
    const kind = fileName.split('.')[0];
    const name = parentDir
      .replace(/^\[.*\]$/, 'detail')
      .replace(/^\(.*\)$/, (m) => m.slice(1, -1))
      .replace(/[-_]/g, ' ');
    return `the ${name} ${kind}`;
  }

  // ── Well-known config/root files → spoken as-is ──
  if (/^(package\.json|tsconfig.*\.json|next\.config\.\w+|tailwind\.config\.\w+|\.env.*|Dockerfile|docker-compose.*|Makefile|Cargo\.toml|go\.(mod|sum)|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle.*)$/i.test(fileName)) {
    return fileName.replace(/\./g, ' ');
  }

  // ── General files ──
  // Separate base name from extension
  const extMatch = fileName.match(/\.(ts|tsx|js|jsx|py|rs|go|java|rb|md|json|yaml|yml|toml|css|scss|html|sql|sh|swift|kt|c|cpp|h|hpp|vue|svelte)$/);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const humanBase = base.replace(/[-_]/g, ' ');

  // Build spoken name: "auth service dot py"
  const spokenName = ext ? `${humanBase} dot ${ext}` : humanBase;

  // ── Parent folder context ──
  // Skip generic container dirs that don't add useful context
  const SKIP_PARENTS = /^(src|app|lib|dist|build|out|public|static|internal|cmd|pkg|node_modules|__pycache__|\.next)$/i;

  if (parentDir && !SKIP_PARENTS.test(parentDir)) {
    const humanParent = parentDir
      .replace(/^\[.*\]$/, 'detail')
      .replace(/^\(.*\)$/, (m) => m.slice(1, -1))
      .replace(/[-_]/g, ' ');

    // Don't repeat context if parent name is already in the file name
    if (!humanBase.toLowerCase().includes(humanParent.toLowerCase()) &&
        !humanParent.toLowerCase().includes(humanBase.toLowerCase())) {
      return `${spokenName} in ${humanParent}`;
    }
  }

  return spokenName;
}

function shortPattern(pattern) {
  if (!pattern) return 'a pattern';
  if (pattern.length <= 25) return `"${pattern}"`;
  return `"${pattern.slice(0, 22)}..."`;
}

function isDestructive(command) {
  if (!command) return false;
  return DESTRUCTIVE.some((rx) => rx.test(command));
}

function inferArea(recentActions) {
  if (recentActions.length < 3) return null;

  const recent = recentActions.slice(-5);
  const areas = recent
    .map((a) => {
      const t = a.target || '';
      if (/auth/i.test(t)) return 'authentication';
      if (/payment|stripe|checkout/i.test(t)) return 'payments';
      if (/course/i.test(t)) return 'courses';
      if (/enroll/i.test(t)) return 'enrollments';
      if (/video/i.test(t)) return 'video';
      if (/cert/i.test(t)) return 'certificates';
      if (/test/i.test(t)) return 'tests';
      if (/migrat/i.test(t)) return 'migrations';
      if (/config/i.test(t)) return 'configuration';
      return null;
    })
    .filter(Boolean);

  if (areas.length < 3) return null;

  // Most frequent area in last 5 actions
  const counts = {};
  for (const a of areas) counts[a] = (counts[a] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 3 ? top[0] : null;
}

// ─── Narration generation ───────────────────────────────────────────────────

function generateNarration(toolName, toolInput) {
  const desc = toolInput.description || '';

  // Priority 1: Use description field if non-generic
  if (desc && desc.length > 5 && !GENERIC_DESC.some((rx) => rx.test(desc))) {
    const words = desc.split(/\s+/);
    const trimmed = words.length <= 10 ? desc : words.slice(0, 8).join(' ');
    return askStyle(trimmed.charAt(0).toLowerCase() + trimmed.slice(1));
  }

  // Priority 2: Template matching
  switch (toolName) {
    case 'Read': {
      const name = friendlyPath(toolInput.file_path);
      return askStyle(name ? `read ${name}` : 'read a file');
    }
    case 'Edit': {
      const name = friendlyPath(toolInput.file_path);
      return askStyle(name ? `edit ${name}` : 'edit a file');
    }
    case 'Write': {
      const name = friendlyPath(toolInput.file_path);
      const verb = toolInput.file_path && fs.existsSync(toolInput.file_path) ? 'update' : 'create';
      return askStyle(name ? `${verb} ${name}` : `${verb} a file`);
    }
    case 'Grep': {
      const pat = shortPattern(toolInput.pattern);
      return askStyle(`search for ${pat}`);
    }
    case 'Glob': {
      const pat = toolInput.pattern || '';
      return askStyle(pat ? `find ${pat} files` : 'find some files');
    }
    case 'Bash': {
      const cmd = (toolInput.command || '').trim();
      for (const [rx, action] of BASH_TEMPLATES) {
        if (rx.test(cmd)) return askStyle(action);
      }
      return askStyle('run a command');
    }
    case 'Agent': {
      const agentDesc = toolInput.description || '';
      if (agentDesc && agentDesc.length > 3) {
        const words = agentDesc.split(/\s+/);
        const short = words.length <= 6 ? agentDesc : words.slice(0, 5).join(' ');
        return askStyle(`launch an agent for ${short}`);
      }
      return askStyle('launch a sub-agent');
    }
    default:
      return askStyle(`use ${toolName}`);
  }
}

function getTarget(toolName, toolInput) {
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return toolInput.file_path || '';
    case 'Grep':
      return toolInput.pattern || '';
    case 'Glob':
      return toolInput.pattern || '';
    case 'Bash':
      return (toolInput.command || '').slice(0, 60);
    case 'Agent':
      return toolInput.description || '';
    default:
      return '';
  }
}

// ─── Speech ─────────────────────────────────────────────────────────────────

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }
}

function speakWithSay(text, config, isDestructiveAction, sessionNum) {
  const voice = config.voice || DEFAULTS.voice;
  const rate = isDestructiveAction ? 190 : (config.rate || DEFAULTS.rate);
  const volume = config.volume ?? DEFAULTS.volume;

  const hash = crypto.createHash('md5').update(`say:${voice}:${rate}:${text}`).digest('hex').slice(0, 12);
  const tmpFile = path.join(TMP_DIR, `${TMP_PREFIX}sess${sessionNum}-${hash}.aiff`);

  try {
    if (!fs.existsSync(tmpFile)) {
      execSync(`say -v "${voice}" -r ${rate} -o "${tmpFile}" "${text.replace(/"/g, '\\"')}"`, {
        timeout: 3000,
        stdio: 'ignore',
      });
    }
    playFile(tmpFile, config.volume ?? DEFAULTS.volume, sessionNum);
  } catch { /* never block */ }
}

function speakWithElevenLabs(text, config, isDestructiveAction, sessionNum) {
  const el = config.elevenlabs || {};
  const apiKey = el.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return speakWithSay(text, config, isDestructiveAction, sessionNum);

  const voiceId = el.voiceId || 'EXAVITQu4vr4xnSDxMaL'; // Sarah
  const model = el.model || 'eleven_turbo_v2_5';
  const volume = config.volume ?? DEFAULTS.volume;

  // Cache in persistent dir (ElevenLabs calls cost money)
  ensureCacheDir();
  const hash = crypto.createHash('md5').update(`el:${voiceId}:${model}:${text}`).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

  // Cache hit — play immediately
  if (fs.existsSync(cacheFile)) {
    playFile(cacheFile, volume, sessionNum);
    return;
  }

  // Cache miss — call ElevenLabs API (async, non-blocking via fire-and-forget)
  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: isDestructiveAction ? 0.85 : 1.0 },
  });

  const req = https.request({
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${voiceId}`,
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 4000,
  }, (res) => {
    if (res.statusCode !== 200) {
      // Fallback to say on API error
      speakWithSay(text, config, isDestructiveAction, sessionNum);
      res.resume();
      return;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const audio = Buffer.concat(chunks);
        fs.writeFileSync(cacheFile, audio);
        playFile(cacheFile, volume, sessionNum);
      } catch { /* ignore */ }
    });
  });

  req.on('error', () => {
    // Fallback to say
    speakWithSay(text, config, isDestructiveAction, sessionNum);
  });
  req.on('timeout', () => {
    req.destroy();
    speakWithSay(text, config, isDestructiveAction, sessionNum);
  });
  req.write(body);
  req.end();
}

function speak(text, config, isDestructiveAction, sessionNum) {
  const tts = config.tts || DEFAULTS.tts;
  if (tts === 'elevenlabs') {
    speakWithElevenLabs(text, config, isDestructiveAction, sessionNum);
  } else {
    speakWithSay(text, config, isDestructiveAction, sessionNum);
  }
}

function playFile(filePath, volume, sessionNum) {
  try {
    // Kill any previous narrator audio for this session
    try {
      execSync(`pkill -f "afplay.*/tmp/claude-narrator-.*sess${sessionNum}"`, {
        stdio: 'ignore', timeout: 500
      });
    } catch { /* no process to kill = fine */ }

    const player = spawn('afplay', ['--volume', String(volume), filePath], {
      detached: true,
      stdio: 'ignore',
    });
    player.unref();
  } catch { /* ignore */ }
}

function playAlert(config) {
  const soundFile = config.destructiveAlertSound || DEFAULTS.destructiveAlertSound;
  try {
    if (fs.existsSync(soundFile)) {
      const vol = Math.min((config.volume ?? DEFAULTS.volume) * 1.5, 1.0);
      const player = spawn('afplay', ['--volume', String(vol), soundFile], {
        detached: true,
        stdio: 'ignore',
      });
      player.unref();
    }
  } catch { /* ignore */ }
}

function cleanupOldTempFiles() {
  try {
    // Clean /tmp say-generated files (5 min TTL)
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith(TMP_PREFIX) && f.endsWith('.aiff')) {
        const fp = path.join(TMP_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 5 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      }
    }
    // Clean ElevenLabs cache (7 day TTL)
    if (fs.existsSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        const fp = path.join(CACHE_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      }
    }
  } catch { /* ignore */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let rawInput = '';

  // Read stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  rawInput = Buffer.concat(chunks).toString('utf8');

  // Always output the original JSON (passthrough)
  process.stdout.write(rawInput);

  // Parse input
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return; // Not valid JSON, nothing to narrate
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  // Check mute
  if (fs.existsSync(MUTE_FILE)) return;

  // Load config
  const config = loadConfig();
  if (!config.enabled) return;

  // ── Session detection ──
  const sessionNum = getSessionNumber();
  activeSession = sessionNum;

  // Override voice for non-primary sessions
  if (sessionNum > 0) {
    const extras = config.sessionVoices || DEFAULTS.sessionVoices;
    const sv = extras[(sessionNum - 1) % extras.length];
    if (sv) {
      config.voice = sv.voice || config.voice;
      config.rate = sv.rate || config.rate;
      if (sv.elevenLabsVoiceId && config.elevenlabs) {
        config.elevenlabs = { ...config.elevenlabs, voiceId: sv.elevenLabsVoiceId };
      }
    }
  }

  // Check if tool should be narrated
  const narrate = config.narrateTools || DEFAULTS.narrateTools;
  const skip = config.skipTools || [];
  if (skip.includes(toolName)) return;
  if (!narrate.includes(toolName)) return;

  // Load per-session state
  const stPath = statePath(sessionNum);
  const state = loadState(stPath);
  const now = Date.now();
  const timeSinceLastMs = now - (state.lastTimestamp || 0);

  // Repetition suppression
  const threshold = config.repetitionThreshold || DEFAULTS.repetitionThreshold;
  let isSameTool = state.lastTool === toolName && timeSinceLastMs < 10000;

  if (isSameTool) {
    state.consecutiveCount = (state.consecutiveCount || 0) + 1;
  } else {
    state.consecutiveCount = 1;
  }

  // Update state
  state.lastTool = toolName;
  state.lastTimestamp = now;

  const target = getTarget(toolName, toolInput);
  const recentActions = state.recentActions || [];
  recentActions.push({ tool: toolName, target, ts: now });

  // Keep only maxContextItems
  const maxCtx = config.maxContextItems || DEFAULTS.maxContextItems;
  while (recentActions.length > maxCtx) recentActions.shift();
  state.recentActions = recentActions;

  // Generate narration
  let text;
  if (state.consecutiveCount === threshold) {
    // Batch summary
    const toolLabel = toolName === 'Read' ? 'read' :
                      toolName === 'Edit' ? 'edit' :
                      toolName === 'Write' ? 'write' :
                      toolName === 'Grep' ? 'search through' :
                      toolName === 'Glob' ? 'find' :
                      `use ${toolName} on`;
    text = askStyle(`${toolLabel} a few more files`);
  } else if (state.consecutiveCount > threshold) {
    // Silent — too many repetitions
    saveState(stPath, state);
    return;
  } else {
    text = generateNarration(toolName, toolInput);
  }

  // Context awareness — prepend area if stable
  if (state.consecutiveCount === 1) {
    const area = inferArea(recentActions);
    if (area && text && !text.toLowerCase().includes(area)) {
      // Only add context on first action in a new batch
      const lastArea = state.lastArea;
      if (area !== lastArea) {
        text = `Still on ${area}. ${text}`;
      }
    }
    state.lastArea = inferArea(recentActions);
  }

  // Destructive action alert
  const command = toolInput.command || '';
  const destructive = toolName === 'Bash' && isDestructive(command);

  if (destructive) {
    playAlert(config);
    // Small delay so alert plays before narration
    await new Promise((r) => setTimeout(r, 200));
  }

  // Speak
  speak(text, config, destructive, sessionNum);

  // Save state
  saveState(stPath, state);

  // Occasionally clean up old temp files
  if (Math.random() < 0.05) cleanupOldTempFiles();
}

// ─── PostToolUse — failure narration ─────────────────────────────────────────

async function mainPost() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const rawInput = Buffer.concat(chunks).toString('utf8');
  process.stdout.write(rawInput);

  let input;
  try { input = JSON.parse(rawInput); } catch { return; }

  if (fs.existsSync(MUTE_FILE)) return;
  const config = loadConfig();
  if (!config.enabled) return;
  if (!(config.narrateFailures ?? DEFAULTS.narrateFailures)) return;

  const toolName = input.tool_name;
  const toolOutput = input.tool_output || {};

  // Only narrate Bash failures
  if (toolName !== 'Bash') return;
  const exitCode = toolOutput.exitCode ?? toolOutput.exit_code;
  if (exitCode === 0 || exitCode === undefined || exitCode === null) return;

  // Detect what kind of failure
  const cmd = (input.tool_input?.command || '').trim();
  let text = 'That failed';
  for (const [rx] of BASH_TEMPLATES) {
    if (/test|spec|jest|pytest|cargo\s+test|go\s+test/.test(rx.source) && rx.test(cmd)) {
      text = 'Tests failed';
      break;
    }
    if (/build/.test(rx.source) && rx.test(cmd)) {
      text = 'Build failed';
      break;
    }
  }

  const sessionNum = getSessionNumber();

  // Override voice for non-primary sessions
  if (sessionNum > 0) {
    const extras = config.sessionVoices || DEFAULTS.sessionVoices;
    const sv = extras[(sessionNum - 1) % extras.length];
    if (sv) {
      config.voice = sv.voice || config.voice;
      config.rate = sv.rate || config.rate;
    }
  }

  const failConfig = { ...config, volume: (config.volume ?? 0.5) * 0.8 };
  playAlert(failConfig);
  await new Promise((r) => setTimeout(r, 200));
  speak(text, failConfig, true, sessionNum);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes('--post')) {
  mainPost().catch(() => {});
} else {
  main().catch(() => {});
}
