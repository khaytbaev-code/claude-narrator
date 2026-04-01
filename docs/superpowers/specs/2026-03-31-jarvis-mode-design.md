# Jarvis Mode — Two-Tier Narration with Gemini API & mlx-audio

**Date:** 2026-03-31
**Status:** Draft
**Author:** Human + Claude

## Problem

Claude Code Narrator speaks tool intentions but sounds robotic and repetitive. Every narration uses the same template ("Can I read auth service?"), has no awareness of context or outcomes, and uses macOS `say` which sounds mechanical. Users want a warm, Jarvis-like voice companion that understands what's happening and reacts naturally.

## Solution

Rebuild the narrator around **mlx-audio** (Kokoro) as the primary voice engine, with a two-tier narration system:

1. **Fast Tier** — Enhanced smart templates for per-tool narrations. No API call, ~0ms text generation. Spoken via mlx-audio Kokoro voices.
2. **Rich Tier** — Gemini 2.5 Flash-Lite API generates context-aware narration at milestone events. ~0.3s latency, falls back to fast tier on timeout. Spoken via mlx-audio.

**mlx-audio is the default TTS engine.** macOS `say` becomes the fallback for Intel Macs or if mlx-audio fails. The entire voice experience — session voices, speed control, warm tone — is built on Kokoro's 54 voices.

## Prerequisites

- **Apple Silicon Mac** (M1/M2/M3/M4) — required for mlx-audio
- **Python 3.9+** — required for `pip install mlx-audio`
- **~200MB disk** — Kokoro model auto-downloads on first use to `~/.cache/huggingface/`
- Intel Mac users get macOS `say` fallback (functional but not the Jarvis experience)

## Non-Goals

- No streaming/real-time voice (Gemini Live) — overkill for short narrations
- No conversation with the narrator — it's one-way commentary
- No changes to the passthrough guarantee or hook contract

## Architecture

```
PreToolUse hook --> narrator.js
                      |
                      +-- Fast Tier (templates, no API)
                      |     Per-tool narrations with enriched phrasing
                      |     Pattern detection from tool history
                      |     Warm connectors on tool-type transitions
                      |
                      +-- Rich Tier (Gemini API, milestones only)
                            Task transitions, failure reactions,
                            completion summaries, debugging loop detection
                      |
                      v
                  TTS Engine
                      |
                      +-- mlx-audio Kokoro (default, Apple Silicon)
                      |     54 voices, natural speech, ~200-500ms
                      |     Per-session voice assignment
                      |
                      +-- macOS say (fallback)
                      |     Intel Macs, mlx-audio errors
                      |
                      +-- ElevenLabs (optional premium)

PostToolUse hook --> narrator.js --post
                      |
                      +-- Success (test/build) --> Rich Tier: "Nice, tests pass"
                      +-- Failure --> Rich Tier with error context
                      +-- Gemini timeout --> Fast tier fallback
                      v
                  TTS Engine (same as above)
```

### Passthrough guarantee preserved

stdin JSON is always written to stdout unchanged, even if Gemini API fails, mlx-audio crashes, or any other error occurs. The narrator never blocks Claude Code.

### Single file preserved

narrator.js stays as one file. No package.json, no npm dependencies. mlx-audio is a Python package installed alongside, invoked via `python3 -m`.

## mlx-audio — Primary Voice Engine

### What is mlx-audio

