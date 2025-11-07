const { DEFAULT_SYSTEM_PROMPT, DEFAULT_FIRST_MESSAGE } = require('../routes/gpt');
const { getBusinessProfile } = require('../config/business');
const {
  moodStrategies,
  urgencyInstructions,
  channelGuidelines,
  technicalProfiles,
  businessPurposes
} = require('../config/personalityTemplates');

const BULLET_INSTRUCTION =
  "You must add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text to speech.";

function scrubVoiceOnlyInstructions(text, channel) {
  if (channel === 'voice') return text;
  if (!text) return text;

  return text
    .replace(BULLET_INSTRUCTION, '')
    .replace(/•/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.{2,}/g, '.')
    .trim();
}

function ensureSentence(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

class PersonaComposer {
  compose(options = {}) {
    const {
      businessId = null,
      customPrompt = null,
      customFirstMessage = null,
      purpose = 'general',
      channel = 'voice',
      emotion = 'neutral',
      urgency = 'normal',
      technicalLevel = 'general'
    } = options;

    const profile = businessId ? getBusinessProfile(businessId) : null;
    const channelKey = channelGuidelines[channel] ? channel : 'voice';
    const moodKey = moodStrategies[emotion] ? emotion : 'neutral';
    const urgencyKey = urgencyInstructions[urgency] ? urgency : 'normal';
    const technicalKey = technicalProfiles[technicalLevel] ? technicalLevel : 'general';
    const purposeKey = businessPurposes[purpose] ? purpose : 'general';

    const basePrompt =
      customPrompt ||
      (profile ? profile.prompt : null) ||
      DEFAULT_SYSTEM_PROMPT;

    let baseFirstMessage =
      customFirstMessage ||
      (profile?.channelOpeners?.[channelKey]?.[purposeKey] ??
        profile?.channelOpeners?.[channelKey]?.default) ||
      (profile ? profile.firstMessage : null) ||
      DEFAULT_FIRST_MESSAGE;

    if (channelKey !== 'voice') {
      baseFirstMessage = scrubVoiceOnlyInstructions(baseFirstMessage, channelKey);
    }

    const assembledInstructions = [
      ensureSentence(channelGuidelines[channelKey]?.instructions),
      ensureSentence(moodStrategies[moodKey]?.instructions),
      ensureSentence(urgencyInstructions[urgencyKey]?.instructions),
      ensureSentence(technicalProfiles[technicalKey]?.instructions),
      ensureSentence(businessPurposes[purposeKey]?.instructions),
      profile?.capabilities
        ? ensureSentence(`You can support: ${profile.capabilities.join(', ')}.`)
        : null
    ]
      .filter(Boolean)
      .join(' ');

    let systemPrompt = `${basePrompt} ${assembledInstructions}`.trim();

    if (channelKey !== 'voice') {
      systemPrompt = scrubVoiceOnlyInstructions(systemPrompt, channelKey);
    }

    const metadata = {
      businessId: profile?.id || null,
      businessDisplayName: profile?.displayName || null,
      industry: profile?.industry || null,
      channel: channelKey,
      purpose: purposeKey,
      emotion: moodKey,
      urgency: urgencyKey,
      technicalLevel: technicalKey,
      moodStrategy: moodStrategies[moodKey]?.name,
      urgencyStrategy: urgencyInstructions[urgencyKey]?.name,
      technicalStrategy: technicalProfiles[technicalKey]?.name
    };

    return {
      systemPrompt: systemPrompt.trim(),
      firstMessage: baseFirstMessage,
      metadata
    };
  }
}

module.exports = PersonaComposer;
