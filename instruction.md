# ============================================================
# VOICEDNUT BOT — CODEX TASK INSTRUCTIONS
# ============================================================
# This file contains ALL modifications Codex should apply.
# Codex MUST follow each instruction EXACTLY as written.
# Comments in this file (starting with #) are for Codex guidance.
# ============================================================


# ------------------------------------------------------------
# 1. REMOVE OLD “KEYPAD SUMMARY / GENERIC” MESSAGE BLOCKS
# ------------------------------------------------------------
# Find ANY code that builds messages like:
#
#   "⚠️ Keypad Summary"
#   "GENERIC:"
#   "Last updated"
#   "Dev compliance mode — raw digits displayed."
#
# Codex MUST delete these message templates completely.
# They must NEVER appear again in Telegram webhook notifications.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 2. IMPLEMENT NEW DYNAMIC SUMMARY SYSTEM
# ------------------------------------------------------------
# Create a new function:
#
#   formatInputSummary(callType, customerName, timestamp, fields)
#
# This function MUST return a different formatted message
# depending on the callType.
#
# ------------------------------------------------------------
# Format A — Verification Call (example)
# ------------------------------------------------------------
#   ⚠️ Input Summary
#   Verification input received.
#   Client: {customerName}
#   Call Type: Verification
#   Time: {timestamp}
#
# ------------------------------------------------------------
# Format B — Information Collection Call (example)
# ------------------------------------------------------------
#   ⚠️ Input Summary
#   Requested information received.
#   Client: {customerName}
#   Call Type: Information Collection
#   Time: {timestamp}
#   Details:
#   {key1}: {value1}
#   {key2}: {value2}
#   ...
#
# ------------------------------------------------------------
# Format C — Non-Input Calls
# ------------------------------------------------------------
# DO NOT send any “Keypad Summary” block.
# ONLY send:
#
#   📞 Call completed.
#
# Followed by your existing call-completion message and buttons.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 3. REPLACE OLD LOGIC WITH NEW SUMMARY LOGIC
# ------------------------------------------------------------
# In the webhook handler:
#
# - Generate `fields` from the keypad events / collected data.
# - Pass the collected fields and callType into formatInputSummary().
# - If the summary is not null, send it to Telegram.
# - If the summary is null, skip sending any keypad summary.
#
# Codex MUST rewrite the existing logic to use this new system.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 4. KEEP THESE EXISTING LINES EXACTLY
# ------------------------------------------------------------
# DO NOT modify:
#
#   🔔 Ringing... (3.0s)
#   ☎️ In progress (rang 3s)
#
# These lines are part of the core UX and MUST remain unchanged.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 5. PRE-CALL FLOW IMPROVEMENT
# ------------------------------------------------------------
# After the phone number is entered, Codex MUST insert
# a new step asking for the customer’s name:
#
#   👤 Please enter the customer’s name (as it should be spoken on the call):
#
# Store this value as `customerName` and include it:
# - In API payload
# - In summary messages
# - In personalized greeting
# ------------------------------------------------------------


# ------------------------------------------------------------
# 6. PROFESSIONAL CALL DETAILS CARD
# ------------------------------------------------------------
# Codex MUST modernize the “Call Details” message:
#
#   📋 Call Details:
#   • Number: {phone}
#   • Customer: {customerName}
#   • Template: {template}
#   • Description: {description}
#   • Purpose: {purpose}
#   • Tone: {tone}
#   • Urgency: {urgency}
#   • Technical level: {technical}
#
# This replaces your old formatting.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 7. PERSONALIZED FIRST-GREETING SUPPORT
# ------------------------------------------------------------
# Include `customerName` in the API payload so the greeting script
# can render something like:
#
#   "Hello {customerName}, welcome. For your security..."
#
# NOTE: Codex MUST NOT generate any sensitive examples.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 8. POST-CALL SUMMARY STRUCTURE
# ------------------------------------------------------------
# Improve the final service call summary:
#
#   📞 Service Call Completed
#   Client: {customerName}
#   Answered by: {result}
#   Duration: {duration}
#   Call Type: {callType}
#   Inputs Received: {list or 'None'}
#   Transcript: {excerpt or link}
#   AI Summary: {summary text}
#
# This MUST replace old summary format.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 9. INLINE BUTTONS FOR NON-INPUT CALLS
# ------------------------------------------------------------
# When callType has no input:
#
# Codex MUST show:
#
# Buttons:
#  - View Transcript
#  - View Summary
#  - Make Another Call
#  - Call Settings
#
# Codex MUST add these to the existing Telegram UI.
# ------------------------------------------------------------


# ------------------------------------------------------------
# 10. ENSURE ALL CHANGES ARE APPLIED
# ------------------------------------------------------------
# Codex must modify ALL necessary files:
# - webhook handlers
# - Telegram message formatting
# - state machine / callType logic
# - call-details UI output
# - summary formatting
#
# THE OLD “Keypad Summary / GENERIC” SYSTEM MUST BE FULLY REMOVED.
# ------------------------------------------------------------
