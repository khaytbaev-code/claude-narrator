#!/bin/bash
set -euo pipefail

# ─── Claude Code Narrator — Installer ───────────────────────────────────────
# Usage:
#   git clone https://github.com/khaytbaev-code/claude-narrator && cd claude-narrator && ./install.sh
#   OR
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/claude-narrator/main/install.sh | bash

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}[narrator]${NC} $1"; }
ok()    { echo -e "${GREEN}[narrator]${NC} $1"; }
warn()  { echo -e "${YELLOW}[narrator]${NC} $1"; }
fail()  { echo -e "${RED}[narrator]${NC} $1"; exit 1; }

CLAUDE_DIR="$HOME/.claude"
SCRIPTS_DIR="$CLAUDE_DIR/scripts"
COMMANDS_DIR="$CLAUDE_DIR/commands"
CONFIG_FILE="$CLAUDE_DIR/narrator.json"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# ─── Prerequisites ───────────────────────────────────────────────────────────

info "Checking prerequisites..."

# Node.js >= 18
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node.js 18+ first: https://nodejs.org"
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js $NODE_MAJOR found, but 18+ required. Please upgrade."
fi
ok "Node.js $(node --version) found"

# macOS say command
if ! command -v say &>/dev/null; then
  warn "'say' command not found — narrator requires macOS. On Linux, audio will be skipped."
fi

# Claude Code directory
if [ ! -d "$CLAUDE_DIR" ]; then
  fail "~/.claude directory not found. Is Claude Code installed?"
fi
ok "Claude Code directory found"

# ─── Install mlx-audio (Apple Silicon) ──────────────────────────────────────

MLX_TTS="say"
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  info "Apple Silicon detected — installing mlx-audio for Kokoro voices..."
  if command -v python3 &>/dev/null; then
    PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
    if [ "$PYTHON_MAJOR" -ge 3 ] && [ "$PYTHON_MINOR" -ge 9 ]; then
      if python3 -c "import mlx_audio" 2>/dev/null; then
        ok "mlx-audio already installed"
        MLX_TTS="mlx"
      else
        if command -v uv &>/dev/null; then
          uv pip install mlx-audio 2>/dev/null && MLX_TTS="mlx" && ok "Installed mlx-audio via uv" || warn "Failed to install mlx-audio — using macOS say"
        elif command -v pip3 &>/dev/null; then
          pip3 install mlx-audio 2>/dev/null && MLX_TTS="mlx" && ok "Installed mlx-audio via pip3" || warn "Failed to install mlx-audio — using macOS say"
        elif command -v pip &>/dev/null; then
          pip install mlx-audio 2>/dev/null && MLX_TTS="mlx" && ok "Installed mlx-audio via pip" || warn "Failed to install mlx-audio — using macOS say"
        else
          warn "Neither uv, pip3, nor pip found — cannot install mlx-audio. Using macOS say"
        fi
      fi
    else
      warn "Python $PYTHON_VERSION found, but 3.9+ required for mlx-audio — using macOS say"
    fi
  else
    warn "Python 3 not found — mlx-audio requires Python 3.9+. Using macOS say"
  fi
else
  warn "Intel Mac detected — mlx-audio requires Apple Silicon. Using macOS say"
fi

# ─── Determine script source ────────────────────────────────────────────────

# If running from a cloned repo, use local files. Otherwise, download.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/narrator.js" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
  info "Installing from local directory: $SOURCE_DIR"
else
  # Download to temp directory
  SOURCE_DIR=$(mktemp -d)
  info "Downloading narrator files..."
  REPO_URL="https://raw.githubusercontent.com/YOUR_USER/claude-narrator/main"
  curl -fsSL "$REPO_URL/narrator.js" -o "$SOURCE_DIR/narrator.js" || fail "Failed to download narrator.js"
  curl -fsSL "$REPO_URL/narrator.json" -o "$SOURCE_DIR/narrator.json" || fail "Failed to download narrator.json"
  mkdir -p "$SOURCE_DIR/commands"
  curl -fsSL "$REPO_URL/commands/narrator-mute.md" -o "$SOURCE_DIR/commands/narrator-mute.md" 2>/dev/null || true
  curl -fsSL "$REPO_URL/commands/narrator-unmute.md" -o "$SOURCE_DIR/commands/narrator-unmute.md" 2>/dev/null || true
  curl -fsSL "$REPO_URL/commands/narrator-voice.md" -o "$SOURCE_DIR/commands/narrator-voice.md" 2>/dev/null || true
  ok "Downloaded narrator files"
fi

# ─── Install narrator script ────────────────────────────────────────────────

info "Installing narrator script..."
mkdir -p "$SCRIPTS_DIR"
cp "$SOURCE_DIR/narrator.js" "$SCRIPTS_DIR/narrator.js"
chmod +x "$SCRIPTS_DIR/narrator.js"
ok "Installed narrator.js to $SCRIPTS_DIR/"

# ─── Install config (don't overwrite existing) ──────────────────────────────

if [ -f "$CONFIG_FILE" ]; then
  # Update tts engine in existing config if mlx is available
  if [ "$MLX_TTS" = "mlx" ]; then
    node -e "
      const fs = require('fs');
      const raw = fs.readFileSync('$CONFIG_FILE', 'utf8');
      const conf = JSON.parse(raw);
      if (!conf.mlx) conf.mlx = { model: 'mlx-community/Kokoro-82M-bf16', voice: 'af_heart', speed: 1.0 };
      if (!conf.jarvis) conf.jarvis = { enabled: false, apiKey: '', model: 'gemini-2.5-flash-lite', personality: 'warm', timeoutMs: 2000 };
      if (conf.tts === 'say') conf.tts = 'mlx';
      if (!conf.narrateFailures) conf.narrateFailures = true;
      // Add mlxVoice to sessionVoices if missing
      const defaultMlxVoices = ['am_adam', 'bf_emma', 'am_michael'];
      if (conf.sessionVoices) {
        conf.sessionVoices = conf.sessionVoices.map((sv, i) => sv.mlxVoice ? sv : { ...sv, mlxVoice: defaultMlxVoices[i] || 'am_adam' });
      }
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(conf, null, 2) + '\n');
    " 2>/dev/null
    ok "Updated config with mlx-audio and Jarvis settings"
  else
    warn "Config already exists at $CONFIG_FILE — keeping your settings"
  fi