[mlx-audio](https://github.com/Blaizzy/mlx-audio) is a high-quality local TTS engine built on Apple's MLX framework. It runs natively on Apple Silicon (M1+) and supports 54 Kokoro voices with natural-sounding speech.

- **6,500+ GitHub stars**, very actively maintained
- **Kokoro model**: 82M parameters, 54 voices, fast inference
- **Streaming support**: `--stream` flag for real-time playback during generation
- **CLI**: `python3 -m mlx_audio.tts.generate --model mlx-community/Kokoro-82M-bf16 --text 'Hello' --voice af_heart`

### Default voices

| Session | Kokoro Voice | Character | macOS say fallback |
|---------|-------------|-----------|-------------------|
| 0 | `af_heart` | Warm female (primary Jarvis) | Samantha |
| 1 | `am_adam` | Calm male | Daniel (Enhanced) |
| 2 | `bf_emma` | Bright female | Karen (Enhanced) |
| 3 | `am_michael` | Confident male | Tessa (Enhanced) |

Each concurrent Claude Code session is immediately distinguishable by voice — same PPID-based detection as today, but now with high-quality neural voices instead of macOS `say` variants.

### Installation

mlx-audio is installed as part of the standard `install.sh` flow:

```
install.sh:
  1. Check Apple Silicon: uname -m == arm64
     → Intel: warn "mlx-audio requires Apple Silicon, using macOS say", set tts: "say"
  2. Check Python 3.9+: python3 --version
     → Missing: warn, set tts: "say"
  3. Install mlx-audio: pip install mlx-audio (or uv pip install mlx-audio if uv available)
     → Failure: warn, set tts: "say"
  4. Pre-download Kokoro model: python3 -c "from mlx_audio.tts import generate; ..."
     → Downloads ~200MB to ~/.cache/huggingface/ on first run
     → Failure: warn (will retry on first narration)
  5. Set tts: "mlx" in narrator.json
  6. Play test narration via mlx-audio: "Claude Code Narrator installed"
```

**No prompting.** On Apple Silicon, mlx-audio installs automatically. This is the core experience, not an add-on.

### speakWithMlx implementation

```
function speakWithMlx(text, config, isDestructiveAction, sessionNum):
  1. Determine voice from session config (session 0 = mlx.voice, session N = sessionVoices[N].mlxVoice)
  2. Determine speed (isDestructiveAction ? 0.85 : mlx.speed, per-session rate override)
  3. Hash (voice + speed + text) for cache key
  4. Check cache: if WAV exists at /tmp/claude-narrator-sess{N}-{hash}.wav, skip generation
  5. Generate WAV via execSync:
     execSync(`python3 -m mlx_audio.tts.generate --model "${model}" --text "${escaped}" --voice "${voice}" --speed ${speed} --output "${tmpFile}"`,
       { timeout: 5000, stdio: 'ignore' });
     // Text escaped via JSON.stringify to avoid shell injection
     // First call ~2-3s (model loading), subsequent ~200-500ms (cached model)
  6. Play via playFile() (kill-and-replace, session-scoped)
  7. On any error: fall back to speakWithSay() with same text
```

### Model caching behavior

- **First invocation per system boot**: ~2-3s (loads Kokoro model into memory)
- **Subsequent invocations**: ~200-500ms (model stays in OS page cache)
- **Audio file caching**: Same hash-based caching as today. Repeated phrases hit cache and skip generation entirely — only playFile() runs
- **Cache cleanup**: Same 5-min TTL for temp WAV files, 7-day TTL for ElevenLabs MP3s

### Fallback chain

```
speakWithMlx() fails
  → speakWithSay() (macOS built-in, always available)
    → silent (if say also fails — should never happen)
```

mlx-audio errors are caught silently. The user hears macOS `say` instead — degraded but functional. No error messages, no blocking.

## Fast Tier — Enhanced Smart Templates

### Richer phrasing pools

Each action gets 4-5 varied phrasings that rotate, replacing the current single template:

| Action | Current | Enhanced pool |
|--------|---------|---------------|
| Read file | "read a file" | "read", "peek at", "take a look at", "check out", "open up" |
| Run tests | "run the tests" | "run the tests", "kick off the test suite", "see if the tests pass", "check if that worked" |
| Edit file | "edit a file" | "edit", "update", "make a change to", "tweak" |

The existing `askStyle()` prefix system applies on top, producing combinations like "Mind if I peek at auth service dot py?" — now spoken in a natural Kokoro voice.

**Rotation mechanism:** Verb phrase selection uses a separate counter (`state.verbIndex`) stored in the per-session state file, independent from the prefix rotation counter (`prefixIndex`). This prevents correlated pairings. The counter wraps modulo pool size with last-used exclusion (skip if same as previous).

### Pattern detection

Lightweight checks on `state.recentActions` (already tracked, last 15 actions):

| Pattern | Detection | Narration modifier |
|---------|-----------|-------------------|
| Debugging loop | 3+ cycles of Read -> Edit -> Bash(test) where last Bash failed (exit code stored in state by PostToolUse) | "Let me try again..." / "One more attempt..." |
| Exploration | 4+ consecutive Reads | "Still looking..." / "Almost found it..." |
| Refactoring pass | 3+ consecutive Edits on related files | "Another one to update..." |
| Wrapping up | Edit followed by git commands | "Finishing up..." |

Pattern detection runs on every invocation but only modifies narration text — no side effects.

**Cross-hook state sharing:** The debugging loop pattern needs to know if the last Bash command failed. `mainPost()` stores `state.lastBashExitCode` in the per-session state file. `main()` reads it during pattern detection. The state file is already shared between both paths via `statePath(sessionNum)`.

### Warm connectors

On tool-type transitions (e.g., Read -> Edit, Edit -> Bash), prepend natural transition words:

- "OK, " / "Alright, " / "Right, " — on tool-type change
- "Now " / "Next, " — when moving to a different file area

These replace the current abrupt switches where every narration sounds equally weighted.

## Rich Tier — Gemini-Powered Milestone Narration

### Milestone events

| Milestone | Trigger | Example output |
|-----------|---------|----------------|
| Failure reaction | PostToolUse Bash, non-zero exit | "Hmm, looks like a null reference in the payment service" |
| Test/build success | PostToolUse Bash, test/build command, exit 0 | "Nice, tests are green" |
| Task transition | Tool type shifts after 3+ same-type actions | "Found what I needed, let me make the fix" |
| Completion summary | Git commit or 5+ edits followed by non-edit | "Wrapped up the auth refactor, four files updated" |
| Debugging loop | 3rd cycle of Read -> Edit -> Bash(test) | "Third attempt, trying a different angle" |

Estimated **5-15 API calls per session** — well within Gemini free tier (1,000/day).

### API contract

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent
Headers: x-goog-api-key: <key>

System instruction:
  "You are Jarvis, a warm and conversational voice assistant for a developer.
   Generate ONE short sentence (max 15 words) narrating what just happened
   or what is about to happen. Be warm but not silly. No emojis. No code.
   Written to be spoken aloud, so write for the ear, not the eye."

User message (per milestone):
  "Event: <milestone_type>
   Tool: <tool_name>
   Command: <command if Bash>
   Error snippet: <first 200 chars of stderr if failure>
   Recent context: <last 5 actions summary>"
```

### Execution model & fallback chain

**PreToolUse milestones (task transition, completion summary, debugging loop):**
The fast tier fires immediately (fire-and-forget, ~0ms). Gemini is called concurrently. If Gemini returns within 2s and audio hasn't started playing yet, the Gemini text replaces the fast tier text for speech. If Gemini is slow, the fast tier narration has already played — Gemini result is discarded. No audio silence gap.

**PostToolUse milestones (failure reaction, test/build success):**
These are retrospective events — 1-2s wait is tolerable. Gemini is called with `await` and a 2s timeout via `Promise.race`. On timeout or error, fall back to fast tier template ("Tests failed" / "That failed").

**No API key configured:** Rich Tier disabled entirely, fast tier only.

No retry logic. Fire once, use result or fall back. Simple.

### Cost analysis

- Gemini 2.5 Flash-Lite: $0.10 input / $0.40 output per million tokens
- Typical call: ~100 input tokens, ~30 output tokens
- Cost per call: ~$0.000022
- 15 calls/session: ~$0.00033/session
- Free tier: 1,000 requests/day, 15 RPM — covers normal usage entirely

## Config

### Default config (new installs on Apple Silicon)

```json
{
  "enabled": true,
  "tts": "mlx",
  "voice": "Samantha",
  "rate": 210,
  "volume": 0.5,
  "mlx": {
    "model": "mlx-community/Kokoro-82M-bf16",
    "voice": "af_heart",
    "speed": 1.0
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
  "narrateTools": ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"],
  "skipTools": [],
  "narrateFailures": true,
  "repetitionThreshold": 3,
  "destructiveAlertSound": "/System/Library/Sounds/Basso.aiff"
}
```

- `tts: "mlx"` — default on Apple Silicon. Falls back to `"say"` on Intel or if mlx-audio not installed
- `mlx.voice` — Kokoro voice for session 0. See [Kokoro voice list](https://huggingface.co/hexgrad/Kokoro-82M) for all 54 options
- `mlx.speed` — speech speed multiplier (0.5-2.0). Destructive actions auto-reduce to 0.85
- `sessionVoices[].mlxVoice` — Kokoro voice for each concurrent session
- `jarvis.enabled: false` — must opt in with Gemini API key
- `jarvis.model` — configurable so users can update the model ID. Verify exact model ID against [Gemini API docs](https://ai.google.dev/gemini-api/docs/models) before shipping — dated preview IDs may be needed if the short alias isn't live yet
- `jarvis.personality` — reserved for future use (warm/dry/witty), currently only "warm"
- `voice`, `rate` — macOS `say` settings, used as fallback when mlx unavailable

### Existing config migration

Existing `narrator.json` files without `mlx` or `jarvis` keys work unchanged — defaults are applied. If `tts` is not set, the installer sets it to `"mlx"` on Apple Silicon or leaves it as `"say"`.

## File Changes

| File | Change |
|------|--------|
| `narrator.js` | speakWithMlx, rich phrasing pools, pattern detector, warm connectors, milestone detector, Gemini API client, mainPost() upgrade, config additions |
| `narrator.json` | Default `tts: "mlx"`, add `mlx` and `jarvis` config sections, add `mlxVoice` to sessionVoices |
| `install.sh` | Auto-install mlx-audio on Apple Silicon, pre-download Kokoro model, prompt for Gemini API key, test narration via mlx-audio |
| `uninstall.sh` | Offer to uninstall mlx-audio pip package, note about HuggingFace cache |
| `CLAUDE.md` | Document Jarvis mode, mlx-audio as primary TTS, Gemini integration, new config fields |

### Estimated size

- narrator.js: ~780 lines -> ~1050 lines (budget: 1100; use shared helpers and lookup tables to compress)
- No new JS files (mlx-audio is a Python package, Kokoro model in HuggingFace cache)

## Breaking Changes

None. Every new feature has backward-compatible defaults:

- Existing installs with `tts: "say"` continue using macOS say
- No `jarvis.apiKey` set -> Rich Tier disabled, fast tier only
- No `mlx` config -> mlx defaults applied if `tts: "mlx"`
- `sessionVoices` entries without `mlxVoice` -> fall back to macOS `say` voice name

## Implementation Notes

- `cleanupOldTempFiles()` must be extended to also match `.wav` files (mlx-audio output). Simplest fix: check `f.startsWith(TMP_PREFIX)` without extension filter, since both `.aiff` and `.wav` share the prefix.
- `inferArea()` contains hardcoded domain terms from a specific project. Should be generalized to derive context from path components. Tracked as a separate cleanup — not blocking for Jarvis Mode.
- Text passed to mlx-audio CLI must be escaped via `JSON.stringify()` to prevent shell injection. Do not use template literals with unescaped user-derived text.
- First mlx-audio call per boot is slow (~2-3s). Consider a "warm-up" call during install or on first hook invocation with a very short text to prime the model cache.

## Testing Plan

### mlx-audio TTS (core)
- Verify speakWithMlx generates WAV and plays via afplay
- Verify all 4 default session voices produce distinct audio
- Verify speed parameter works (normal, destructive-slow)
- Verify fallback to say when mlx-audio not installed
- Verify fallback to say on Intel Mac (uname -m != arm64)
- Verify audio file caching (same text + voice + speed = cache hit)
- Verify session-scoped temp file naming for kill-and-replace
- Verify first-run model download completes before TTS attempt
- Verify install.sh auto-installs mlx-audio on Apple Silicon

### Fast Tier
- Verify phrasing rotation (no two consecutive identical phrasings)
- Verify pattern detection triggers on correct action sequences
- Verify warm connectors only appear on tool-type transitions
- Verify no regression on existing narration behavior

### Rich Tier
- Mock Gemini API: verify correct request format and response parsing
- Verify 2s timeout falls back to fast tier template
- Verify no API call when jarvis.enabled is false or no API key
- Verify milestone detection triggers on correct events
- Verify PostToolUse failure passes error context to Gemini

### Integration
- Full session: verify fast + rich narrations interleave correctly with mlx-audio voices
- Multi-session: verify each session uses its assigned Kokoro voice
- Mute/unmute: verify both tiers respect mute file
- Config migration: verify existing narrator.json without new fields works
- ElevenLabs: verify still works as alternative when tts: "elevenlabs"
