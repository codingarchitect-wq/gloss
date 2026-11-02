/**
 * Read aloud: MAI-Voice 2.1 Flash through OpenRouter's speech API, which
 * streams MP3 back. Any voice OpenRouter lists for the model works here
 * (GET /api/v1/models?output_modalities=speech, its supported_voices).
 */
export const TTS_URL = "https://openrouter.ai/api/v1/audio/speech";
export const TTS_MODEL = "microsoft/mai-voice-2.1-flash";
/** A calm American voice, for long reading. */
export const TTS_VOICE = "en-US-Harper:MAI-Voice-2.1-Flash";
/** One request's worth of text. Paragraphs past this are split at sentence ends. */
export const TTS_MAX_CHARS = 1200;
