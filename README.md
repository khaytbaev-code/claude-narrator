# Claude Code Narrator

An audio co-pilot for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Instead of silently running commands, your terminal **speaks** what it's about to do — like a real assistant sitting next to you.

> Instead of seeing `cat -n frontend/lib/api.ts | sed -n '1193,1196p'`, you hear: **"Reading the API file"**

## Quick Install

```bash
git clone https://github.com/YOUR_USER/claude-narrator.git
cd claude-narrator
./install.sh
```

That's it. Start a new Claude Code session and you'll hear narration.

## What It Does

Claude Code Narrator hooks into Claude Code's **PreToolUse** hook system. Before every tool execution, it:

1. Reads the tool name and parameters
2. Generates a short, natural-language description
3. Speaks it aloud (macOS TTS or ElevenLabs)
4. Passes the original data through unchanged (never interferes with Claude Code)

### Before vs After

| Without Narrator | With Narrator |
|---|---|
| `Read { file_path: "/Users/me/project/backend/app/services/auth_service.py" }` | *"Reading the auth service"* |
| `Bash { command: "git status" }` | *"Checking git status"* |
| `Edit { file_path: "src/components/Button.tsx" }` | *"Editing Button"* |
| `Bash { command: "npm run test" }` | *"Running tests"* |
| `Bash { command: "rm -rf dist/" }` | **[alert sound]** *"Deleting files"* |
| `Grep { pattern: "handleSubmit" }` | *"Searching for handleSubmit"* |

## Voice Options

### Option 1: macOS Premium Voices (free, recommended starting point)

The default macOS voices are decent, but the **Premium** voices are a significant upgrade — much more natural intonation and less robotic.

**To download premium voices:**

1. Open **System Settings** > **Accessibility** > **Spoken Content**
2. Click **System Voice** dropdown > **Manage Voices...**
3. Download any voice marked **(Premium)** — e.g., **Samantha (Premium)**, **Tom (Premium)**, **Zoe (Premium)**
4. Update `~/.claude/narrator.json`: `"voice": "Samantha (Premium)"`

**Best premium voices for narration:**
- **Samantha (Premium)** — warm, natural American English (default)
- **Tom (Premium)** — clear, natural American male
- **Zoe (Premium)** — lively, great for casual tone
- **Daniel (Premium)** — British English, professional

Test any voice: `say -v "Samantha (Premium)" "Reading the auth service"`

List all installed voices: `say -v "?"`

### Option 2: ElevenLabs (human-quality, optional)

