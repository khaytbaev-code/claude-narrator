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
const STATE_PATH = '/tmp/claude-narrator-state.json';
const MUTE_FILE = path.join(HOME, '.claude', 'narrator-muted');
const TMP_DIR = '/tmp';
const TMP_PREFIX = 'claude-narrator-';
const CACHE_DIR = path.join(HOME, '.claude', 'narrator-cache');

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
  maxContextItems: 15,
  repetitionThreshold: 3,
  destructiveAlertSound: '/System/Library/Sounds/Basso.aiff',
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

// ─── Bash command templates ─────────────────────────────────────────────────

const BASH_TEMPLATES = [
  [/^git\s+status/,          'Want to check git status'],
  [/^git\s+diff/,            'Want to review the changes'],
  [/^git\s+log/,             'Want to check git history'],
  [/^git\s+add/,             'Want to stage the changes'],
  [/^git\s+commit/,          'Want to commit the changes'],
  [/^git\s+push\s+.*--force/,'Want to force push to remote'],
  [/^git\s+push\s+.*-f\b/,  'Want to force push to remote'],
  [/^git\s+push/,            'Want to push to remote'],
  [/^git\s+pull/,            'Want to pull from remote'],
  [/^git\s+checkout/,        'Want to switch branches'],
  [/^git\s+branch/,          'Want to manage branches'],
  [/^git\s+merge/,           'Want to merge branches'],
  [/^git\s+rebase/,          'Want to rebase'],
  [/^git\s+stash/,           'Want to stash changes'],
  [/^git\s+reset\s+--hard/,  'Want to reset git history'],
  [/^git\s+clone/,           'Want to clone a repository'],
  [/^(npm|yarn|pnpm)\s+run\s+(test|spec)/i, 'Want to run the tests'],
  [/^(npm|yarn|pnpm)\s+test/i, 'Want to run the tests'],
  [/^pytest\b/,              'Want to run the tests'],
  [/^jest\b/,                'Want to run the tests'],
  [/^cargo\s+test/,          'Want to run the tests'],
  [/^go\s+test/,             'Want to run the tests'],
  [/^(npm|yarn|pnpm)\s+run\s+build/i, 'Want to build the project'],
  [/^(npm|yarn|pnpm)\s+run\s+dev/i,   'Want to start the dev server'],
  [/^(npm|yarn|pnpm)\s+run\s+lint/i,  'Want to run the linter'],
  [/^(npm|pip|yarn|pnpm)\s+install/i,  'Want to install dependencies'],
  [/^pip\s+install/i,        'Want to install dependencies'],
  [/^cargo\s+build/,         'Want to build the project'],
  [/^go\s+build/,            'Want to build the project'],
  [/^rm\s+-rf\b/,            'Want to delete some files'],
  [/^rm\s/,                  'Want to delete a file'],
  [/^ls\b/,                  'Want to list the directory'],
  [/^find\s/,                'Want to search for files'],
  [/^mkdir\b/,               'Want to create a directory'],
  [/^docker\s/,              'Want to run docker'],
  [/^docker-compose\s/,      'Want to run docker compose'],
  [/^curl\s/,                'Want to make a network request'],
  [/^wget\s/,                'Want to make a network request'],
  [/^gh\s/,                  'Want to use GitHub CLI'],
  [/^cat\s/,                 'Want to read a file'],
  [/^cd\s/,                  'Want to change directory'],
  [/^cp\s/,                  'Want to copy some files'],
  [/^mv\s/,                  'Want to move some files'],
  [/^chmod\s/,               'Want to change permissions'],
  [/^echo\s/,                'Want to run echo'],
  [/^python3?\s/,            'Want to run Python'],
  [/^node\s/,                'Want to run Node'],
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

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch { /* fall through */ }
  return { lastTool: null, consecutiveCount: 0, lastTimestamp: 0, recentActions: [] };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), 'utf8');
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

  // For index/page files, use parent directory
  if (/^(index|page|layout|route)\.(ts|tsx|js|jsx|py)$/.test(fileName)) {
    const name = parentDir
      .replace(/^\[.*\]$/, 'detail')
      .replace(/^\(.*\)$/, (m) => m.slice(1, -1))
      .replace(/[-_]/g, ' ');
    return `the ${name} page`;
  }

  // For common config files
  if (/^(package|tsconfig|tailwind\.config|next\.config|\.env)/.test(fileName)) {
    return fileName.replace(/\.(json|js|ts|mjs|cjs)$/, '').replace(/[-_.]/g, ' ');
  }

  // General case: strip extension, convert separators to spaces
  const base = fileName
    .replace(/\.(ts|tsx|js|jsx|py|rs|go|java|rb|md|json|yaml|yml|toml|css|scss|html|sql)$/, '')
    .replace(/[-_]/g, ' ');

  // Add context from parent dir if the name is too generic
  if (/^(service|utils?|helpers?|types?|models?|config|constants?)$/.test(base) && parentDir) {
    return `the ${parentDir.replace(/[-_]/g, ' ')} ${base}`;
  }

  return base;
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

  // Priority 1: Use description field if non-generic — prefix with conversational tone
  if (desc && desc.length > 5 && !GENERIC_DESC.some((rx) => rx.test(desc))) {
    const words = desc.split(/\s+/);
    const trimmed = words.length <= 10 ? desc : words.slice(0, 8).join(' ');
    return `Want to ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
  }

  // Priority 2: Template matching
  switch (toolName) {
    case 'Read': {
      const name = friendlyPath(toolInput.file_path);
      return name ? `Want to read ${name}` : 'Want to read a file';
    }
    case 'Edit': {
      const name = friendlyPath(toolInput.file_path);
      return name ? `Want to edit ${name}` : 'Want to edit a file';
    }
    case 'Write': {
      const name = friendlyPath(toolInput.file_path);
      const verb = toolInput.file_path && fs.existsSync(toolInput.file_path) ? 'update' : 'create';
      return name ? `Want to ${verb} ${name}` : `Want to ${verb} a file`;
    }
    case 'Grep': {
      const pat = shortPattern(toolInput.pattern);
      return `Want to search for ${pat}`;
    }
    case 'Glob': {
      const pat = toolInput.pattern || '';
      return pat ? `Want to find ${pat} files` : 'Want to find some files';
    }
    case 'Bash': {
      const cmd = (toolInput.command || '').trim();
      for (const [rx, text] of BASH_TEMPLATES) {
        if (rx.test(cmd)) return text;
      }
      return 'Want to run a command';
    }
    case 'Agent': {
      const agentDesc = toolInput.description || '';
      if (agentDesc && agentDesc.length > 3) {
        const words = agentDesc.split(/\s+/);
        return words.length <= 6 ? `Want to launch an agent for ${agentDesc}` : `Want to launch an agent for ${words.slice(0, 5).join(' ')}`;
      }
      return 'Want to launch a sub-agent';
    }
    default:
      return `Want to use ${toolName}`;
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

function speakWithSay(text, config, isDestructiveAction) {
  const voice = config.voice || DEFAULTS.voice;
  const rate = isDestructiveAction ? 190 : (config.rate || DEFAULTS.rate);
  const volume = config.volume ?? DEFAULTS.volume;

  const hash = crypto.createHash('md5').update(`say:${voice}:${rate}:${text}`).digest('hex').slice(0, 12);
  const tmpFile = path.join(TMP_DIR, `${TMP_PREFIX}${hash}.aiff`);

  try {
    if (!fs.existsSync(tmpFile)) {
      execSync(`say -v "${voice}" -r ${rate} -o "${tmpFile}" "${text.replace(/"/g, '\\"')}"`, {
        timeout: 3000,
        stdio: 'ignore',
      });
    }
    playFile(tmpFile, config.volume ?? DEFAULTS.volume);
  } catch { /* never block */ }
}

