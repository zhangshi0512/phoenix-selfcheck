/**
 * Multi-language Support Module
 * Phase 2: Language detection, translation, and locale-aware responses
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { TranslationServiceClient } = require('@google-cloud/translate');

const tracer = trace.getTracer('multi-language');

// Initialize Translation client
const translationClient = new TranslationServiceClient();

// Supported languages with metadata
const SUPPORTED_LANGUAGES = {
  en: { name: 'English', nativeName: 'English', code: 'en', direction: 'ltr' },
  es: { name: 'Spanish', nativeName: 'Español', code: 'es', direction: 'ltr' },
  fr: { name: 'French', nativeName: 'Français', code: 'fr', direction: 'ltr' },
  de: { name: 'German', nativeName: 'Deutsch', code: 'de', direction: 'ltr' },
  zh: { name: 'Chinese (Simplified)', nativeName: '中文', code: 'zh', direction: 'ltr' },
  ja: { name: 'Japanese', nativeName: '日本語', code: 'ja', direction: 'ltr' },
  ko: { name: 'Korean', nativeName: '한국어', code: 'ko', direction: 'ltr' },
  ar: { name: 'Arabic', nativeName: 'العربية', code: 'ar', direction: 'rtl' },
  hi: { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi', direction: 'ltr' },
  pt: { name: 'Portuguese', nativeName: 'Português', code: 'pt', direction: 'ltr' },
  ru: { name: 'Russian', nativeName: 'Русский', code: 'ru', direction: 'ltr' },
  it: { name: 'Italian', nativeName: 'Italiano', code: 'it', direction: 'ltr' }
};

// Language-specific templates and patterns
const LANGUAGE_TEMPLATES = {
  en: {
    greetings: ['Hello!', 'Hi there!', 'Welcome!'],
    apologies: ['I apologize for the inconvenience.', 'Sorry about that.', 'My apologies.'],
    confirmations: ['Got it.', 'Understood.', 'I see.'],
    closings: ['Is there anything else I can help with?', 'Have a great day!', 'Thank you for contacting us.']
  },
  es: {
    greetings: ['¡Hola!', '¡Buenos días!', '¡Bienvenido!'],
    apologies: ['Disculpe las molestias.', 'Lo siento.', 'Mis disculpas.'],
    confirmations: ['Entendido.', 'Comprendo.', 'Ya veo.'],
    closings: ['¿Hay algo más en lo que pueda ayudarle?', '¡Que tenga un buen día!', 'Gracias por contactarnos.']
  },
  fr: {
    greetings: ['Bonjour !', 'Salut !', 'Bienvenue !'],
    apologies: ['Je m\'excuse pour le désagrément.', 'Désolé pour cela.', 'Mes excuses.'],
    confirmations: ['Compris.', 'Je comprends.', 'Je vois.'],
    closings: ['Y a-t-il autre chose que je puisse vous aider ?', 'Passez une bonne journée !', 'Merci de nous avoir contactés.']
  },
  zh: {
    greetings: ['你好！', '您好！', '欢迎！'],
    apologies: ['给您带来不便，我深表歉意。', '对此我很抱歉。', '我道歉。'],
    confirmations: ['明白了。', '理解了。', '我知道了。'],
    closings: ['还有什么我可以帮助您的吗？', '祝您有美好的一天！', '感谢您联系我们。']
  }
};

class MultiLanguageSupport {
  constructor(options = {}) {
    this.projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
    this.defaultLanguage = options.defaultLanguage || 'en';
    this.fallbackLanguage = options.fallbackLanguage || 'en';
    this.autoDetect = options.autoDetect !== false;
    this.autoTranslate = options.autoTranslate !== false;
    this.cache = new Map();
    this.userPreferences = new Map();
  }

  /**
   * Detect language from text
   */
  async detectLanguage(text) {
    const span = tracer.startSpan('detect-language');

    try {
      if (!text || text.trim().length === 0) {
        return { language: this.defaultLanguage, confidence: 0 };
      }

      // Check cache
      const cacheKey = `detect:${text.substring(0, 100)}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        span.setAttributes({ 'language.cache_hit': true });
        return cached;
      }

      // Use Google Cloud Translation API
      const request = {
        parent: `projects/${this.projectId}/locations/global`,
        content: text,
        mimeType: 'text/plain'
      };

      const [response] = await translationClient.detectLanguage(request);
      
      if (!response.languages || response.languages.length === 0) {
        return { language: this.defaultLanguage, confidence: 0 };
      }

      const primaryLanguage = response.languages[0];
      const result = {
        language: primaryLanguage.languageCode,
        confidence: primaryLanguage.confidence || 0,
        alternatives: response.languages.slice(1).map(lang => ({
          language: lang.languageCode,
          confidence: lang.confidence || 0
        }))
      };

      // Cache result
      this.cache.set(cacheKey, result);

      span.setAttributes({
        'language.detected': result.language,
        'language.confidence': result.confidence
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      
      // Fallback to simple detection
      return this.fallbackDetectLanguage(text);
    } finally {
      span.end();
    }
  }

  /**
   * Simple fallback language detection
   */
  fallbackDetectLanguage(text) {
    const patterns = {
      es: /[áéíóúñ¿¡]/,
      fr: /[àâçéèêëîïôùûüÿœæ]/,
      de: /[äöüß]/,
      zh: /[\u4e00-\u9fff]/,
      ja: /[\u3040-\u309f\u30a0-\u30ff]/,
      ko: /[\uac00-\ud7af]/,
      ar: /[\u0600-\u06ff]/,
      ru: /[а-яёА-ЯЁ]/
    };

    for (const [lang, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) {
        return { language: lang, confidence: 0.7 };
      }
    }

    return { language: this.defaultLanguage, confidence: 0.1 };
  }

  /**
   * Translate text to target language
   */
  async translateText(text, targetLanguage, sourceLanguage = null) {
    const span = tracer.startSpan('translate-text');

    try {
      if (!text || text.trim().length === 0) {
        return { translatedText: text, sourceLanguage: targetLanguage };
      }

      // Check if already in target language
      if (!sourceLanguage) {
        const detection = await this.detectLanguage(text);
        sourceLanguage = detection.language;
      }

      if (sourceLanguage === targetLanguage) {
        return { translatedText: text, sourceLanguage };
      }

      // Check cache
      const cacheKey = `translate:${sourceLanguage}:${targetLanguage}:${text.substring(0, 100)}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        span.setAttributes({ 'translation.cache_hit': true });
        return cached;
      }

      // Use Google Cloud Translation API
      const request = {
        parent: `projects/${this.projectId}/locations/global`,
        contents: [text],
        mimeType: 'text/plain',
        sourceLanguageCode: sourceLanguage,
        targetLanguageCode: targetLanguage
      };

      const [response] = await translationClient.translateText(request);
      
      if (!response.translations || response.translations.length === 0) {
        throw new Error('Translation failed');
      }

      const result = {
        translatedText: response.translations[0].translatedText,
        sourceLanguage,
        targetLanguage,
        confidence: 1.0
      };

      // Cache result
      this.cache.set(cacheKey, result);

      span.setAttributes({
        'translation.source': sourceLanguage,
        'translation.target': targetLanguage,
        'translation.length': text.length
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      
      // Fallback: return original text
      return {
        translatedText: text,
        sourceLanguage: sourceLanguage || 'unknown',
        targetLanguage,
        confidence: 0,
        error: error.message
      };
    } finally {
      span.end();
    }
  }

  /**
   * Localize a response based on user language
   */
  async localizeResponse(response, userLanguage) {
    const span = tracer.startSpan('localize-response');

    try {
      if (!userLanguage || userLanguage === this.defaultLanguage) {
        return response;
      }

      // Check if language is supported
      if (!SUPPORTED_LANGUAGES[userLanguage]) {
        return response;
      }

      // Simple localization: replace common patterns
      const localized = this.applyLocalizationPatterns(response, userLanguage);

      // For complex responses, translate if needed
      if (this.autoTranslate && localized === response) {
        const translation = await this.translateText(response, userLanguage);
        return translation.translatedText;
      }

      span.setAttributes({
        'localization.language': userLanguage,
        'localization.applied': localized !== response
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return localized;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      return response; // Fallback to original
    } finally {
      span.end();
    }
  }

  /**
   * Apply language-specific patterns to response
   */
  applyLocalizationPatterns(response, language) {
    const templates = LANGUAGE_TEMPLATES[language];
    if (!templates) return response;

    let localized = response;

    // Replace greetings
    templates.greetings.forEach((greeting, index) => {
      const englishGreeting = LANGUAGE_TEMPLATES.en.greetings[index];
      if (englishGreeting && localized.includes(englishGreeting)) {
        localized = localized.replace(englishGreeting, greeting);
      }
    });

    // Replace apologies
    templates.apologies.forEach((apology, index) => {
      const englishApology = LANGUAGE_TEMPLATES.en.apologies[index];
      if (englishApology && localized.includes(englishApology)) {
        localized = localized.replace(englishApology, apology);
      }
    });

    // Replace confirmations
    templates.confirmations.forEach((confirmation, index) => {
      const englishConfirmation = LANGUAGE_TEMPLATES.en.confirmations[index];
      if (englishConfirmation && localized.includes(englishConfirmation)) {
        localized = localized.replace(englishConfirmation, confirmation);
      }
    });

    // Replace closings
    templates.closings.forEach((closing, index) => {
      const englishClosing = LANGUAGE_TEMPLATES.en.closings[index];
      if (englishClosing && localized.includes(englishClosing)) {
        localized = localized.replace(englishClosing, closing);
      }
    });

    return localized;
  }

  /**
   * Set user language preference
   */
  setUserPreference(userId, language) {
    if (!SUPPORTED_LANGUAGES[language]) {
      throw new Error(`Language ${language} is not supported`);
    }

    this.userPreferences.set(userId, {
      language,
      setAt: new Date().toISOString(),
      source: 'manual'
    });

    return this.userPreferences.get(userId);
  }

  /**
   * Get user language preference
   */
  getUserPreference(userId) {
    return this.userPreferences.get(userId) || {
      language: this.defaultLanguage,
      setAt: null,
      source: 'default'
    };
  }

  /**
   * Auto-detect and set user language preference
   */
  async autoDetectUserPreference(userId, userInput) {
    const detection = await this.detectLanguage(userInput);
    
    if (detection.confidence > 0.5) {
      this.userPreferences.set(userId, {
        language: detection.language,
        setAt: new Date().toISOString(),
        source: 'auto_detected',
        confidence: detection.confidence,
        sampleText: userInput.substring(0, 100)
      });
    }

    return this.getUserPreference(userId);
  }

  /**
   * Get localized greeting
   */
  getLocalizedGreeting(language) {
    const lang = language || this.defaultLanguage;
    const templates = LANGUAGE_TEMPLATES[lang] || LANGUAGE_TEMPLATES.en;
    
    const randomIndex = Math.floor(Math.random() * templates.greetings.length);
    return templates.greetings[randomIndex];
  }

  /**
   * Get localized apology
   */
  getLocalizedApology(language) {
    const lang = language || this.defaultLanguage;
    const templates = LANGUAGE_TEMPLATES[lang] || LANGUAGE_TEMPLATES.en;
    
    const randomIndex = Math.floor(Math.random() * templates.apologies.length);
    return templates.apologies[randomIndex];
  }

  /**
   * Get localized closing
   */
  getLocalizedClosing(language) {
    const lang = language || this.defaultLanguage;
    const templates = LANGUAGE_TEMPLATES[lang] || LANGUAGE_TEMPLATES.en;
    
    const randomIndex = Math.floor(Math.random() * templates.closings.length);
    return templates.closings[randomIndex];
  }

  /**
   * Format numbers, dates, and currencies based on locale
   */
  formatForLocale(value, type, language) {
    const lang = language || this.defaultLanguage;
    
    try {
      const locale = this.getLocaleCode(lang);
      
      switch (type) {
        case 'number':
          return new Intl.NumberFormat(locale).format(value);
        case 'currency':
          // Default to USD for now
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: 'USD'
          }).format(value);
        case 'date':
          return new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          }).format(new Date(value));
        case 'datetime':
          return new Intl.DateTimeFormat(locale, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          }).format(new Date(value));
        default:
          return value;
      }
    } catch (error) {
      return value; // Fallback to original
    }
  }

  /**
   * Get locale code from language code
   */
  getLocaleCode(language) {
    const localeMap = {
      en: 'en-US',
      es: 'es-ES',
      fr: 'fr-FR',
      de: 'de-DE',
      zh: 'zh-CN',
      ja: 'ja-JP',
      ko: 'ko-KR',
      ar: 'ar-SA',
      hi: 'hi-IN',
      pt: 'pt-PT',
      ru: 'ru-RU',
      it: 'it-IT'
    };

    return localeMap[language] || 'en-US';
  }

  /**
   * Get supported languages list
   */
  getSupportedLanguages() {
    return Object.values(SUPPORTED_LANGUAGES).map(lang => ({
      code: lang.code,
      name: lang.name,
      nativeName: lang.nativeName,
      direction: lang.direction
    }));
  }

  /**
   * Check if language is supported
   */
  isLanguageSupported(language) {
    return !!SUPPORTED_LANGUAGES[language];
  }

  /**
   * Process a conversation with language support
   */
  async processConversation(conversation, userId = null) {
    const span = tracer.startSpan('process-conversation-language');

    try {
      const result = {
        detectedLanguages: [],
        translations: [],
        userLanguage: this.defaultLanguage,
        agentLanguage: this.defaultLanguage
      };

      // Get user language preference
      if (userId) {
        const preference = this.getUserPreference(userId);
        result.userLanguage = preference.language;
        result.preferenceSource = preference.source;
      }

      // Detect language from user messages
      const userMessages = conversation.filter(msg => msg.role === 'user');
      for (const message of userMessages) {
        const detection = await this.detectLanguage(message.content);
        result.detectedLanguages.push({
          message: message.content.substring(0, 50),
          language: detection.language,
          confidence: detection.confidence
        });
      }

      // Determine primary user language
      if (result.detectedLanguages.length > 0) {
        const languageCounts = {};
        result.detectedLanguages.forEach(d => {
          languageCounts[d.language] = (languageCounts[d.language] || 0) + 1;
        });

        const primaryLanguage = Object.entries(languageCounts)
          .sort((a, b) => b[1] - a[1])[0][0];

        // Update user preference if auto-detect is enabled
        if (this.autoDetect && userId && result.detectedLanguages.length >= 2) {
          await this.autoDetectUserPreference(userId, userMessages[0].content);
          result.userLanguage = primaryLanguage;
        }
      }

      // Set agent language to match user
      result.agentLanguage = result.userLanguage;

      span.setAttributes({
        'conversation.user_language': result.userLanguage,
        'conversation.messages': userMessages.length,
        'conversation.languages_detected': result.detectedLanguages.length
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      return {
        userLanguage: this.defaultLanguage,
        agentLanguage: this.defaultLanguage,
        error: error.message
      };
    } finally {
      span.end();
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      detectionHits: Array.from(this.cache.keys())
        .filter(k => k.startsWith('detect:')).length,
      translationHits: Array.from(this.cache.keys())
        .filter(k => k.startsWith('translate:')).length
    };
  }
}

module.exports = { MultiLanguageSupport, SUPPORTED_LANGUAGES };