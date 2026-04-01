# Jarvis Mode — Two-Tier Narration with Gemini API & mlx-audio TTS

**Date:** 2026-03-31
**Status:** Draft
**Author:** Human + Claude

## Problem

Claude Code Narrator speaks tool intentions but sounds robotic and repetitive. Every narration uses the same template ("Can I read auth service?"), has no awareness of context or outcomes, and uses macOS `say` which sounds mechanical. Users want a warm, Jarvis-like voice companion that understands what's happening and reacts naturally.

## Solution

Evolve the narrator into a two-tier system:

1. **Fast Tier** — Enhanced smart templates for per-tool narrations. No API call, ~0ms latency. Richer phrasing, pattern detection, warm transitions.
2. **Rich Tier** — Gemini 2.5 Flash-Lite API generates context-aware narration at milestone events. ~0.3s latency, falls back to fast tier on timeout.

Add **mlx-audio** (Kokoro) as an optional local neural voice engine for natural-sounding speech on Apple Silicon, without cloud dependency.

## Non-Goals

- mlx-audio is not bundled — it's an optional `pip install` (Apple Silicon only)
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

PostToolUse hook --> narrator.js --post
                      |
                      +-- Success (test/build) --> Rich Tier: "Nice, tests pass"
                      +-- Failure --> Rich Tier with error context
                      +-- Gemini timeout --> Fast tier fallback
```

### Passthrough guarantee preserved

stdin JSON is always written to stdout unchanged, even if Gemini API fails, mlx-audio crashes, or any other error occurs. The narrator never blocks Claude Code.

### Single file preserved

narrator.js stays as one file. No package.json, no npm dependencies.

## Fast Tier — Enhanced Smart Templates

### Richer phrasing pools

Each action gets 4-5 varied phrasings that rotate, replacing the current single template:

| Action | Current | Enhanced pool |
|--------|---------|---------------|
| Read file | "read a file" | "read", "peek at", "take a look at", "check out", "open up" |
| Run tests | "run the tests" | "run the tests", "kick off the test suite", "see if the tests pass", "check if that worked" |
| Edit file | "edit a file" | "edit", "update", "make a change to", "tweak" |

The existing `askStyle()` prefix system applies on top, producing combinations like "Mind if I peek at auth service dot py?"

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

## mlx-audio — Local Neural Voice (Apple Silicon)

### What is mlx-audio

[mlx-audio](https://github.com/Blaizzy/mlx-audio) is a high-quality local TTS engine built on Apple's MLX framework. It runs natively on Apple Silicon (M1+) and supports 54 Kokoro voices with natural-sounding speech. Install via `pip install mlx-audio` or `uv tool install mlx-audio`.

- **6,500+ GitHub stars**, very actively maintained
- **Kokoro model**: 82M parameters, 54 voices, fast inference
- **Streaming support**: `--stream` flag for real-time playback during generation
- **CLI**: `mlx_audio.tts.generate --model mlx-community/Kokoro-82M-bf16 --text 'Hello' --voice af_heart`
- **Requirement**: Apple Silicon Mac (M1/M2/M3/M4). Does NOT work on Intel Macs.

### Voice strategy

| Config value | Engine | Use case |
|-------------|--------|----------|
| `"say"` (default) | macOS built-in | Zero setup, works out of box, any Mac |
| `"mlx"` | mlx-audio Kokoro | High-quality local neural voice, Apple Silicon only |
| `"elevenlabs"` | ElevenLabs cloud | Premium quality, costs money per call |

### Installation

mlx-audio is optional. `install.sh` offers to install it:

```
install.sh:
  Detects Apple Silicon (uname -m == arm64)
  → "Want high-quality local voice? I can install mlx-audio (~200MB first run for model). [y/N]"
  → Runs: pip install mlx-audio (or uv pip install mlx-audio)
  → First TTS call auto-downloads Kokoro model from HuggingFace to ~/.cache/huggingface/
  → Sets tts: "mlx" in narrator.json
  → Falls back to "say" on Intel Macs or if install fails
```

If user declines, is on Intel, or mlx-audio is unavailable, macOS `say` works as before.

### speakWithMlx implementation

```
function speakWithMlx(text, config, isDestructiveAction, sessionNum):
  1. Hash text for cache key (same pattern as say/elevenlabs)
  2. Generate WAV via execSync (NOT shell pipe — text passed as argument with escaping):
     execSync(`python3 -m mlx_audio.tts.generate --model "${model}" --text "${escaped}" --voice "${voice}" --output "${tmpFile}"`,
       { timeout: 5000, stdio: 'ignore' });
     // First call may be slow (~2-3s) as model loads; subsequent calls use cached model (~200-500ms)
  3. Play via playFile() (same kill-and-replace, same session scoping)
  4. On any error: fall back to speakWithSay()
