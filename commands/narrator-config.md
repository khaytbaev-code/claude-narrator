---
name: narrator-config
description: Configure the Claude Code narrator — voice, speed, volume, engine, Jarvis, tools, and more
---

You are configuring the Claude Code narrator. The config file is `~/.claude/narrator.json`.

Read `~/.claude/narrator.json` first to see the current state, then handle the user's subcommand.

## Subcommands

Parse the user's arguments after `/narrator-config`. The format is `/narrator-config <subcommand> [value]`.

### No arguments — show current config

Display the current config as a readable table with these sections:
- **TTS Engine**: engine (mlx/say/elevenlabs), voice, speed, volume
- **Jarvis (Gemini)**: enabled/disabled, model, personality
- **Behavior**: narrateTools list, failures on/off, stop narration on/off, repetition threshold
- **Session Voices**: list each session's voice assignment

Then show a quick reference of all subcommands.

### `voice [name]` — change voice

If no name given, list available voices based on the current TTS engine:

**If engine is `mlx` (Kokoro voices):**

American Female:
- **af_bella** — warm, friendly
- **af_sky** — light, casual
- **af_heart** — expressive, sweet
- **af_nova** — bright, energetic
- **af_nicole** — smooth, professional
- **af_sarah** — clear, neutral
- **af_jessica** — conversational
- **af_alloy** — balanced
- **af_river** — calm, steady
- **af_kore** — crisp

American Male:
- **am_adam** — warm, deep
- **am_michael** — confident
- **am_eric** — friendly
- **am_liam** — clear
- **am_echo** — smooth
- **am_onyx** — rich
- **am_puck** — playful
- **am_fenrir** — bold

British Female:
- **bf_emma** — warm, polished
- **bf_lily** — soft, gentle
- **bf_isabella** — elegant
- **bf_alice** — crisp

British Male:
- **bm_daniel** — classic British
- **bm_george** — authoritative
- **bm_lewis** — conversational
- **bm_fable** — storyteller

If a name is given, update `mlx.voice` in the config.

**If engine is `say`:**
List popular macOS voices: Daniel, Samantha, Karen, Moira, Alex, Fred. Mention `say -v "?"` for full list. Update the `voice` field.

**If engine is `elevenlabs`:**
Tell the user to find their voice ID on elevenlabs.io and use `/narrator-config elevenlabs voice <id>`. Update `elevenlabs.voiceId`.

After updating, confirm: "Voice changed to **{voice}**. Takes effect on the next action."

### `speed <value>` — change TTS speed

Value should be a number (e.g., 0.8, 1.0, 1.2, 1.5). Reasonable range: 0.5–2.0.

- If engine is `mlx`: update `mlx.speed`
- If engine is `say`: update `rate` (convert: speed 1.0 = rate 210, so rate = round(speed * 210))
- If engine is `elevenlabs`: note that ElevenLabs speed is controlled server-side and not currently configurable

Confirm: "Speed changed to **{value}**."

### `volume <value>` — change playback volume

Value should be a float 0.0–1.0. Update the `volume` field.

Confirm: "Volume changed to **{value}**."

### `engine <mlx|say|elevenlabs>` — switch TTS engine

Update the `tts` field. Validate the value is one of: `mlx`, `say`, `elevenlabs`.

- If switching to `elevenlabs`, check if `elevenlabs.apiKey` is set or `ELEVENLABS_API_KEY` env var exists. Warn if not.
- If switching to `mlx`, note it requires Apple Silicon.

Confirm: "TTS engine switched to **{engine}**."

### `jarvis <on|off>` — toggle Gemini milestone narration

Update `jarvis.enabled` to `true` or `false`.

- If turning on, check if `jarvis.apiKey` is set or `GEMINI_API_KEY` env var exists. Warn if not and suggest `/narrator-config jarvis key <key>`.

Confirm: "Jarvis narration **{on/off}**."

### `jarvis key <api-key>` — set Gemini API key

Update `jarvis.apiKey`. Also set `jarvis.enabled` to `true`.

Confirm: "Gemini API key set. Jarvis narration enabled."

### `jarvis model <model-name>` — set Gemini model

Update `jarvis.model`. Default is `gemini-2.5-flash-lite`.

Confirm: "Jarvis model changed to **{model}**."

### `jarvis personality <warm|professional|playful|terse>` — set narration personality

Update `jarvis.personality`.

Confirm: "Jarvis personality set to **{personality}**."

### `elevenlabs key <api-key>` — set ElevenLabs API key

Update `elevenlabs.apiKey` (create the `elevenlabs` object if it doesn't exist). Also switch `tts` to `elevenlabs`.

Confirm: "ElevenLabs API key set. TTS engine switched to elevenlabs."

### `elevenlabs voice <voice-id>` — set ElevenLabs voice ID

Update `elevenlabs.voiceId`.

Confirm: "ElevenLabs voice ID changed to **{voice-id}**."

### `elevenlabs model <model-name>` — set ElevenLabs model

Update `elevenlabs.model`. Default is `eleven_turbo_v2_5`.

Confirm: "ElevenLabs model changed to **{model}**."

### `tools` — show narrated tools list

Display the current `narrateTools` and `skipTools` arrays.

### `tools add <tool>` — add a tool to narrate

Add the tool name to `narrateTools` if not already present. Remove from `skipTools` if present.

Confirm: "**{tool}** will now be narrated."

### `tools remove <tool>` — stop narrating a tool

Remove the tool name from `narrateTools`. Optionally add to `skipTools`.

Confirm: "**{tool}** will no longer be narrated."

### `failures <on|off>` — toggle failure narration

Update `narrateFailures` to `true` or `false`.

Confirm: "Failure narration **{on/off}**."

### `stop <on|off>` — toggle turn-completion narration

Update `narrateStop` to `true` or `false`.

Confirm: "Turn-completion narration **{on/off}**."

### `reset` — reset to defaults

Replace `~/.claude/narrator.json` with the default config. Ask for confirmation before proceeding.

Default config:
```json
{
  "enabled": true,
  "voice": "Samantha",
  "rate": 210,
  "volume": 0.5,
  "tts": "mlx",
  "narrateTools": ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"],
  "skipTools": [],
  "maxContextItems": 15,
  "repetitionThreshold": 3,
  "destructiveAlertSound": "/System/Library/Sounds/Basso.aiff",
  "mlx": {
    "model": "mlx-community/Kokoro-82M-bf16",
    "voice": "af_heart",
    "speed": 1
  },
  "jarvis": {
    "enabled": false,
    "apiKey": "",
    "model": "gemini-2.5-flash-lite",
    "personality": "warm",
    "timeoutMs": 2000
  },
  "sessionVoices": [
    { "voice": "Daniel (Enhanced)", "mlxVoice": "am_adam", "rate": 200 },
    { "voice": "Karen (Enhanced)", "mlxVoice": "bf_emma", "rate": 205 },
    { "voice": "Tessa (Enhanced)", "mlxVoice": "am_michael", "rate": 200 }
  ],
  "narrateFailures": true,
  "narrateStop": true
}
```

Confirm: "Narrator config reset to defaults."

## Important Rules

1. Always read `~/.claude/narrator.json` before making changes
2. Use the Edit tool to modify specific fields — do not rewrite the entire file
3. Preserve any fields not being changed
4. Validate values before writing (e.g., volume 0.0-1.0, speed 0.5-2.0)
5. All changes take effect on the next tool call — no restart needed
