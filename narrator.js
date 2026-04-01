#!/usr/bin/env node

// Claude Code Narrator — Jarvis-like audio co-pilot for Claude Code
// Zero JS dependencies. Pure Node.js 18+ stdlib. macOS only (uses `afplay`).
// TTS: mlx-audio Kokoro (default, Apple Silicon) | macOS say (fallback) | ElevenLabs (premium)
// Rich Tier: Gemini 2.5 Flash-Lite for milestone narration (optional)
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
  tts: 'mlx',                // 'mlx' (default) | 'say' (fallback) | 'elevenlabs'
  mlx: {
    model: 'mlx-community/Kokoro-82M-bf16',
    voice: 'af_heart',
    speed: 1.0,
  },
  elevenlabs: null,           // { apiKey, voiceId?, model? }
  jarvis: {
    enabled: false,
    apiKey: '',
    model: 'gemini-2.5-flash-lite',
    personality: 'warm',
    timeoutMs: 2000,
  },
  narrateTools: ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'Agent'],
  skipTools: [],
  narrateFailures: true,
  narrateStop: true,
  maxContextItems: 15,
  repetitionThreshold: 3,
  destructiveAlertSound: '/System/Library/Sounds/Basso.aiff',
  sessionVoices: [
    { voice: 'Daniel (Enhanced)', mlxVoice: 'am_adam', rate: 200 },
    { voice: 'Karen (Enhanced)', mlxVoice: 'bf_emma', rate: 205 },
    { voice: 'Tessa (Enhanced)', mlxVoice: 'am_michael', rate: 200 },
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

const STALE_SESSION_MS = 30 * 60 * 1000;

function getSessionNumber() {
  const myId = String(process.ppid);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(SESSION_REGISTRY, 'utf8'));
  } catch {
    registry = { sessions: {} };
  }

  const now = Date.now();
  for (const [pid, info] of Object.entries(registry.sessions)) {
    if (now - info.lastSeen > STALE_SESSION_MS) delete registry.sessions[pid];
  }

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

// ─── Rich phrasing pools ────────────────────────────────────────────────────
// Each verb has multiple phrasings to rotate through for natural variation.

const VERB_POOLS = {
  read:    ['read', 'peek at', 'take a look at', 'check out', 'open up'],
  edit:    ['edit', 'update', 'make a change to', 'tweak'],
  create:  ['create', 'set up', 'write out'],
  update:  ['update', 'modify', 'revise'],
  search:  ['search for', 'look for', 'hunt for', 'scan for'],
  find:    ['find', 'look for', 'locate'],
  run:     ['run a command', 'execute something', 'fire off a command'],
  test:    ['run the tests', 'kick off the test suite', 'see if the tests pass', 'check if that worked'],
  build:   ['build the project', 'compile the project', 'kick off the build'],
  install: ['install dependencies', 'grab the dependencies', 'pull in the packages'],
  agent:   ['launch an agent', 'spin up a sub-agent', 'delegate to an agent'],
};

let verbIndices = {};

function pickVerb(pool, state) {
  const key = pool[0]; // Use first entry as key
  const idx = state.verbIndex?.[key] || 0;
  const pick = pool[idx % pool.length];
  // Advance with last-used exclusion
  let next = (idx + 1) % pool.length;
  if (pool[next] === pick && pool.length > 1) next = (next + 1) % pool.length;
  if (!state.verbIndex) state.verbIndex = {};
  state.verbIndex[key] = next;
  return pick;
}

// ─── Bash command templates ─────────────────────────────────────────────────

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
  [/^(npm|yarn|pnpm)\s+run\s+(test|spec)/i, null, 'test'],
  [/^(npm|yarn|pnpm)\s+test/i, null, 'test'],
  [/^pytest\b/,              null, 'test'],
  [/^jest\b/,                null, 'test'],
  [/^cargo\s+test/,          null, 'test'],
  [/^go\s+test/,             null, 'test'],
  [/^(npm|yarn|pnpm)\s+run\s+build/i, null, 'build'],
  [/^(npm|yarn|pnpm)\s+run\s+dev/i,   'start the dev server'],
  [/^(npm|yarn|pnpm)\s+run\s+lint/i,  'run the linter'],
  [/^(npm|pip|yarn|pnpm)\s+install/i,  null, 'install'],
  [/^pip\s+install/i,        null, 'install'],
  [/^cargo\s+build/,         null, 'build'],
  [/^go\s+build/,            null, 'build'],
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

