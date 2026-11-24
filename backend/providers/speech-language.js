import { ProviderError } from '../lib/http.js';
import { generateStructured } from './llm.js';

const languageInstructions = new Map([
  ['zh-CN', {
    mode: 'direct',
    description: '保留原文，直接使用普通话口播'
  }],
  ['en-US', {
    mode: 'translate',
    description: '先转换为自然美式英语，再使用克隆声音口播',
    instruction: 'Translate into natural, concise American English for spoken delivery. Preserve all facts, names, numbers, calls to action, and paragraph intent. Do not add explanations.'
  }],
  ['ug-CN', {
    mode: 'translate',
    description: '先转换为现代维吾尔语，再使用克隆声音口播',
    instruction: 'Translate into natural modern Uyghur written in the Arabic-derived Uyghur script for spoken delivery. Preserve all facts, names, numbers, calls to action, and paragraph intent. Do not add explanations.'
  }],
  ['ethnic-basic', {
    mode: 'rewrite',
    description: '改写为清晰、易理解的通用普通话表达',
    instruction: 'Rewrite as plain, respectful, easy-to-understand Mandarin suitable for a broad audience in ethnic regions. This is not a separate ethnic language. Keep every fact, name, number, call to action, and the original intent. Do not stereotype or add explanations.'
  }],
  ['zh-CN-henan', {
    mode: 'dialect-rewrite',
    description: '改写为自然河南口语，再使用克隆声音口播',
    instruction: 'Rewrite as natural, contemporary Henan conversational Chinese for spoken delivery. Use recognizable Henan wording sparingly, keep it readable, and preserve every fact, name, number, call to action, and the original intent. Do not add explanations or caricature the dialect.'
  }],
  ['zh-CN-sichuan', {
    mode: 'dialect-rewrite',
    description: '改写为自然四川口语，再使用克隆声音口播',
    instruction: 'Rewrite as natural, contemporary Sichuan conversational Chinese for spoken delivery. Use recognizable Sichuan wording sparingly, keep it readable, and preserve every fact, name, number, call to action, and the original intent. Do not add explanations or caricature the dialect.'
  }]
]);

export function speechLanguageMetadata(languageId) {
  return languageInstructions.get(String(languageId || '').trim()) || null;
}

export async function prepareSpeechScript({ script, language, languageLabel }) {
  const sourceText = String(script || '').trim();
  if (!sourceText) throw new ProviderError('SPEECH_SCRIPT_REQUIRED', '请输入要口播的文案', { status: 400 });
  const languageId = String(language || 'zh-CN').trim();
  const definition = speechLanguageMetadata(languageId);
  if (!definition) throw new ProviderError('SPEECH_LANGUAGE_INVALID', '不支持所选口播语言', { status: 400 });

  if (definition.mode === 'direct') {
    return {
      sourceText,
      speechText: sourceText,
      language: languageId,
      languageLabel: String(languageLabel || '普通话').trim(),
      transformMode: 'direct',
      transformed: false,
      translationProvider: null,
      translationModel: null
    };
  }

  const result = await generateStructured({
    purpose: 'speech-translation',
    system: `You prepare production-ready speech scripts. ${definition.instruction} Return only the converted speech text in the text field. Never include notes, quotation marks around the whole result, language labels, or Markdown.`,
    input: {
      sourceText,
      targetLanguage: languageId,
      targetLanguageLabel: String(languageLabel || languageId).trim()
    },
    schema: { text: 'string' },
    required: ['text'],
    // Uyghur translation can take longer with the configured content model because it
    // must produce Arabic-derived Uyghur script rather than a Latin-script transliteration.
    timeoutMs: languageId === 'ug-CN' ? 120_000 : null
  });
  const speechText = String(result.data.text || '').trim();
  if (!speechText) throw new ProviderError('SPEECH_TRANSLATION_EMPTY', '内容模型没有返回可用的目标语言口播稿');

  return {
    sourceText,
    speechText,
    language: languageId,
    languageLabel: String(languageLabel || languageId).trim(),
    transformMode: definition.mode,
    transformed: true,
    translationProvider: result.meta.provider,
    translationModel: result.meta.model
  };
}
