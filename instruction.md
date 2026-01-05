Here is the complete instruction.md content you can copy directly into a file named instruction.md and commit/use as-is for Codex or any agent.

⸻


# Telegram Live Call Console Enhancement

## Objective
Implement a **Telegram Live Call Console** that acts as a real-time dashboard for calls, while **preserving existing real-time status messages** (Initiating / Ringing / In-progress / Completed).  
The console must be **one edited message per call**, visually polished, and only show **user/agent live events after the call is picked up**.

> ⚠️ The `queued` status must NOT be displayed anywhere.

---

## Hard Rules
- Do **not** send or display `queued` status (no message, no console update).
- Existing separate status messages must continue working unchanged.
- Exactly **one Live Call Console message per call**, updated via `editMessageText`.
- Live speech/activity events appear **only after pickup** (`answered` / `in-progress`).
- Console must always reach a terminal state (never stuck on ringing).

---

## 1. Live Call Console Creation
Create the Live Call Console message when:
- Outbound call is created OR
- Twilio call status becomes `initiated` (preferred)

Do NOT create console on `queued`.

Store mapping:
```ts
liveConsoleByCallSid[callSid] = {
  chatId,
  messageId,
  createdAt,
  lastEditAt,
  pickedUpAt,
  status,
  phase,
  lastEvents: [],
  previewTurns: []
}

All future updates must use editMessageText on this message.

⸻

2. Twilio Call Status Mapping (NO QUEUED)

Console status mapping

Twilio status	Console status
initiated	📡 Initiated
ringing	🔔 Ringing…
answered / in-progress	🟢 In call
completed	🔴 Ended: Completed
no-answer	🔴 Ended: No answer
busy	🔴 Ended: Busy
failed	🔴 Ended: Failed
canceled	🔴 Ended: Canceled

When status becomes answered / in-progress:
	•	Set pickedUpAt = now
	•	Default phase to 🎙 Listening…

Existing messages
	•	Continue sending existing Telegram messages:
	•	Initiating
	•	Ringing
	•	In progress
	•	Terminal statuses
	•	Do not send queued message

⸻

3. Live Events (ONLY After Pickup)

Do not display speech or AI events until pickedUpAt is set.

Audio / Agent pipeline → Phase + Events

Event	Phase	Event line
STT interim / utterance start	🎙 User speaking…	🎙 User speaking…
STT final transcript	🧠 Thinking…	—
GPT response start	🤖 Agent responding…	🤖 Agent responding…
TTS/audio streaming	🔊 Agent speaking…	🔊 Agent speaking…
User interrupt	✋ Interrupted	✋ Interrupted
Tool invocation	—	🔄 Tool: <toolName>
Sentiment drop	—	⚠️ Sentiment drop detected

Maintain lastEvents[]:
	•	Max 5 entries
	•	Drop oldest when exceeding limit
	•	Only add events after pickup

⸻

4. Rolling Transcript Preview (Collapsed)

Inside the console, display only the most recent turns:
	•	Max 2 turns (or 4 lines total)
	•	Format:

🧑 User: ...
🤖 Agent: ...



Rules:
	•	Update preview only on:
	•	STT final transcript
	•	Agent reply
	•	Truncate each line to 180–220 chars with …
	•	Never dump full transcript into console

⸻

5. Edit Throttling & Reliability
	•	Debounce edits per call: max 1 edit per 900ms
	•	Bypass debounce for:
	•	Terminal statuses
	•	Errors / tool failures
	•	On editMessageText failure:
	•	Log error explicitly
	•	Include callSid, messageId, Telegram error

⸻

6. UI Design (Markdown Card)

The console message must always render as:

📞 Outbound Call
👤 Customer: <name | Unknown>
📱 Number: <e164>
🧩 Template: <template>

Status: <emoji + text>
Phase: <emoji + text>
Elapsed: <mm:ss>

Recent
- <event1>
- <event2>
- <event3>
- <event4>
- <event5>

Preview
🧑 <last user line>
🤖 <last agent line>

UI constraints:
	•	Compact and scannable
	•	Consistent emojis
	•	No long paragraphs
	•	Status / Phase / Elapsed always visible

⸻

7. End-of-Call Behavior

On terminal status:
	•	Update console with:
	•	🔴 Ended + reason
	•	Final elapsed time
	•	Phase set to —
	•	Existing terminal status messages remain unchanged

Example:

🔴 Ended: No answer
Elapsed: 01:15


⸻

8. Wiring Points

Wire console updates from:
	•	Twilio call-status webhook handler
	•	STT utterance + STT final transcript handlers
	•	GPT response start hook
	•	TTS streaming start hook
	•	Interrupt handling
	•	Tool invocation hooks
	•	Sentiment alert hook (if available)

⸻

Acceptance Criteria
	•	No queued status displayed anywhere
	•	Existing status messages still sent
	•	Exactly one Live Call Console per call
	•	Live events only after pickup
	•	Terminal state always shown
	•	UI is clean, compact, and professional

---

If you want next:
- a **second file** (`ui_examples.md`) with visual mockups  
- or a **file-by-file implementation checklist** (`status.js`, `app.js`, `stream.js`, `gpt.js`)  

just tell me.
