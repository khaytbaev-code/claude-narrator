# Claude Code Narrator

Audio co-pilot for Claude Code. Hooks into PreToolUse to speak what Claude is about to do before each tool execution, and PostToolUse to narrate failures (e.g., "Tests failed", "Build failed").

## Architecture

```
Claude Code action
       |
       v
PreToolUse hook → narrator.js (stdin JSON → narration → stdout passthrough)
       |                         Kill-and-replace: pkill previous afplay for this session
       +-- Session detection (PPID-based registry)
       +-- Per-session voice & phrasing selection
       +-- macOS `say` (default, free)
       +-- ElevenLabs API (optional, cached to ~/.claude/narrator-cache/)

PostToolUse hook → narrator.js --post (narrates Bash failures only)
       |
       +-- Non-zero exit code → "That failed" / "Tests failed" / "Build failed"
       +-- Success → silent (no noise on happy path)
```

**Single file, zero dependencies.** Pure Node.js 18+ stdlib. No npm, no package.json.

## File Structure

```
narrator.js          # Main hook script. Reads JSON from stdin,
                     #   generates narration, speaks via TTS, outputs JSON to stdout.
                     #   Contains: session detection, config loading, state management,
                     #   narration generation, ~40 bash command templates, path intelligence,
                     #   repetition suppression, destructive action alerts, context awareness,
                     #   ElevenLabs caching, kill-and-replace audio overlap prevention,
                     #   PostToolUse failure narration (--post flag)
narrator.json        # Default config (Samantha voice, 210 WPM, say engine)
install.sh           # Non-destructive installer: copies script to ~/.claude/scripts/,
                     #   registers PreToolUse + PostToolUse hooks in settings.json,
                     #   installs slash commands, adds shell aliases. Won't overwrite existing config
uninstall.sh         # Clean uninstaller: removes script, hooks, commands, aliases, temp files.
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
- `~/.claude/settings.json` — PreToolUse + PostToolUse hook registration
- `~/.claude/narrator-muted` — mute sentinel file (presence = muted)
- `~/.claude/narrator-cache/` — ElevenLabs audio cache (7-day TTL)
- `/tmp/claude-narrator-sess*-*.aiff` — macOS say temp files (5-min TTL, session-scoped)
- `/tmp/claude-narrator-state-N.json` — per-session repetition/context state
- `/tmp/claude-narrator-sessions.json` — active session registry

## Key Design Decisions

- **Passthrough guarantee**: stdin JSON is always written to stdout unchanged, even on errors. The narrator never blocks or modifies Claude Code's operation
- **Permission-style phrasing**: Narrations rotate through conversational prefixes ("Can I read...?", "Mind if I edit...?", "Should I search...?") instead of imperative commands
- **Multi-session support**: Each Claude Code session is detected by parent PID and assigned a distinct voice + phrasing style so concurrent sessions are distinguishable by ear
- **Path intelligence**: Strips home dir and project prefixes. Includes file extension ("dot js", "dot py") for clarity. Adds parent folder context ("auth service dot py in services"). Maps index/page files to parent directory names
- **Repetition suppression**: Same tool 1-2x = full narration, 3rd = batch summary, 4th+ = silent. Resets after 10s gap or tool type change
- **Destructive alerts**: Bash commands matching rm -rf, force push, DROP TABLE etc. trigger system alert sound before narration at slower rate
- **ElevenLabs caching**: MD5 hash of (engine:voice:rate:text) for macOS say, (el:voiceId:model:text) for ElevenLabs. Prevents redundant API calls
- **Kill-and-replace audio**: Before each new narration, `pkill` kills any previous afplay for the same session. Prevents audio overlap from rapid tool calls. Session-scoped via filename pattern so concurrent sessions don't interfere
- **PostToolUse failure narration**: Only narrates Bash failures (non-zero exit code). Detects test/build commands for specific messages. Success = silent. Plays alert sound + spoken failure at 80% volume

## Multi-Session Voices

When multiple Claude Code sessions run concurrently, each gets a distinct voice and phrasing:

| Session | Default Voice | Phrasing Style |
|---------|--------------|----------------|
| 0 | Samantha | Casual — "Can I...?", "Mind if I...?" |
| 1 | Daniel (Enhanced) | Polite — "Should I...?", "Would you like me to...?" |
| 2 | Karen (Enhanced) | Brief — "Quick...", "Need to..." |
| 3 | Tessa (Enhanced) | Confident — "Now I'll...", "Next up..." |

Sessions are tracked via PPID in `/tmp/claude-narrator-sessions.json` and expire after 30 min of inactivity. Customize voices via `sessionVoices` in config.

## Config Reference

`~/.claude/narrator.json`:
- `enabled` (bool, default true) — master switch
- `tts` ("say" | "elevenlabs") — TTS engine
- `voice` (string, default "Samantha") — macOS voice name (session 0)
- `rate` (int, default 210) — words per minute for macOS say
- `volume` (float, default 0.5) — playback volume 0.0-1.0
- `elevenlabs` (object) — { apiKey, voiceId, model }
- `sessionVoices` (array) — voices for sessions 1+ [{ voice, rate, elevenLabsVoiceId? }]
- `narrateTools` (string[]) — tools to narrate
- `skipTools` (string[]) — tools to skip
- `narrateFailures` (bool, default true) — speak Bash failures via PostToolUse hook
- `repetitionThreshold` (int, default 3) — same-tool count before batching

## Development Notes

- macOS only (uses `say` + `afplay` commands)
- Audio playback uses kill-and-replace (pkill previous session afplay, then spawn new detached player)
- Temp file cleanup runs probabilistically (5% chance per invocation)
- State files at /tmp/ are ephemeral by design — survive session but not reboot
- ElevenLabs fallback: on API error or timeout (4s), falls back to macOS say
- Hook format: `{ matcher: "", hooks: [{ type: "command", command: "node ..." }] }`

## Commit Convention

- Do NOT include "Co-Authored-By" lines in commit messages
- Use conventional commits: feat, fix, docs, chore

## GitHub

- **Repo:** https://github.com/khaytbaev-code/claude-narrator.git
- **Branch:** main
- **License:** MIT