```

Temp files follow the same pattern: `/tmp/claude-narrator-sess{N}-{hash}.wav`

### Multi-session voice support

Kokoro has 54 built-in voices selectable by name (e.g., `af_heart`, `am_adam`, `bf_emma`). Multi-session voice differentiation works naturally — each session gets a different `voice` parameter from the config:

```json
{
  "sessionVoices": [
    { "voice": "af_heart", "mlxVoice": "am_adam" },
    { "voice": "Daniel (Enhanced)", "mlxVoice": "bf_emma" },
    { "voice": "Karen (Enhanced)", "mlxVoice": "am_michael" }
  ]
}
```

Session 0 uses `mlx.voice` (default). Sessions 1+ use `sessionVoices[n].mlxVoice`. Falls back to macOS `say` with the `voice` field if mlx is unavailable.

### mlx-audio config

```json
{
  "tts": "mlx",
  "mlx": {
    "model": "mlx-community/Kokoro-82M-bf16",
    "voice": "af_heart",
    "speed": 1.0
  }
}
```

## Config Additions

All new fields are optional with backward-compatible defaults:

```json
{
  "tts": "say",
  "jarvis": {
    "enabled": false,
    "apiKey": "",
    "model": "gemini-2.5-flash-lite",
    "personality": "warm",
    "timeoutMs": 2000
  },
  "mlx": {
    "model": "mlx-community/Kokoro-82M-bf16",
    "voice": "af_heart",
    "speed": 1.0
  }
}
```

- `jarvis.enabled: false` by default — must opt in with API key
- `jarvis.model` — configurable so users can update the model ID if the default alias changes or a newer model is released. Verify exact model ID against [Gemini API docs](https://ai.google.dev/gemini-api/docs/models) before shipping — dated preview IDs (e.g., `gemini-2.5-flash-lite-preview-06-17`) may be needed if the short alias isn't live yet.
- `jarvis.personality` — reserved for future use (warm/dry/witty), currently only "warm"
- `mlx` — only read if `tts: "mlx"`. Requires Apple Silicon Mac and `pip install mlx-audio`

## File Changes

| File | Change |
|------|--------|
| `narrator.js` | Rich phrasing pools, pattern detector, warm connectors, milestone detector, Gemini API client, speakWithMlx, mainPost() upgrade, config additions |
| `narrator.json` | Add `jarvis` and `mlx` default config sections |
| `install.sh` | Offer mlx-audio install (Apple Silicon only), prompt for Gemini API key, write new config sections |
| `uninstall.sh` | Offer to uninstall mlx-audio pip package |
| `CLAUDE.md` | Document Jarvis mode, mlx-audio TTS, new config fields |

### Estimated size

- narrator.js: ~780 lines -> ~1050 lines (budget raised to 1100; use shared helpers and lookup tables to compress where possible)
- No new files (mlx-audio installed via pip, Kokoro model auto-downloaded to HuggingFace cache)

## Breaking Changes

None. Every new feature is behind config flags:

- No `jarvis.apiKey` set -> Rich Tier disabled, fast tier only
- `tts: "say"` (default) -> macOS say as before
- Existing installs work identically without any config changes

## Implementation Notes

- `cleanupOldTempFiles()` must be extended to also match `.wav` files (mlx-audio output). Simplest fix: check `f.startsWith(TMP_PREFIX)` without extension filter, since both `.aiff` and `.wav` share the prefix.
- `inferArea()` contains hardcoded domain terms from a specific project. Should be generalized to derive context from path components. Tracked as a separate cleanup — not blocking for Jarvis Mode.

## Testing Plan

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

### mlx-audio TTS
- Verify speakWithMlx generates WAV and plays via afplay
- Verify fallback to say when mlx-audio not installed or on Intel Mac
- Verify session-scoped temp file naming for kill-and-replace
- Verify multi-session voice assignment (different Kokoro voices per session)
- Verify install.sh mlx-audio install flow (accept/decline, Apple Silicon check)
- Verify first-run model download completes before TTS attempt

### Integration
- Full session: verify fast + rich narrations interleave correctly
- Multi-session: verify each session uses its own Kokoro voice with mlx
- Mute/unmute: verify both tiers respect mute file
- Config migration: verify existing narrator.json without new fields works