For truly human-sounding narration, enable [ElevenLabs](https://elevenlabs.io) TTS. Adds ~500ms latency on first use of each phrase, but results are cached permanently so repeated narrations are instant.

```json
{
  "tts": "elevenlabs",
  "elevenlabs": {
    "apiKey": "your-api-key-here",
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "model": "eleven_turbo_v2_5"
  }
}
```

Or set the env var `ELEVENLABS_API_KEY` instead of putting the key in the config file.

**How it works:**
- First time a phrase is spoken → API call (~500ms), audio cached to `~/.claude/narrator-cache/`
- Same phrase again → plays from cache instantly (~14ms)
- Cache persists across sessions (7-day TTL)
- Falls back to macOS `say` if the API is unreachable

**Popular ElevenLabs voices:**
| Voice | ID | Style |
|---|---|---|
| Sarah | `EXAVITQu4vr4xnSDxMaL` | Warm, natural (default) |
| Charlie | `IKne3meq5aSn9XLyUdCD` | Casual, friendly |
| Emily | `LcfcDJNUP1GQjkzn1xUU` | Clear, professional |
| James | `ZQe5CZNOzWyzPSCn5a3c` | Authoritative |

Browse all voices at [elevenlabs.io/voice-library](https://elevenlabs.io/voice-library).

## Features

### Smart Narration
Uses Claude Code's own description fields when available. Falls back to ~40 pattern templates for common tools and commands. Transforms raw file paths into friendly names:
- `/Users/me/project/frontend/app/(dashboard)/admin/courses/[id]/page.tsx` becomes **"the course detail page"**
- `/backend/app/services/auth_service.py` becomes **"the auth service"**

### Repetition Suppression
Reading 10 files in a row? The narrator adapts:
- 1st-2nd: Full narration (*"Reading the auth service"*, *"Reading the user model"*)
- 3rd: Batch summary (*"Reading several files"*)
- 4th+: Silence (no audio clutter)

Resets when the tool type changes or after a 10-second gap.

### Destructive Action Alerts
High-risk commands trigger an alert sound before narration:
- `rm -rf`, `git push --force`, `git reset --hard`
- `DROP TABLE`, `DELETE FROM`, `sudo rm`
- `docker system prune`

The alert sound plays first, then the narration speaks at a slower rate.

### Context Awareness
Tracks your last 15 actions. When you've been working in the same area (e.g., authentication files), adds context: *"Working on authentication. Editing the auth service"*

### Volume Control
Audio files are played through `afplay --volume` for precise volume control. Cached by content hash for instant playback on repeated narrations.

### Zero Dependencies
No `npm install`. No `package.json`. Pure Node.js 18+ stdlib. One file. Runs anywhere Node exists.

## Configuration

Edit `~/.claude/narrator.json`:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch |
| `tts` | `"say"` | TTS engine: `"say"` (macOS) or `"elevenlabs"` |
| `voice` | `"Samantha"` | macOS TTS voice name |
| `rate` | `210` | Words per minute for macOS `say` (150-300) |
| `volume` | `0.5` | Playback volume (0.0-1.0) |
| `elevenlabs` | `null` | ElevenLabs config: `{ apiKey, voiceId?, model? }` |
| `narrateTools` | `["Bash","Edit","Write","Read","Grep","Glob","Agent"]` | Tools to narrate |
| `skipTools` | `[]` | Tools to always skip |
| `maxContextItems` | `15` | Recent actions to track for context |
| `repetitionThreshold` | `3` | Same-tool count before batching/silencing |
| `destructiveAlertSound` | `/System/Library/Sounds/Basso.aiff` | Alert sound file path |

## Quick Toggle

### Terminal aliases (installed automatically)

```bash
narrator-mute      # Silence — creates ~/.claude/narrator-muted
narrator-unmute    # Resume — removes the mute file
narrator-test      # Play a test narration
```

### Claude Code slash commands (installed automatically)

```
/narrator-mute     # Mute from within Claude Code
/narrator-unmute   # Unmute from within Claude Code
/narrator-voice    # Change voice (e.g., /narrator-voice Samantha)
```

## How It Works

```
Claude Code action
       |
       v
PreToolUse hook fires
       |
       v
narrator.js reads JSON from stdin
       |
       +-- Muted? -> exit immediately (~1ms)
       |
       +-- Generate narration text
       |   +-- 1st: Use description field (if non-generic)
       |   +-- 2nd: Match against ~40 templates
       |   +-- 3rd: Fallback "Using {tool}"
       |
       +-- Repetition check
       |   +-- 1st-2nd: speak full narration
       |   +-- 3rd: speak batch summary
       |   +-- 4th+: silent
       |
       +-- Destructive? -> play alert sound first
       |
       +-- Speak via say/ElevenLabs + afplay
       |
       +-- Output original JSON to stdout (passthrough)
              |
              v
       Claude Code continues normally
```

The narrator **never** modifies, blocks, or interferes with Claude Code. If anything fails, it silently exits after passing through the original input.

## Uninstall

```bash
cd claude-narrator
./uninstall.sh
```

This removes:
- The narrator script from `~/.claude/scripts/`
- The PreToolUse hook from `~/.claude/settings.json`
- Slash commands from `~/.claude/commands/`
- Shell aliases from your rc file
- Temp files from `/tmp/`
- Optionally: the config file and ElevenLabs cache

## Platform Support

| Platform | Status |
|---|---|
| macOS | Fully supported (native `say` + `afplay`, optional ElevenLabs) |
| Linux | Planned — `espeak`/`festival` fallback (PRs welcome) |
| Windows | Planned — PowerShell `System.Speech` (PRs welcome) |

## Contributing

PRs welcome! Some ideas:
- **Linux support** via `espeak-ng` or `festival`
- **Windows support** via PowerShell speech synthesis
- **More templates** for additional CLI tools
- **Custom sound themes** for different action types
- **OpenAI TTS support** as another engine option

## License

MIT