function speakWithElevenLabs(text, config, isDestructiveAction) {
  const el = config.elevenlabs || {};
  const apiKey = el.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return speakWithSay(text, config, isDestructiveAction);

  const voiceId = el.voiceId || 'EXAVITQu4vr4xnSDxMaL'; // Sarah
  const model = el.model || 'eleven_turbo_v2_5';
  const volume = config.volume ?? DEFAULTS.volume;

  // Cache in persistent dir (ElevenLabs calls cost money)
  ensureCacheDir();
  const hash = crypto.createHash('md5').update(`el:${voiceId}:${model}:${text}`).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

  // Cache hit — play immediately
  if (fs.existsSync(cacheFile)) {
    playFile(cacheFile, volume);
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
      speakWithSay(text, config, isDestructiveAction);
      res.resume();
      return;
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const audio = Buffer.concat(chunks);
        fs.writeFileSync(cacheFile, audio);
        playFile(cacheFile, volume);
      } catch { /* ignore */ }
    });
  });

  req.on('error', () => {
    // Fallback to say
    speakWithSay(text, config, isDestructiveAction);
  });
  req.on('timeout', () => {
    req.destroy();
    speakWithSay(text, config, isDestructiveAction);
  });
  req.write(body);
  req.end();
}

function speak(text, config, isDestructiveAction) {
  const tts = config.tts || DEFAULTS.tts;
  if (tts === 'elevenlabs') {
    speakWithElevenLabs(text, config, isDestructiveAction);
  } else {
    speakWithSay(text, config, isDestructiveAction);
  }
}

function playFile(filePath, volume) {
  try {
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

  // Check if tool should be narrated
  const narrate = config.narrateTools || DEFAULTS.narrateTools;
  const skip = config.skipTools || [];
  if (skip.includes(toolName)) return;
  if (!narrate.includes(toolName)) return;

  // Load state
  const state = loadState();
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
    text = `Want to ${toolLabel} a few more files`;
  } else if (state.consecutiveCount > threshold) {
    // Silent — too many repetitions
    saveState(state);
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
  speak(text, config, destructive);

  // Save state
  saveState(state);

  // Occasionally clean up old temp files
  if (Math.random() < 0.05) cleanupOldTempFiles();
}

// Top-level safety wrapper
main().catch(() => {
  // If anything goes wrong, we already wrote stdin to stdout
  // Just exit cleanly
});
