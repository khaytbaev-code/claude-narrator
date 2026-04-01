# Claude Code Narrator

Jarvis-like audio co-pilot for Claude Code. Two-tier narration system with mlx-audio Kokoro voices and optional Gemini-powered milestone commentary.

## Architecture

```
Claude Code action
       |
       v
PreToolUse hook → narrator.js
       |
       +-- Fast Tier (enhanced templates, no API)
       |     Rich phrasing pools (4-5 variants per verb)
       |     Pattern detection (debugging loop, exploring, refactoring)
       |     Warm connectors on tool-type transitions
       |
       +-- Rich Tier (Gemini API, milestones only)
       |     Task transitions, completion summaries
       |     Fires concurrently — fast tier plays if Gemini is slow
       |
       +-- TTS Engine
             mlx-audio Kokoro (default, 54 voices, Apple Silicon)
             macOS say (fallback)
             ElevenLabs (optional premium)

PostToolUse hook → narrator.js --post
       |
       +-- Bash failures → Gemini-enriched "Null ref on line 42" or fallback "Tests failed"
       +-- Test success → "Nice, tests are green"
       +-- Stores lastBashExitCode for pattern detection
```

**Single file, zero JS dependencies.** Pure Node.js 18+ stdlib. mlx-audio installed via pip.

## File Structure

```
narrator.js          # Main hook script (~1000 lines). Reads JSON from stdin,
                     #   generates two-tier narration, speaks via TTS, outputs JSON to stdout.
                     #   Contains: session detection, config loading, state management,
                     #   rich phrasing pools, pattern detection, warm connectors,
                     #   milestone detection, Gemini API client, mlx-audio/say/ElevenLabs TTS,
                     #   kill-and-replace audio, PostToolUse failure+success narration
narrator.json        # Default config (mlx Kokoro voice, Jarvis disabled by default)
install.sh           # Installer: auto-installs mlx-audio on Apple Silicon,
                     #   copies script, registers hooks, installs commands, adds aliases
uninstall.sh         # Clean uninstaller: removes everything, offers mlx-audio uninstall
commands/
  narrator-mute.md   # /narrator-mute slash command
  narrator-unmute.md # /narrator-unmute slash command
  narrator-voice.md  # /narrator-voice slash command
```

## Installed Locations

- `~/.claude/scripts/narrator.js` — the hook script
- `~/.claude/narrator.json` — user config
- `~/.claude/commands/narrator-*.md` — slash commands
- `~/.claude/settings.json` — PreToolUse + PostToolUse hook registration
- `~/.claude/narrator-muted` — mute sentinel file (presence = muted)
- `~/.claude/narrator-cache/` — ElevenLabs audio cache (7-day TTL)
- `/tmp/claude-narrator-sess*-*.{aiff,wav}` — TTS temp files (5-min TTL, session-scoped)
- `/tmp/claude-narrator-state-N.json` — per-session state (repetition, patterns, verbIndex)
- `/tmp/claude-narrator-sessions.json` — active session registry

## Key Design Decisions

- **Passthrough guarantee**: stdin JSON is always written to stdout unchanged, even on errors
- **Two-tier narration**: Fast tier (templates) for per-tool calls, Rich tier (Gemini) for milestones only
- **mlx-audio default**: Kokoro 54 voices on Apple Silicon. macOS `say` fallback on Intel or errors
- **Rich phrasing pools**: Each verb ("read", "edit", "search") has 4-5 variants that rotate with last-used exclusion
- **Pattern detection**: Detects debugging loops, exploration, refactoring passes, wrap-up from tool history
- **Warm connectors**: "OK, " / "Alright, " / "Now " prepended on tool-type transitions
- **Kill-and-replace audio**: pkill previous afplay per session before new narration. No overlap
- **Gemini milestone narration**: Context-aware commentary at task transitions, failures, completions. Fire-and-forget on PreToolUse, await on PostToolUse
- **Multi-session voices**: Each session gets distinct Kokoro voice + phrasing style via PPID detection
- **PostToolUse narration**: Failures get Gemini-enriched commentary. Test success gets "Nice, tests are green". Regular success = silent

## Multi-Session Voices

| Session | Kokoro Voice | macOS say Fallback | Phrasing Style |
|---------|-------------|-------------------|----------------|
| 0 | af_heart | Samantha | Casual — "Can I...?", "Mind if I...?" |
| 1 | am_adam | Daniel (Enhanced) | Polite — "Should I...?", "Would you like me to...?" |
| 2 | bf_emma | Karen (Enhanced) | Brief — "Quick...", "Need to..." |
| 3 | am_michael | Tessa (Enhanced) | Confident — "Now I'll...", "Next up..." |

## Config Reference

`~/.claude/narrator.json`:
- `enabled` (bool, default true) — master switch
- `tts` ("mlx" | "say" | "elevenlabs") — TTS engine. Default "mlx" on Apple Silicon
- `mlx` (object) — { model, voice, speed }. Kokoro TTS settings
- `jarvis` (object) — { enabled, apiKey, model, personality, timeoutMs }. Gemini milestone narration
- `voice` (string, default "Samantha") — macOS say voice (fallback)
- `rate` (int, default 210) — words per minute for macOS say
- `volume` (float, default 0.5) — playback volume 0.0-1.0
- `elevenlabs` (object) — { apiKey, voiceId, model }
- `sessionVoices` (array) — voices for sessions 1+ [{ voice, mlxVoice, rate }]
- `narrateTools` (string[]) — tools to narrate
- `skipTools` (string[]) — tools to skip
- `narrateFailures` (bool, default true) — speak Bash failures/successes via PostToolUse
- `repetitionThreshold` (int, default 3) — same-tool count before batching

## Development Notes

- macOS only (uses `afplay` for playback)
- mlx-audio requires Apple Silicon (M1+) and Python 3.9+
- First mlx-audio call per boot ~2-3s (model loading), subsequent ~200-500ms
- Audio file caching: hash-based, same text+voice+speed = cache hit
- Gemini API calls use https module directly, 2s timeout, no retries
- State files at /tmp/ are ephemeral — survive session but not reboot
- Cleanup: .aiff + .wav files cleaned (5-min TTL), ElevenLabs cache (7-day TTL)

## Commit Convention

- Do NOT include "Co-Authored-By" lines in commit messages
- Use conventional commits: feat, fix, docs, chore

## GitHub

- **Repo:** https://github.com/khaytbaev-code/claude-narrator.git
- **Branch:** main
- **License:** MIT