// ─── Pattern detection ──────────────────────────────────────────────────────

function detectPattern(recentActions, state) {
  if (recentActions.length < 3) return null;
  const recent = recentActions.slice(-12);
  const tools = recent.map((a) => a.tool);

  // Debugging loop: 3+ cycles of Read → Edit → Bash(test) with failing tests
  if (tools.length >= 9 && state.lastBashExitCode && state.lastBashExitCode !== 0) {
    let cycles = 0;
    for (let i = tools.length - 1; i >= 2; i -= 3) {
      if (tools[i] === 'Bash' && tools[i - 1] === 'Edit' && tools[i - 2] === 'Read') cycles++;
      else break;
    }
    if (cycles >= 3) return 'debugging';
  }

  // Exploration: 4+ consecutive Reads
  const last4 = tools.slice(-4);
  if (last4.length >= 4 && last4.every((t) => t === 'Read')) return 'exploring';

  // Refactoring: 3+ consecutive Edits
  const last3 = tools.slice(-3);
  if (last3.length >= 3 && last3.every((t) => t === 'Edit')) return 'refactoring';

  // Wrapping up: Edit followed by git command
  if (tools.length >= 2) {
    const prev = tools[tools.length - 2];
    const curr = tools[tools.length - 1];
    const lastTarget = recent[recent.length - 1]?.target || '';
    if (prev === 'Edit' && curr === 'Bash' && /^git\s+(add|commit|push|status)/.test(lastTarget)) {
      return 'wrapping-up';
    }
  }

  return null;
}

const PATTERN_PHRASES = {
  debugging:    ['Let me try again.', 'One more attempt.', 'Another go at it.'],
  exploring:    ['Still looking...', 'Almost found it...', 'Digging deeper...'],
  refactoring:  ['Another one to update.', 'Continuing the refactor.', 'One more change.'],
  'wrapping-up': ['Finishing up.', 'Wrapping things up.', 'Almost done.'],
};

// ─── Stop (turn-complete) phrases ────────────────────────────────────────────

const STOP_PHRASES = [
  'Your turn',
  'Ready when you are',
  'All yours',
  'Standing by',
  'Over to you',
];

// ─── Warm connectors ────────────────────────────────────────────────────────

const CONNECTORS = ['OK, ', 'Alright, ', 'Right, ', 'Now ', 'Next, '];
let connectorIndex = 0;

function maybeAddConnector(text, state, toolName) {
  if (state.lastTool && state.lastTool !== toolName) {
    const connector = CONNECTORS[connectorIndex % CONNECTORS.length];
    connectorIndex++;
    return connector.toLowerCase() + text.charAt(0).toLowerCase() + text.slice(1);
  }
  return text;
}

// ─── Milestone detection ────────────────────────────────────────────────────

