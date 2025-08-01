/**
 * @fileoverview Acts as a factory to provide a common interface for different AI model services.
 */

const settingsManager = require('./settingsManager');
const geminiService = require('./geminiService');
const deepseekService = require('./deepseekService');

let currentProvider = null;

/**
 * Gets the currently configured model provider service.
 * @returns {object} The service object for the current provider.
 * @throws {Error} If the provider is not configured or supported.
 */
async function getProvider() {
  if (currentProvider) {
    return currentProvider;
  }

  const settings = await settingsManager.loadSettings();
  const providerName = settings.modelProvider || 'gemini';

  if (providerName === 'gemini') {
    if (!geminiService.isInitialized()) {
        if(settings.apiKey && settings.geminiModel) {
            geminiService.initializeGeminiModel(settings.apiKey, settings.geminiModel);
        } else {
            console.warn("Attempted to get Gemini provider, but it's not initialized.");
        }
    }
    currentProvider = geminiService;
    return geminiService;
  }

  if (providerName === 'deepseek') {
    // For DeepSeek, we re-initialize every time to ensure the correct API key, base URL, and model are used.
    if (settings.deepseekApiKey) {
        deepseekService.initializeDeepSeekModel(settings.deepseekApiKey, settings.deepseekBaseUrl, settings.deepseekModel, 'primary');
        if (settings.deepseekStrongerModel) {
            deepseekService.initializeDeepSeekModel(settings.deepseekApiKey, settings.deepseekBaseUrl, settings.deepseekStrongerModel, 'retry');
        }
    } else {
        console.warn("Attempted to get DeepSeek provider, but it's not initialized (missing API key).");
    }
    currentProvider = deepseekService;
    return deepseekService;
  }

  throw new Error(`Unsupported model provider: ${providerName}`);
}

/**
 * Re-initializes the provider based on new settings.
 * This should be called after settings are saved.
 */
async function reinitializeProvider() {
    currentProvider = null;
    await getProvider();
}


// --- Exported Generic Interface ---

async function translateChunk(...args) {
  const provider = await getProvider();
  return provider.translateChunk(...args);
}

async function estimateInputTokensForTranslation(...args) {
  const provider = await getProvider();
  return provider.estimateInputTokensForTranslation(...args);
}

async function summarizeAndExtractTermsChunk(...args) {
  const provider = await getProvider();
  return provider.summarizeAndExtractTermsChunk(...args);
}

async function countTokens(...args) {
  const provider = await getProvider();
  return provider.countTokens(...args);
}

async function isInitialized() {
    const provider = await getProvider();
    return provider.isInitialized();
}

module.exports = {
  getProvider,
  reinitializeProvider,
  translateChunk,
  summarizeAndExtractTermsChunk,
  countTokens,
  isInitialized,
  estimateInputTokensForTranslation,
};