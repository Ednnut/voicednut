
TASK: Fix Telegram call status flow, live updates, and UI polish. Let each real-status updates message be sequential not using one post-card. 

Problem
The Telegram bot stops updating after “Initiating call…”.
Users do not see:
	•	ringing
	•	answered
	•	in-progress
	•	completed / failed states

Additionally:
	•	emojis in status messages are missing or inconsistent
	•	call status messages are verbose, duplicated, and poorly formatted
	•	users cannot clearly tell whether a call is live, ringing, answered, or ended

This makes the system feel broken even when the call is active.

⸻

1. Fix call status propagation (CRITICAL)

API
	•	Ensure Twilio call lifecycle events are fully handled and mapped:
	•	initiated
	•	ringing
	•	answered
	•	in-progress
	•	completed
	•	busy
	•	no-answer
	•	failed
	•	These events must reliably emit internal call status updates.
	•	Ensure webhook handlers do not early-return or silently fail.
	•	Ensure call status updates are idempotent and ordered.

⸻

2. Live Telegram status updates (edited-in-place)

Bot behavior
	•	Use ONE Telegram message per call as the “Call Status Card”
	•	Update it using editMessageText on every call state change
	•	Never stop at “Initiating…”

Required status flow

⏳ Call queued
📞 Ringing…
🟢 Call answered
🎙 Caller speaking
🤖 Agent responding
🔴 Call ended

	•	Status must update in real time
	•	Do not send new messages for status changes
	•	Message must continue updating until terminal state

⸻

3. Fix emoji rendering and consistency
	•	Use standard Telegram-safe emojis only
	•	Ensure emojis are part of the actual message text, not logs
	•	Every status line must include a leading emoji

Example:

📞 Call Status: Ringing…
⏱ Duration: 00:12


⸻

4. Redesign call status message UI (polish)

Replace verbose multi-message spam with a single concise card

BEFORE (bad)
	•	Multiple messages
	•	Raw text
	•	No hierarchy
	•	No visual status clarity

AFTER (required format)

📞 Outbound Call

👤 Client: Gary
📱 Number: +16124594733
📄 Template: PayPal OTP

🟢 Status: Ringing…
⏱ Duration: 00:18

	•	Use Markdown
	•	Clear sections
	•	Minimal text
	•	Emojis for scannability
	•	Status line must visibly change

⸻

5. Ensure live → post-call transition works
	•	When call ends:
	•	Update same message to terminal state
	•	Do NOT leave it stuck on “Initiating” or “Queued”
	•	Example final state:

🔴 Call Ended

⏱ Duration: 3m 42s
📌 Outcome: Transferred
😐 → 😠 Sentiment


⸻

6. Add defensive logging (for debugging only)
	•	Log every received Twilio status event
	•	Log every Telegram edit attempt
	•	Log failures explicitly (do not swallow errors)

⸻

Acceptance criteria
	•	Telegram always reflects real call state
	•	Status never freezes
	•	Emojis always appear
	•	UI looks clean, compact, and professional
	•	One message per call, edited live

⸻

Do NOT:
	•	Introduce new features
	•	Change call logic
	•	Spam Telegram with new messages
	•	Remove existing functionalit