else
  # Fresh install — set tts based on what's available
  cp "$SOURCE_DIR/narrator.json" "$CONFIG_FILE"
  if [ "$MLX_TTS" != "mlx" ]; then
    node -e "
      const fs = require('fs');
      const conf = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      conf.tts = 'say';
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(conf, null, 2) + '\n');
    " 2>/dev/null
  fi
  ok "Installed default config to $CONFIG_FILE"
fi

# ─── Install slash commands ──────────────────────────────────────────────────

info "Installing slash commands..."
mkdir -p "$COMMANDS_DIR"
if [ -d "$SOURCE_DIR/commands" ]; then
  for cmd_file in "$SOURCE_DIR/commands"/narrator-*.md; do
    [ -f "$cmd_file" ] || continue
    cp "$cmd_file" "$COMMANDS_DIR/"
  done
  ok "Installed slash commands to $COMMANDS_DIR/"
fi

# ─── Register hook in settings.json ─────────────────────────────────────────

info "Registering hooks..."

if [ -f "$SETTINGS_FILE" ]; then
  # Read existing settings
  EXISTING=$(cat "$SETTINGS_FILE")

  # Check if both hooks already registered
  if echo "$EXISTING" | node -e "
    const fs = require('fs');
    const input = fs.readFileSync('/dev/stdin', 'utf8');
    try {
      const settings = JSON.parse(input);
      const hasNarrator = (hooks) => (hooks || []).some(h =>
        (h.command && h.command.includes('narrator.js')) ||
        (h.hooks && h.hooks.some(sub => sub.command && sub.command.includes('narrator.js')))
      );
      const pre = hasNarrator(settings.hooks?.PreToolUse);
      const post = hasNarrator(settings.hooks?.PostToolUse);
      process.exit(pre && post ? 0 : 1);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    warn "Hooks already registered in settings.json — skipping"
  else
    # Merge hook entry
    node -e "
      const fs = require('fs');
      const input = fs.readFileSync('/dev/stdin', 'utf8');
      let settings;
      try {
        settings = JSON.parse(input);
      } catch {
        settings = {};
      }
      if (!settings.hooks) settings.hooks = {};
      if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
      settings.hooks.PreToolUse.push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'node $SCRIPTS_DIR/narrator.js'
        }]
      });
      if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
      settings.hooks.PostToolUse.push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'node $SCRIPTS_DIR/narrator.js --post'
        }]
      });
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    " <<< "$EXISTING"
    ok "Registered PreToolUse and PostToolUse hooks in settings.json"
  fi
else
  # Create new settings file with hook
  node -e "
    const fs = require('fs');
    const settings = {
      hooks: {
        PreToolUse: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node $SCRIPTS_DIR/narrator.js'
          }]
        }],
        PostToolUse: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node $SCRIPTS_DIR/narrator.js --post'
          }]
        }]
      }
    };
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
  "
  ok "Created settings.json with PreToolUse and PostToolUse hooks"
fi

# ─── Shell aliases ───────────────────────────────────────────────────────────

ALIAS_BLOCK='
# Claude Code Narrator aliases
alias narrator-mute="touch ~/.claude/narrator-muted && echo \"Narrator muted\""
alias narrator-unmute="rm -f ~/.claude/narrator-muted && echo \"Narrator unmuted\""
alias narrator-test="echo '"'"'{"tool_name":"Read","tool_input":{"file_path":"~/test.txt","description":"Reading a test file"}}'"'"' | node ~/.claude/scripts/narrator.js > /dev/null"'

SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if grep -q "Claude Code Narrator aliases" "$SHELL_RC" 2>/dev/null; then
    warn "Shell aliases already in $SHELL_RC — skipping"
  else
    echo "$ALIAS_BLOCK" >> "$SHELL_RC"
    ok "Added aliases to $SHELL_RC"
  fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Claude Code Narrator installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Next steps:"
echo "    1. Start a new Claude Code session"
echo "    2. Ask Claude to read or edit a file — you'll hear it narrated!"
echo ""
echo "  Quick commands:"
echo "    narrator-mute     Silence the narrator"
echo "    narrator-unmute   Resume narration"
echo "    narrator-test     Test the narrator audio"
echo ""
echo "  Config: $CONFIG_FILE"
echo "  Jarvis: set jarvis.apiKey in $CONFIG_FILE for smart narration"
echo "  Voices: Kokoro (mlx) or run 'say -v \"?\"' for macOS voices"
echo ""

# Test sound
if [ "$MLX_TTS" = "mlx" ]; then
  info "Playing test narration with Kokoro voice..."
  python3 -m mlx_audio.tts.generate --model "mlx-community/Kokoro-82M-bf16" --text "Claude Code Narrator installed. Jarvis mode ready." --voice "af_heart" --output "/tmp/claude-narrator-test.wav" 2>/dev/null && afplay "/tmp/claude-narrator-test.wav" &
elif command -v say &>/dev/null; then
  info "Playing test narration..."
  say -v "${NARRATOR_VOICE:-Samantha}" "Claude Code Narrator installed" &
fi
