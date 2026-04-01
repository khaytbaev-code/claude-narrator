---
name: narrator-voice
description: Change the narrator voice (e.g., /narrator-voice af_sky)
---

This command is a shortcut for `/narrator-config voice`.

If the user provided a voice name, update the voice in `~/.claude/narrator.json`:
- Read the config file first to check the current `tts` engine
- If engine is `mlx`: update `mlx.voice` to the provided name
- If engine is `say`: update `voice` to the provided name
- If engine is `elevenlabs`: update `elevenlabs.voiceId` to the provided name

If no voice name was provided, list available voices based on the current TTS engine:

**If engine is `mlx` (Kokoro voices):**

American Female: af_bella (warm), af_sky (casual), af_heart (expressive), af_nova (energetic), af_nicole (smooth), af_sarah (clear), af_jessica (conversational), af_alloy (balanced), af_river (calm), af_kore (crisp)

American Male: am_adam (warm), am_michael (confident), am_eric (friendly), am_liam (clear), am_echo (smooth), am_onyx (rich), am_puck (playful), am_fenrir (bold)

British Female: bf_emma (polished), bf_lily (gentle), bf_isabella (elegant), bf_alice (crisp)

British Male: bm_daniel (classic), bm_george (authoritative), bm_lewis (conversational), bm_fable (storyteller)

**If engine is `say`:** List Daniel, Samantha, Karen, Moira, Alex, Fred. Mention `say -v "?"` for full list.

After updating, confirm: "Voice changed to **{voice}**. Takes effect on the next action."

For more settings, suggest: "Use `/narrator-config` to see all narrator settings."
