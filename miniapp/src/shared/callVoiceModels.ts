export type CallVoiceModelOption = {
  id: string;
  label: string;
  gender: string;
  style: string;
};

export const CALL_FALLBACK_VOICE_MODELS: ReadonlyArray<CallVoiceModelOption> = [
  { id: 'aura-2-andromeda-en', label: 'aura-2-andromeda-en', gender: 'female', style: 'balanced' },
  { id: 'aura-2-helena-en', label: 'aura-2-helena-en', gender: 'female', style: 'warm' },
  { id: 'aura-2-thalia-en', label: 'aura-2-thalia-en', gender: 'female', style: 'clear' },
  { id: 'aura-2-arcas-en', label: 'aura-2-arcas-en', gender: 'male', style: 'grounded' },
  { id: 'aura-2-aries-en', label: 'aura-2-aries-en', gender: 'male', style: 'confident' },
  { id: 'aura-2-celeste-es', label: 'aura-2-celeste-es', gender: 'female', style: 'clear, Spanish' },
  { id: 'aura-asteria-en', label: 'aura-asteria-en', gender: 'female', style: 'bright' },
];

export const CALL_AGENT_LANGUAGE_OPTIONS = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
] as const;

export const CALL_AGENT_LISTEN_MODEL_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  languages: ReadonlyArray<'en' | 'es'>;
}> = [
  { id: 'nova-2', label: 'Nova 2', languages: ['en', 'es'] },
  { id: 'nova-3', label: 'Nova 3', languages: ['en', 'es'] },
  { id: 'flux-general-en', label: 'Flux English', languages: ['en'] },
  { id: 'flux-general-multi', label: 'Flux multilingual', languages: ['en', 'es'] },
];

export const CALL_AGENT_THINK_MODEL_OPTIONS = [
  { provider: 'open_ai', model: 'gpt-4o-mini', label: 'OpenAI · GPT-4o mini' },
  { provider: 'open_ai', model: 'gpt-4.1-mini', label: 'OpenAI · GPT-4.1 mini' },
  { provider: 'open_ai', model: 'gpt-5-mini', label: 'OpenAI · GPT-5 mini' },
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Anthropic · Claude Haiku 4.5' },
  { provider: 'google', model: 'gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' },
] as const;
