#!/bin/bash
set -euo pipefail

# ─── Claude Code Narrator — Installer ───────────────────────────────────────
# Usage:
#   git clone https://github.com/YOUR_USER/claude-narrator && cd claude-narrator && ./install.sh
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
  warn "Config already exists at $CONFIG_FILE — keeping your settings"
else
  cp "$SOURCE_DIR/narrator.json" "$CONFIG_FILE"
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

info "Registering PreToolUse hook..."

HOOK_ENTRY="{\"type\":\"command\",\"command\":\"node $SCRIPTS_DIR/narrator.js\"}"

if [ -f "$SETTINGS_FILE" ]; then
  # Read existing settings
  EXISTING=$(cat "$SETTINGS_FILE")

  # Check if hook already registered
  if echo "$EXISTING" | node -e "
    const fs = require('fs');
    const input = fs.readFileSync('/dev/stdin', 'utf8');
    try {
      const settings = JSON.parse(input);
      const hooks = settings.hooks?.PreToolUse || [];
      const exists = hooks.some(h => h.command && h.command.includes('narrator.js'));
      process.exit(exists ? 0 : 1);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    warn "Hook already registered in settings.json — skipping"
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
        type: 'command',
        command: 'node $SCRIPTS_DIR/narrator.js'
      });
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    " <<< "$EXISTING"
    ok "Registered PreToolUse hook in settings.json"
  fi
else
  # Create new settings file with hook
  node -e "
    const fs = require('fs');
    const settings = {
      hooks: {
        PreToolUse: [{
          type: 'command',
          command: 'node $SCRIPTS_DIR/narrator.js'
        }]
      }
    };
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
  "
  ok "Created settings.json with PreToolUse hook"
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
echo "  Voices: run 'say -v \"?\"' to see all available voices"
echo ""

# Test sound
if command -v say &>/dev/null; then
  info "Playing test narration..."
  say -v "${NARRATOR_VOICE:-Daniel}" "Claude Code Narrator installed" &
fi
