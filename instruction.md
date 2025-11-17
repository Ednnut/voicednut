# ============================================================
# APPLY DISCORD-STYLE FORMATTING TO TELEGRAM WEBHOOK MESSAGES
# ============================================================

# Goal:
# Mirror the clean, structured embed style from the Discord example,
# but adapt it for Telegram webhook notifications and WITHOUT
# handling or exposing sensitive authentication codes.

# ------------------------------------------------------------
# 1. MIRROR THE STYLE (STRUCTURE ONLY)
# ------------------------------------------------------------
# Convert Telegram webhook notifications to match the layout style:
# - Title block
# - Color theme indicator (use emoji or unicode blocks since Telegram has no embed colors)
# - Description block
# - Footer section
# - Timestamp
#
# Example formatting that Codex must follow:
#
#   📱 {callTarget}
#   ━━━━━━━━━━━━━━━━━━━━━━━
#   🕵️ Status: {description}
#
#   👤 Client: {customerName}
#
#   🕒 Timestamp: {timestamp}
#   🧩 Source: {sourceSystem}
#
# ------------------------------------------------------------
# 2. IF DATA IS MISSING / NO RESPONSE
# ------------------------------------------------------------
# Use the style:
#
#   📱 {callTarget}
#   ━━━━━━━━━━━━━━━━━━━━━━━
#   🕵️ No input received from the user.
#
#   👤 Client: {customerName}
#   🕒 Timestamp: {timestamp}
#
# ------------------------------------------------------------
# 3. IF NON-SENSITIVE INFORMATION IS PROVIDED
# ------------------------------------------------------------
# Format the details as:
#
#   📱 {callTarget}
#   ━━━━━━━━━━━━━━━━━━━━━━━
#   🕵️ Information received:
#   • {field1}: {value1}
#   • {field2}: {value2}
#   • {field3}: {value3}
#
#   👤 Client: {customerName}
#   🕒 Timestamp: {timestamp}
#
# ------------------------------------------------------------
# 4. DO NOT HANDLE OR DISPLAY SENSITIVE DIGITS
# ------------------------------------------------------------
# Codex MUST NOT create or expose:
# - OTP codes
# - PIN codes
# - CVV numbers
# - Card numbers
# - Bank credentials
#
# If the bot receives sensitive content from upstream systems,
# mask it or strip it.
#
# Example:
#   Sensitive value masked for security.
#
# ------------------------------------------------------------
# 5. ENSURE CONSISTENT STYLE ACROSS ALL TELEGRAM NOTIFICATIONS
# ------------------------------------------------------------
# Codex must rewrite any existing notification code to use:
# - Title line
# - Divider line
# - Professional section blocks
# - Uniform emoji style (📱 🕵️ 👤 🕒)
# - Timestamp
#
# ------------------------------------------------------------
# 6. TARGETED INSTRUCTION
# ------------------------------------------------------------
# Search the codebase for the existing Telegram message builder.
# Replace the raw text notifications with the new structured format.
#
# Codex must NOT keep old formats such as:
#   "⚠️ Keypad Summary"
#   "GENERIC:"
#   "Dev compliance mode"
#
# These MUST be replaced with the structured embed-like message style.
# ------------------------------------------------------------
