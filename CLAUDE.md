# Claude Code Narrator

Audio co-pilot for Claude Code. Hooks into PreToolUse to speak what Claude is about to do before each tool execution.

## Architecture

```
Claude Code action
       |
       v
PreToolUse hook → narrator.js (stdin JSON → narration → stdout passthrough)
       |
       +-- macOS `say` (default, free)
       +-- ElevenLabs API (optional, cached to ~/.claude/narrator-cache/)
```

**Single file, zero dependencies.** Pure Node.js 18+ stdlib. No npm, no package.json.

## File Structure

```
narrator.js          # Main hook script (579 lines). Reads JSON from stdin,
                     #   generates narration, speaks via TTS, outputs JSON to stdout.
                     #   Contains: config loading, state management, narration generation,
                     #   ~40 bash command templates, path intelligence, repetition suppression,
                     #   destructive action alerts, context awareness, ElevenLabs caching
narrator.json        # Default config (Samantha voice, 210 WPM, say engine)
install.sh           # Non-destructive installer: copies script to ~/.claude/scripts/,
                     #   registers PreToolUse hook in settings.json, installs slash commands,
                     #   adds shell aliases. Won't overwrite existing config
uninstall.sh         # Clean uninstaller: removes script, hook, commands, aliases, temp files.
                     #   Optionally removes config and ElevenLabs cache
commands/
  narrator-mute.md   # /narrator-mute slash command (touch ~/.claude/narrator-muted)
  narrator-unmute.md # /narrator-unmute slash command (rm mute file)
  narrator-voice.md  # /narrator-voice slash command (update voice in config)
```

## Installed Locations

When installed, files go to:
- `~/.claude/scripts/narrator.js` — the hook script
- `~/.claude/narrator.json` — user config
- `~/.claude/commands/narrator-*.md` — slash commands
- `~/.claude/settings.json` — PreToolUse hook registration
- `~/.claude/narrator-muted` — mute sentinel file (presence = muted)
- `~/.claude/narrator-cache/` — ElevenLabs audio cache (7-day TTL)
- `/tmp/claude-narrator-*.aiff` — macOS say temp files (5-min TTL)
- `/tmp/claude-narrator-state.json` — repetition/context state

## Key Design Decisions

- **Passthrough guarantee**: stdin JSON is always written to stdout unchanged, even on errors. The narrator never blocks or modifies Claude Code's operation
- **Conversational tone**: Narrations use "Want to..." prefix ("Want to read the auth service") instead of imperative ("Reading auth service")
- **Path intelligence**: Strips home dir, project prefixes, and file extensions. Maps index/page files to parent directory names. Adds parent context for generic names (service, utils, types)
- **Repetition suppression**: Same tool 1-2x = full narration, 3rd = batch summary, 4th+ = silent. Resets after 10s gap or tool type change
- **Destructive alerts**: Bash commands matching rm -rf, force push, DROP TABLE etc. trigger system alert sound before narration at slower rate
- **ElevenLabs caching**: MD5 hash of (engine:voice:rate:text) for macOS say, (el:voiceId:model:text) for ElevenLabs. Prevents redundant API calls

## Config Reference

`~/.claude/narrator.json`:
- `enabled` (bool, default true) — master switch
- `tts` ("say" | "elevenlabs") — TTS engine
- `voice` (string, default "Samantha") — macOS voice name
- `rate` (int, default 210) — words per minute for macOS say
- `volume` (float, default 0.5) — playback volume 0.0-1.0
- `elevenlabs` (object) — { apiKey, voiceId, model }
- `narrateTools` (string[]) — tools to narrate
- `skipTools` (string[]) — tools to skip
- `repetitionThreshold` (int, default 3) — same-tool count before batching

## Development Notes

- macOS only (uses `say` + `afplay` commands)
- Audio playback is fire-and-forget (detached child process, unref'd)
- Temp file cleanup runs probabilistically (5% chance per invocation)
- State file at /tmp/ is ephemeral by design — survives session but not reboot
- ElevenLabs fallback: on API error or timeout (4s), falls back to macOS say

## Commit Convention

- Do NOT include "Co-Authored-By" lines in commit messages
- Use conventional commits: feat, fix, docs, chore

## GitHub

- **Repo:** https://github.com/khaytbaev-code/claude-narrator.git
- **Branch:** main
- **License:** MIT
