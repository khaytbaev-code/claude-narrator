---
name: narrator-voice
description: Change the narrator voice (e.g., /narrator-voice Samantha)
---

Update the "voice" field in `~/.claude/narrator.json` to the voice name provided by the user.

If no voice name was provided, list these popular macOS voices:
- **Daniel** (British English, default) — clear and professional
- **Samantha** (American English) — warm and friendly
- **Karen** (Australian English) — crisp and articulate
- **Moira** (Irish English) — soft and pleasant
- **Alex** (American English) — natural male voice
- **Fred** (American English) — classic robotic voice

Tell the user they can run `say -v "?"` in their terminal to see all available voices.

After updating, confirm: "Narrator voice changed to {voice}. It will take effect on the next action."
