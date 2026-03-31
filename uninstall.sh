#!/bin/bash
set -euo pipefail

# ─── Claude Code Narrator — Uninstaller ─────────────────────────────────────

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}[narrator]${NC} $1"; }
ok()    { echo -e "${GREEN}[narrator]${NC} $1"; }
warn()  { echo -e "${YELLOW}[narrator]${NC} $1"; }

CLAUDE_DIR="$HOME/.claude"
SCRIPTS_DIR="$CLAUDE_DIR/scripts"
COMMANDS_DIR="$CLAUDE_DIR/commands"
CONFIG_FILE="$CLAUDE_DIR/narrator.json"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
MUTE_FILE="$CLAUDE_DIR/narrator-muted"

echo ""
echo -e "${YELLOW}  Uninstalling Claude Code Narrator...${NC}"
echo ""

# ─── Remove narrator script ─────────────────────────────────────────────────

if [ -f "$SCRIPTS_DIR/narrator.js" ]; then
  rm -f "$SCRIPTS_DIR/narrator.js"
  ok "Removed narrator.js"
else
  warn "narrator.js not found — skipping"
fi

# ─── Remove slash commands ───────────────────────────────────────────────────

for cmd in narrator-mute narrator-unmute narrator-voice; do
  if [ -f "$COMMANDS_DIR/$cmd.md" ]; then
    rm -f "$COMMANDS_DIR/$cmd.md"
    ok "Removed $cmd.md"
  fi
done

# ─── Remove mute file ───────────────────────────────────────────────────────

rm -f "$MUTE_FILE"

# ─── Remove hook from settings.json ─────────────────────────────────────────

if [ -f "$SETTINGS_FILE" ]; then
  info "Removing PreToolUse hook from settings.json..."
  node -e "
    const fs = require('fs');
    const raw = fs.readFileSync('$SETTINGS_FILE', 'utf8');
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      process.exit(0);
    }
    if (settings.hooks && Array.isArray(settings.hooks.PreToolUse)) {
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
        h => !(h.command && h.command.includes('narrator.js'))
      );
      if (settings.hooks.PreToolUse.length === 0) {
        delete settings.hooks.PreToolUse;
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
  " 2>/dev/null && ok "Removed hook from settings.json" || warn "Could not update settings.json"
fi

# ─── Remove shell aliases ───────────────────────────────────────────────────

for RC_FILE in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$RC_FILE" ] && grep -q "Claude Code Narrator aliases" "$RC_FILE" 2>/dev/null; then
    # Remove the alias block (from comment to last alias line)
    sed -i.bak '/# Claude Code Narrator aliases/,/^alias narrator-/d' "$RC_FILE"
    rm -f "${RC_FILE}.bak"
    ok "Removed aliases from $RC_FILE"
  fi
done

# ─── Clean up temp files ────────────────────────────────────────────────────

TEMP_COUNT=$(ls /tmp/claude-narrator-*.aiff 2>/dev/null | wc -l || echo 0)
rm -f /tmp/claude-narrator-*.aiff
rm -f /tmp/claude-narrator-state.json
if [ "$TEMP_COUNT" -gt 0 ]; then
  ok "Cleaned up $TEMP_COUNT temp files"
fi

# ─── Ask about config ───────────────────────────────────────────────────────

if [ -f "$CONFIG_FILE" ] || [ -d "$CLAUDE_DIR/narrator-cache" ]; then
  echo ""
  read -p "  Remove narrator config and audio cache? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$CONFIG_FILE"
    rm -rf "$CLAUDE_DIR/narrator-cache"
    ok "Removed config and cache"
  else
    warn "Kept config at $CONFIG_FILE"
  fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Claude Code Narrator uninstalled successfully.${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Claude Code will continue to work normally without narration."
echo ""