function detectMilestone(toolName, toolInput, state) {
  const recentActions = state.recentActions || [];
  if (recentActions.length < 3) return null;
  const tools = recentActions.slice(-6).map((a) => a.tool);

  // Task transition: tool type shifts after 3+ same-type actions
  const lastTool = tools[tools.length - 1];
  const sameBefore = tools.slice(0, -1).filter((t) => t === state.lastTool);
  if (sameBefore.length >= 3 && lastTool !== state.lastTool) {
    return { type: 'transition', from: state.lastTool, to: lastTool };
  }

  // Completion summary: git commit or 5+ edits followed by non-edit
  if (toolName === 'Bash' && /^git\s+commit/.test(toolInput.command || '')) {
    const editCount = recentActions.filter((a) => a.tool === 'Edit').length;
    return { type: 'completion', editCount };
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const userConf = JSON.parse(raw);
      return {
        ...DEFAULTS,
        ...userConf,
        mlx: { ...DEFAULTS.mlx, ...(userConf.mlx || {}) },
        jarvis: { ...DEFAULTS.jarvis, ...(userConf.jarvis || {}) },
      };
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
  return { lastTool: null, consecutiveCount: 0, lastTimestamp: 0, recentActions: [], verbIndex: {} };
}

function saveState(stPath, state) {
  try {
    fs.writeFileSync(stPath, JSON.stringify(state), 'utf8');
  } catch { /* ignore */ }
}

function friendlyPath(filePath) {
  if (!filePath) return '';

  let p = filePath.replace(new RegExp(`^${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '~');
  p = p.replace(/^~\/Documents\/projects\/[^/]+\//, '');
  p = p.replace(/^~\/[^/]+\//, '');

  const parts = p.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const parentDir = parts.length > 1 ? parts[parts.length - 2] : '';

  if (/^(index|page|layout|route)\.(ts|tsx|js|jsx|py)$/.test(fileName)) {
    const kind = fileName.split('.')[0];
    const name = parentDir
      .replace(/^\[.*\]$/, 'detail')
      .replace(/^\(.*\)$/, (m) => m.slice(1, -1))
      .replace(/[-_]/g, ' ');
    return `the ${name} ${kind}`;
  }

  if (/^(package\.json|tsconfig.*\.json|next\.config\.\w+|tailwind\.config\.\w+|\.env.*|Dockerfile|docker-compose.*|Makefile|Cargo\.toml|go\.(mod|sum)|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle.*)$/i.test(fileName)) {
    return fileName.replace(/\./g, ' ');
  }

  const extMatch = fileName.match(/\.(ts|tsx|js|jsx|py|rs|go|java|rb|md|json|yaml|yml|toml|css|scss|html|sql|sh|swift|kt|c|cpp|h|hpp|vue|svelte)$/);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const humanBase = base.replace(/[-_]/g, ' ');
  const spokenName = ext ? `${humanBase} dot ${ext}` : humanBase;

  const SKIP_PARENTS = /^(src|app|lib|dist|build|out|public|static|internal|cmd|pkg|node_modules|__pycache__|\.next)$/i;

  if (parentDir && !SKIP_PARENTS.test(parentDir)) {
    const humanParent = parentDir
      .replace(/^\[.*\]$/, 'detail')
      .replace(/^\(.*\)$/, (m) => m.slice(1, -1))
      .replace(/[-_]/g, ' ');

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
      // Derive area from path components rather than hardcoded domain terms
      const parts = t.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1] || t;
      if (/auth/i.test(lastPart)) return 'authentication';
      if (/test|spec/i.test(lastPart)) return 'tests';
      if (/migrat/i.test(lastPart)) return 'migrations';
      if (/config|settings/i.test(lastPart)) return 'configuration';
      if (/api|endpoint|route/i.test(lastPart)) return 'API';
      if (/style|css|theme/i.test(lastPart)) return 'styling';
      if (/model|schema|entity/i.test(lastPart)) return 'data models';
      if (/component|widget|view/i.test(lastPart)) return 'components';
      return null;
    })
    .filter(Boolean);

  if (areas.length < 3) return null;
  const counts = {};
  for (const a of areas) counts[a] = (counts[a] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 3 ? top[0] : null;
}

// ─── Narration generation ───────────────────────────────────────────────────

function generateNarration(toolName, toolInput, state) {
  const desc = toolInput.description || '';

  // Priority 1: Use description field if non-generic
  if (desc && desc.length > 5 && !GENERIC_DESC.some((rx) => rx.test(desc))) {
    const words = desc.split(/\s+/);
    const trimmed = words.length <= 10 ? desc : words.slice(0, 8).join(' ');
    return askStyle(trimmed.charAt(0).toLowerCase() + trimmed.slice(1));
  }

  // Priority 2: Template matching with rich phrasing
  switch (toolName) {
    case 'Read': {
      const name = friendlyPath(toolInput.file_path);
      const verb = pickVerb(VERB_POOLS.read, state);
      return askStyle(name ? `${verb} ${name}` : `${verb} a file`);
    }
    case 'Edit': {
      const name = friendlyPath(toolInput.file_path);
      const verb = pickVerb(VERB_POOLS.edit, state);
      return askStyle(name ? `${verb} ${name}` : `${verb} a file`);
    }
    case 'Write': {
      const name = friendlyPath(toolInput.file_path);
      const exists = toolInput.file_path && fs.existsSync(toolInput.file_path);
      const verb = pickVerb(exists ? VERB_POOLS.update : VERB_POOLS.create, state);
      return askStyle(name ? `${verb} ${name}` : `${verb} a file`);
    }
    case 'Grep': {
      const pat = shortPattern(toolInput.pattern);
      const verb = pickVerb(VERB_POOLS.search, state);
      return askStyle(`${verb} ${pat}`);
    }
    case 'Glob': {
      const pat = toolInput.pattern || '';
      const verb = pickVerb(VERB_POOLS.find, state);
      return askStyle(pat ? `${verb} ${pat} files` : `${verb} some files`);
    }
    case 'Bash': {
      const cmd = (toolInput.command || '').trim();
      for (const [rx, staticPhrase, poolKey] of BASH_TEMPLATES) {
        if (rx.test(cmd)) {
          if (poolKey && VERB_POOLS[poolKey]) {
            return askStyle(pickVerb(VERB_POOLS[poolKey], state));
          }
          return askStyle(staticPhrase);
        }
      }
      return askStyle(pickVerb(VERB_POOLS.run, state));
    }
    case 'Agent': {
      const agentDesc = toolInput.description || '';
      if (agentDesc && agentDesc.length > 3) {
        const words = agentDesc.split(/\s+/);
        const short = words.length <= 6 ? agentDesc : words.slice(0, 5).join(' ');
        return askStyle(`launch an agent for ${short}`);
      }
      return askStyle(pickVerb(VERB_POOLS.agent, state));
    }
    default:
      return askStyle(`use ${toolName}`);
  }
}

function getTarget(toolName, toolInput) {
  switch (toolName) {
    case 'Read': case 'Edit': case 'Write':
      return toolInput.file_path || '';
    case 'Grep': case 'Glob':
      return toolInput.pattern || '';
    case 'Bash':
      return (toolInput.command || '').slice(0, 60);
    case 'Agent':
      return toolInput.description || '';
    default:
      return '';
  }
}

// ─── Gemini API client ──────────────────────────────────────────────────────

function callGemini(prompt, config) {
  const jarvis = config.jarvis || DEFAULTS.jarvis;
  const apiKey = jarvis.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  const model = jarvis.model || DEFAULTS.jarvis.model;
  const timeoutMs = jarvis.timeoutMs || DEFAULTS.jarvis.timeoutMs;
  const personality = jarvis.personality || DEFAULTS.jarvis.personality;

  const PERSONALITY_PROMPTS = {
    warm: 'You are Jarvis, a warm and conversational voice assistant for a developer. Generate ONE short sentence (max 15 words) narrating what just happened or what is about to happen. Be warm but not silly.',
    professional: 'You are a professional voice assistant for a developer. Generate ONE short, precise sentence (max 15 words) narrating the current action. Be concise and direct.',
    playful: 'You are a playful voice assistant for a developer. Generate ONE short, witty sentence (max 15 words) narrating what is happening. Light humor is welcome.',
    terse: 'You are a minimal voice assistant. Generate ONE ultra-short sentence (max 8 words) stating the action. No filler words.',
  };

  const personalityPrompt = PERSONALITY_PROMPTS[personality] || PERSONALITY_PROMPTS.warm;

  const body = JSON.stringify({
    system_instruction: {
      parts: [{ text: `${personalityPrompt} No emojis. No code. Written to be spoken aloud, so write for the ear, not the eye.` }],
    },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 60, temperature: 0.7 },
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          resolve(text || null);
        } catch { resolve(null); }
      });
    });

    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Speech ─────────────────────────────────────────────────────────────────

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }
}

function speakWithMlx(text, config, isDestructiveAction, sessionNum) {
  const mlx = config.mlx || DEFAULTS.mlx;
  const model = mlx.model || DEFAULTS.mlx.model;
  const voice = mlx.voice || DEFAULTS.mlx.voice;
  const speed = isDestructiveAction ? 0.85 : (mlx.speed || DEFAULTS.mlx.speed);
  const volume = config.volume ?? DEFAULTS.volume;

  const hash = crypto.createHash('md5').update(`mlx:${voice}:${speed}:${text}`).digest('hex').slice(0, 12);
  const tmpFile = path.join(TMP_DIR, `${TMP_PREFIX}sess${sessionNum}-${hash}.wav`);

  try {
    // mlx-audio writes to <output>/audio_000.wav, not <output> directly
    const mlxOutputDir = tmpFile + '.d';
    const mlxActualFile = path.join(mlxOutputDir, 'audio_000.wav');

    if (!fs.existsSync(tmpFile)) {
      const escaped = JSON.stringify(text);
      execSync(`python3 -m mlx_audio.tts.generate --model ${JSON.stringify(model)} --text ${escaped} --voice ${JSON.stringify(voice)} --speed ${speed} --output ${JSON.stringify(mlxOutputDir)}`, {
        timeout: 5000,
        stdio: 'ignore',
      });
      // Move the actual wav to the expected cache path
      if (fs.existsSync(mlxActualFile)) {
        fs.renameSync(mlxActualFile, tmpFile);
        try { fs.rmdirSync(mlxOutputDir); } catch { /* ignore */ }
      }
    }
    playFile(tmpFile, volume, sessionNum);
  } catch {
    // Fallback to macOS say
    speakWithSay(text, config, isDestructiveAction, sessionNum);
  }
}

function speakWithSay(text, config, isDestructiveAction, sessionNum) {
  const voice = config.voice || DEFAULTS.voice;
  const rate = isDestructiveAction ? 190 : (config.rate || DEFAULTS.rate);

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

  const voiceId = el.voiceId || 'EXAVITQu4vr4xnSDxMaL';
  const model = el.model || 'eleven_turbo_v2_5';
  const volume = config.volume ?? DEFAULTS.volume;

  ensureCacheDir();
  const hash = crypto.createHash('md5').update(`el:${voiceId}:${model}:${text}`).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(cacheFile)) {
    playFile(cacheFile, volume, sessionNum);
    return;
  }

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

  req.on('error', () => speakWithSay(text, config, isDestructiveAction, sessionNum));
  req.on('timeout', () => { req.destroy(); speakWithSay(text, config, isDestructiveAction, sessionNum); });
  req.write(body);
  req.end();
}

function speak(text, config, isDestructiveAction, sessionNum) {
  const tts = config.tts || DEFAULTS.tts;
  if (tts === 'mlx') {
    speakWithMlx(text, config, isDestructiveAction, sessionNum);
  } else if (tts === 'elevenlabs') {
    speakWithElevenLabs(text, config, isDestructiveAction, sessionNum);
  } else {
    speakWithSay(text, config, isDestructiveAction, sessionNum);
  }
}

function playFile(filePath, volume, sessionNum) {
  try {
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
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith(TMP_PREFIX) && (f.endsWith('.aiff') || f.endsWith('.wav'))) {
        const fp = path.join(TMP_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 5 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      }
    }
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

// ─── Session voice configuration ────────────────────────────────────────────

function applySessionVoice(config, sessionNum) {
  if (sessionNum === 0) return;
  const extras = config.sessionVoices || DEFAULTS.sessionVoices;
  const sv = extras[(sessionNum - 1) % extras.length];
  if (!sv) return;

  // macOS say voice
  config.voice = sv.voice || config.voice;
  config.rate = sv.rate || config.rate;

  // mlx-audio voice
  if (sv.mlxVoice && config.mlx) {
    config.mlx = { ...config.mlx, voice: sv.mlxVoice };
  }

  // ElevenLabs voice
  if (sv.elevenLabsVoiceId && config.elevenlabs) {
    config.elevenlabs = { ...config.elevenlabs, voiceId: sv.elevenLabsVoiceId };
  }
}

// ─── Main (PreToolUse) ──────────────────────────────────────────────────────

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const rawInput = Buffer.concat(chunks).toString('utf8');

  // Always output the original JSON (passthrough)
  process.stdout.write(rawInput);

  let input;
  try { input = JSON.parse(rawInput); } catch { return; }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  if (fs.existsSync(MUTE_FILE)) return;

  const config = loadConfig();
  if (!config.enabled) return;

  // Session detection
  const sessionNum = getSessionNumber();
  activeSession = sessionNum;
  applySessionVoice(config, sessionNum);

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
  const isSameTool = state.lastTool === toolName && timeSinceLastMs < 10000;

  if (isSameTool) {
    state.consecutiveCount = (state.consecutiveCount || 0) + 1;
  } else {
    state.consecutiveCount = 1;
  }

  const target = getTarget(toolName, toolInput);
  const recentActions = state.recentActions || [];
  recentActions.push({ tool: toolName, target, ts: now });

  const maxCtx = config.maxContextItems || DEFAULTS.maxContextItems;
  while (recentActions.length > maxCtx) recentActions.shift();
  state.recentActions = recentActions;

  // ── Pattern detection ──
  const pattern = detectPattern(recentActions, state);

  // ── Milestone detection (for Rich Tier) ──
  const milestone = detectMilestone(toolName, toolInput, state);
  let geminiPromise = null;
  const jarvis = config.jarvis || DEFAULTS.jarvis;
  if (milestone && jarvis.enabled && (jarvis.apiKey || process.env.GEMINI_API_KEY)) {
    const ctx = recentActions.slice(-5).map((a) => `${a.tool}: ${a.target}`).join(', ');
    const prompt = `Event: ${milestone.type}\nTool: ${toolName}\nRecent context: ${ctx}`;
    geminiPromise = callGemini(prompt, config);
  }

  // Generate narration text
  let text;
  if (pattern && PATTERN_PHRASES[pattern]) {
    const phrases = PATTERN_PHRASES[pattern];
    text = phrases[now % phrases.length];
  } else if (state.consecutiveCount === threshold) {
    const toolLabel = toolName === 'Read' ? 'read' :
                      toolName === 'Edit' ? 'edit' :
                      toolName === 'Write' ? 'write' :
                      toolName === 'Grep' ? 'search through' :
                      toolName === 'Glob' ? 'find' :
                      `use ${toolName} on`;
    text = askStyle(`${toolLabel} a few more files`);
  } else if (state.consecutiveCount > threshold) {
    state.lastTool = toolName;
    state.lastTimestamp = now;
    saveState(stPath, state);
    return;
  } else {
    text = generateNarration(toolName, toolInput, state);
  }

  // Warm connectors on tool-type change
  if (!pattern) {
    text = maybeAddConnector(text, state, toolName);
  }

  // Context awareness — prepend area if stable
  if (state.consecutiveCount === 1 && !pattern) {
    const area = inferArea(recentActions);
    if (area && text && !text.toLowerCase().includes(area)) {
      const lastArea = state.lastArea;
      if (area !== lastArea) {
        text = `Still on ${area}. ${text}`;
      }
    }
    state.lastArea = inferArea(recentActions);
  }

  // If Gemini returned in time, use its text for milestone events
  if (geminiPromise) {
    const geminiText = await geminiPromise;
    if (geminiText && geminiText.length > 3 && geminiText.length < 100) {
      text = geminiText;
    }
  }

  // Update state
  state.lastTool = toolName;
  state.lastTimestamp = now;

  // Destructive action alert
  const command = toolInput.command || '';
  const destructive = toolName === 'Bash' && isDestructive(command);

  if (destructive) {
    playAlert(config);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Speak
  speak(text, config, destructive, sessionNum);

  // Save state
  saveState(stPath, state);

  // Occasionally clean up old temp files
  if (Math.random() < 0.05) cleanupOldTempFiles();
}

// ─── PostToolUse — failure & success narration ──────────────────────────────

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

  if (toolName !== 'Bash') return;

  const exitCode = toolOutput.exitCode ?? toolOutput.exit_code;
  const cmd = (input.tool_input?.command || '').trim();
  const isTestCmd = /test|spec|jest|pytest|cargo\s+test|go\s+test/i.test(cmd);
  const isBuildCmd = /\bbuild\b/i.test(cmd);

  // Store exit code in state for pattern detection
  const sessionNum = getSessionNumber();
  const stPath = statePath(sessionNum);
  const state = loadState(stPath);
  state.lastBashExitCode = exitCode;
  saveState(stPath, state);

  // Determine if we should narrate
  const isFailure = exitCode !== 0 && exitCode !== undefined && exitCode !== null;
  const isTestSuccess = exitCode === 0 && isTestCmd;

  if (!isFailure && !isTestSuccess) return;

  applySessionVoice(config, sessionNum);

  // Try Gemini for richer narration
  const jarvis = config.jarvis || DEFAULTS.jarvis;
  let text;

  if (jarvis.enabled && (jarvis.apiKey || process.env.GEMINI_API_KEY)) {
    const stderr = (toolOutput.stderr || '').slice(0, 200);
    const eventType = isFailure ? (isTestCmd ? 'test_failure' : isBuildCmd ? 'build_failure' : 'command_failure') : 'test_success';
    const prompt = `Event: ${eventType}\nCommand: ${cmd}\n${isFailure && stderr ? `Error snippet: ${stderr}\n` : ''}`;
    text = await callGemini(prompt, config);
  }

  // Fallback to static phrases
  if (!text) {
    if (isTestSuccess) {
      text = 'Nice, tests are green';
    } else if (isTestCmd) {
      text = 'Tests failed';
    } else if (isBuildCmd) {
      text = 'Build failed';
    } else {
      text = 'That failed';
    }
  }

  const failVolume = isFailure ? (config.volume ?? 0.5) * 0.8 : config.volume ?? 0.5;
  const speakConfig = { ...config, volume: failVolume };

  if (isFailure) {
    playAlert(speakConfig);
    await new Promise((r) => setTimeout(r, 200));
  }

  speak(text, speakConfig, isFailure, sessionNum);
}

// ─── Stop — turn-completion narration ────────────────────────────────────────

async function mainStop() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const rawInput = Buffer.concat(chunks).toString('utf8');
  process.stdout.write(rawInput);

  let input;
  try { input = JSON.parse(rawInput); } catch { return; }

  if (fs.existsSync(MUTE_FILE)) return;
  const config = loadConfig();
  if (!config.enabled) return;
  if (!(config.narrateStop ?? DEFAULTS.narrateStop)) return;

  const sessionNum = getSessionNumber();
  applySessionVoice(config, sessionNum);

  const stPath = statePath(sessionNum);
  const state = loadState(stPath);

  // Count actions since last Stop
  const lastStop = state.lastStopTimestamp || 0;
  const recentActions = state.recentActions || [];
  const actionsSinceStop = recentActions.filter((a) => a.ts > lastStop);

  // Update timestamp regardless of narration
  state.lastStopTimestamp = Date.now();
  saveState(stPath, state);

  // Text-only turn (0 tool calls) → silent
  if (actionsSinceStop.length === 0) return;

  let text;

  if (actionsSinceStop.length >= 3) {
    // Substantial turn — try Gemini summary
    const jarvis = config.jarvis || DEFAULTS.jarvis;
    if (jarvis.enabled && (jarvis.apiKey || process.env.GEMINI_API_KEY)) {
      const toolCounts = {};
      for (const a of actionsSinceStop) {
        toolCounts[a.tool] = (toolCounts[a.tool] || 0) + 1;
      }
      const toolSummary = Object.entries(toolCounts).map(([t, c]) => `${t} x${c}`).join(', ');
      const lastMsg = (input.last_assistant_message || '').slice(0, 300);
      const prompt = `Event: turn_complete\nTools used: ${actionsSinceStop.length} (${toolSummary})\nLast message: ${lastMsg}\nGenerate a warm 1-sentence summary of what was accomplished.`;
      text = await callGemini(prompt, config);
    }
    // Fallback to ambient phrase if no Gemini
    if (!text) {
      text = STOP_PHRASES[Date.now() % STOP_PHRASES.length];
    }
  } else {
    // Quick turn (1-2 tools) — ambient phrase
    text = STOP_PHRASES[Date.now() % STOP_PHRASES.length];
  }

  speak(text, config, false, sessionNum);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes('--stop')) {
  mainStop().catch(() => {});
} else if (process.argv.includes('--post')) {
  mainPost().catch(() => {});
} else {
  main().catch(() => {});
}
