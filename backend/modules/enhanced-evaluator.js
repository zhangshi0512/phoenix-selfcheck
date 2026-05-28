/**
 * Enhanced Self-Evaluator Module
 * Phase 2: Advanced scoring with LLM-as-Judge evaluation, user feedback integration,
 * and sophisticated failure pattern analysis
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { evaluateWithLLM } = require('../lib/gemini-client');

// Configuration
const config = {
  // Scoring weights (can be tuned via A/B testing)
  weights: {
    relevance: 0.30,
    accuracy: 0.25,
    helpfulness: 0.20,
    empathy: 0.10,
    efficiency: 0.10,
    userSatisfaction: 0.05
  },
  // Thresholds for pattern detection
  thresholds: {
    lowScore: 0.4,
    mediumScore: 0.7,
    highScore: 0.85,
    patternMinOccurrences: 3,
    patternTimeWindow: 3600000 // 1 hour in ms
  },
  // Evaluation dimensions
  dimensions: [
    'relevance',
    'accuracy', 
    'helpfulness',
    'empathy',
    'efficiency',
    'userSatisfaction'
  ]
};

class EnhancedEvaluator {
  constructor(options = {}) {
    this.weights = { ...config.weights, ...options.weights };
    this.thresholds = { ...config.thresholds, ...options.thresholds };
    this.evaluationHistory = [];
    this.failurePatterns = new Map();
    this.successPatterns = new Map();
    this.userFeedback = [];
    this.conversationContexts = new Map();
    this.abTestVariants = new Map();
    this.tracer = trace.getTracer('enhanced-evaluator');
  }

  /**
   * Comprehensive evaluation of a conversation turn
   */
  async evaluate(userInput, agentResponse, metadata = {}) {
    const span = this.tracer.startSpan('evaluate-turn');
    const startTime = Date.now();

    try {
      const evaluation = {
        id: `eval-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        timestamp: new Date().toISOString(),
        conversationId: metadata.conversationId,
        turnNumber: metadata.turnNumber || 0,
        userInput,
        agentResponse,
        scores: await this.calculateAllScores(userInput, agentResponse, metadata),
        metadata: {
          ...metadata,
          evaluationDuration: Date.now() - startTime
        }
      };

      // Calculate weighted overall score
      evaluation.scores.overall = this.calculateWeightedOverall(evaluation.scores);

      // Store evaluation
      this.evaluationHistory.push(evaluation);
      
      // Update patterns
      await this.updatePatterns(evaluation);
      
      // Update conversation context
      this.updateConversationContext(evaluation);

      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttributes({
        'evaluation.overall_score': evaluation.scores.overall,
        'evaluation.turn': evaluation.turnNumber
      });

      return evaluation;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Calculate all evaluation scores.
   * Uses LLM-as-Judge (Gemini) when available, falls back to rule-based engine.
   */
  async calculateAllScores(userInput, agentResponse, metadata) {
    // Primary path: LLM-as-Judge using Gemini
    try {
      const llmScores = await evaluateWithLLM(userInput, agentResponse, {
        conversationHistory: metadata.conversationContext?.turns?.slice(-5)
      });

      if (llmScores && llmScores.relevance !== undefined) {
        return {
          relevance: llmScores.relevance,
          accuracy: llmScores.accuracy,
          helpfulness: llmScores.helpfulness,
          empathy: llmScores.empathy,
          efficiency: llmScores.efficiency,
          userSatisfaction: metadata.userRating ? metadata.userRating / 5 : 0.5,
          _evaluator: 'llm-as-judge'
        };
      }
    } catch (e) {
      console.warn('[EnhancedEvaluator] LLM-as-Judge failed, using rule-based fallback:', e.message);
    }

    // Fallback: rule-based scoring
    return this.calculateAllScoresRuleBased(userInput, agentResponse, metadata);
  }

  /**
   * Rule-based scoring fallback (original Phase 2 algorithm).
   */
  async calculateAllScoresRuleBased(userInput, agentResponse, metadata) {
    const scores = {};

    // Relevance: Semantic similarity + intent matching
    scores.relevance = await this.calculateRelevanceScore(userInput, agentResponse, metadata);

    // Accuracy: Factual correctness + tool success
    scores.accuracy = await this.calculateAccuracyScore(agentResponse, metadata);

    // Helpfulness: Actionability + completeness
    scores.helpfulness = await this.calculateHelpfulnessScore(agentResponse, metadata);

    // Empathy: Tone analysis + emotional intelligence
    scores.empathy = await this.calculateEmpathyScore(userInput, agentResponse);

    // Efficiency: Response time + conciseness
    scores.efficiency = await this.calculateEfficiencyScore(agentResponse, metadata);

    // User satisfaction: Based on feedback history
    scores.userSatisfaction = await this.calculateUserSatisfactionScore(metadata);

    scores._evaluator = 'rule-based';
    return scores;
  }

  /**
   * Calculate weighted overall score
   */
  calculateWeightedOverall(scores) {
    let overall = 0;
    let totalWeight = 0;

    for (const [dimension, weight] of Object.entries(this.weights)) {
      if (scores[dimension] !== undefined) {
        overall += scores[dimension] * weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? overall / totalWeight : 0;
  }

  /**
   * Enhanced relevance scoring using semantic analysis
   */
  async calculateRelevanceScore(userInput, agentResponse, metadata) {
    let score = 0.5; // Base score

    // 1. Keyword overlap analysis
    const inputKeywords = this.extractKeywords(userInput);
    const responseKeywords = this.extractKeywords(agentResponse);
    
    if (inputKeywords.length > 0) {
      const overlap = inputKeywords.filter(kw => responseKeywords.includes(kw));
      const keywordScore = overlap.length / inputKeywords.length;
      score = score * 0.4 + keywordScore * 0.6;
    }

    // 2. Intent matching
    if (metadata.intent && metadata.detectedIntent) {
      const intentMatch = metadata.intent === metadata.detectedIntent ? 1.0 : 0.3;
      score = score * 0.7 + intentMatch * 0.3;
    }

    // 3. Entity coverage
    if (metadata.entities && metadata.coveredEntities) {
      const entityCoverage = metadata.coveredEntities.length / 
        Math.max(metadata.entities.length, 1);
      score = score * 0.8 + entityCoverage * 0.2;
    }

    // 4. Context consistency (check if response fits conversation context)
    if (metadata.conversationContext) {
      const contextScore = this.evaluateContextConsistency(
        agentResponse, 
        metadata.conversationContext
      );
      score = score * 0.9 + contextScore * 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Enhanced accuracy scoring
   */
  async calculateAccuracyScore(agentResponse, metadata) {
    let score = 0.7; // Base score

    // 1. Tool execution success
    if (metadata.toolsUsed && metadata.toolsUsed.length > 0) {
      const toolSuccessRate = metadata.toolSuccess ? 1.0 : 0.2;
      score = score * 0.5 + toolSuccessRate * 0.5;
    }

    // 2. Error detection
    const errorIndicators = [
      "I don't know", "I'm not sure", "unable to", "cannot",
      "error occurred", "something went wrong", "no information",
      "not available", "out of service"
    ];
    
    const hasErrors = errorIndicators.some(indicator =>
      agentResponse.toLowerCase().includes(indicator)
    );
    
    if (hasErrors) {
      score *= 0.5;
    }

    // 3. Factual consistency (check for contradictions)
    if (metadata.previousResponses) {
      const consistencyScore = this.checkFactualConsistency(
        agentResponse,
        metadata.previousResponses
      );
      score = score * 0.8 + consistencyScore * 0.2;
    }

    // 4. Source attribution
    if (metadata.sources && metadata.sources.length > 0) {
      const hasAttribution = metadata.sources.some(source =>
        agentResponse.includes(source)
      );
      score += hasAttribution ? 0.1 : -0.05;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Enhanced helpfulness scoring
   */
  async calculateHelpfulnessScore(agentResponse) {
    let score = 0.5;

    // 1. Actionability check
    const actionablePatterns = [
      { pattern: /step \d|first|second|third|finally/i, weight: 0.15 },
      { pattern: /click|tap|press|select|choose/i, weight: 0.10 },
      { pattern: /https?:\/\//i, weight: 0.10 },
      { pattern: /contact|email|call|phone/i, weight: 0.08 },
      { pattern: /you can|try|use|access/i, weight: 0.07 }
    ];

    actionablePatterns.forEach(({ pattern, weight }) => {
      if (pattern.test(agentResponse)) {
        score += weight;
      }
    });

    // 2. Completeness check
    const questionWords = ['what', 'how', 'why', 'when', 'where', 'who'];
    const hasQuestionWord = questionWords.some(word =>
      agentResponse.toLowerCase().includes(word)
    );
    
    if (hasQuestionWord) {
      score += 0.05;
    }

    // 3. Follow-up suggestions
    if (agentResponse.includes('else') || agentResponse.includes('also') ||
        agentResponse.includes('additionally') || agentResponse.includes('furthermore')) {
      score += 0.05;
    }

    // 4. Response length optimization
    const wordCount = agentResponse.split(/\s+/).length;
    if (wordCount >= 20 && wordCount <= 300) {
      score += 0.05; // Optimal length
    } else if (wordCount < 10) {
      score -= 0.1; // Too short
    } else if (wordCount > 500) {
      score -= 0.05; // Too long
    }

    // 5. Structured information
    if (agentResponse.includes('•') || agentResponse.includes('-') ||
        agentResponse.includes('1.') || agentResponse.includes('*')) {
      score += 0.05;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Empathy and tone scoring
   */
  async calculateEmpathyScore(userInput, agentResponse) {
    let score = 0.5;

    // 1. Detect user emotional state
    const emotionalIndicators = {
      frustration: ['angry', 'frustrated', 'annoyed', 'upset', 'terrible', 'awful'],
      urgency: ['urgent', 'asap', 'immediately', 'emergency', 'critical'],
      confusion: ['confused', 'unclear', 'don\'t understand', 'what do you mean'],
      satisfaction: ['thank', 'great', 'awesome', 'perfect', 'excellent']
    };

    const userEmotion = this.detectEmotion(userInput, emotionalIndicators);

    // 2. Check empathetic response patterns
    const empathyPatterns = {
      frustration: ['understand your frustration', 'sorry to hear', 'I apologize', 
                     'let me make this right', 'I hear you'],
      urgency: ['right away', 'immediately', 'priority', 'as quickly as possible'],
      confusion: ['let me clarify', 'to explain further', 'in other words', 'simply put'],
      satisfaction: ['glad to help', 'happy to assist', 'my pleasure']
    };

    if (userEmotion && empathyPatterns[userEmotion]) {
      const hasEmpatheticResponse = empathyPatterns[userEmotion].some(pattern =>
        agentResponse.toLowerCase().includes(pattern)
      );
      
      if (hasEmpatheticResponse) {
        score += 0.3;
      } else {
        score -= 0.2;
      }
    }

    // 3. Tone analysis
    const positiveTone = ['please', 'thank you', 'appreciate', 'happy', 'glad'];
    const negativeTone = ['must', 'have to', 'required', 'mandatory', 'warning'];
    
    const positiveCount = positiveTone.filter(word =>
      agentResponse.toLowerCase().includes(word)
    ).length;
    
    const negativeCount = negativeTone.filter(word =>
      agentResponse.toLowerCase().includes(word)
    ).length;

    score += (positiveCount * 0.05) - (negativeCount * 0.05);

    // 4. Personalization
    if (agentResponse.includes('you') || agentResponse.includes('your')) {
      score += 0.05;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Efficiency scoring
   */
  async calculateEfficiencyScore(agentResponse, metadata) {
    let score = 0.5;

    // 1. Response time scoring
    if (metadata.responseTime) {
      const responseTimeMs = metadata.responseTime;
      if (responseTimeMs <= 1000) score += 0.3;
      else if (responseTimeMs <= 2000) score += 0.2;
      else if (responseTimeMs <= 5000) score += 0.1;
      else if (responseTimeMs > 10000) score -= 0.2;
    }

    // 2. Tool call efficiency
    if (metadata.toolsUsed) {
      const toolCount = metadata.toolsUsed.length;
      if (toolCount === 1) score += 0.1; // Optimal: single tool
      else if (toolCount <= 3) score += 0.05; // Acceptable
      else if (toolCount > 5) score -= 0.1; // Too many tools
    }

    // 3. First response resolution
    if (metadata.resolvedOnFirstResponse) {
      score += 0.2;
    }

    // 4. Conciseness
    const informationDensity = this.calculateInformationDensity(agentResponse);
    
    if (informationDensity > 0.7) score += 0.1;
    else if (informationDensity < 0.3) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * User satisfaction scoring based on feedback history
   */
  async calculateUserSatisfactionScore(metadata) {
    if (!metadata.conversationId) return 0.5;

    const conversationFeedback = this.userFeedback.filter(
      f => f.conversationId === metadata.conversationId
    );

    if (conversationFeedback.length === 0) return 0.5;

    const avgRating = conversationFeedback.reduce(
      (sum, f) => sum + (f.rating || 0), 0
    ) / conversationFeedback.length;

    return avgRating / 5; // Normalize to 0-1
  }

  /**
   * Collect and process user feedback
   */
  collectUserFeedback(conversationId, turnNumber, feedback) {
    const feedbackEntry = {
      id: `feedback-${Date.now()}`,
      conversationId,
      turnNumber,
      timestamp: new Date().toISOString(),
      rating: feedback.rating, // 1-5
      helpful: feedback.helpful, // boolean
      categories: feedback.categories || [], // ['accurate', 'fast', 'friendly', etc.]
      comment: feedback.comment || '',
      wouldUseAgain: feedback.wouldUseAgain // boolean
    };

    this.userFeedback.push(feedbackEntry);

    // Update patterns based on feedback
    this.updatePatternsFromFeedback(feedbackEntry);

    return feedbackEntry;
  }

  /**
   * Update patterns based on user feedback
   */
  updatePatternsFromFeedback(feedback) {
    if (feedback.rating <= 2) {
      // Negative feedback - identify pattern
      const pattern = {
        type: 'user_dissatisfaction',
        severity: feedback.rating === 1 ? 'high' : 'medium',
        categories: feedback.categories,
        comment: feedback.comment
      };

      this.addFailurePattern(pattern, feedback);
    } else if (feedback.rating >= 4) {
      // Positive feedback - identify success pattern
      const pattern = {
        type: 'user_satisfaction',
        categories: feedback.categories,
        comment: feedback.comment
      };

      this.addSuccessPattern(pattern, feedback);
    }
  }

  /**
   * Update failure and success patterns
   */
  async updatePatterns(evaluation) {
    // Failure patterns
    if (evaluation.scores.overall < this.thresholds.lowScore) {
      const failurePattern = this.identifyFailurePattern(evaluation);
      this.addFailurePattern(failurePattern, evaluation);
    }

    // Success patterns
    if (evaluation.scores.overall > this.thresholds.highScore) {
      const successPattern = this.identifySuccessPattern(evaluation);
      this.addSuccessPattern(successPattern, evaluation);
    }
  }

  /**
   * Identify failure pattern from evaluation
   */
  identifyFailurePattern(evaluation) {
    const scores = evaluation.scores;
    const patterns = [];

    if (scores.relevance < 0.3) {
      patterns.push({
        type: 'low_relevance',
        severity: 'high',
        dimension: 'relevance',
        score: scores.relevance
      });
    }

    if (scores.accuracy < 0.3) {
      patterns.push({
        type: 'low_accuracy',
        severity: 'high',
        dimension: 'accuracy',
        score: scores.accuracy
      });
    }

    if (scores.helpfulness < 0.3) {
      patterns.push({
        type: 'low_helpfulness',
        severity: 'medium',
        dimension: 'helpfulness',
        score: scores.helpfulness
      });
    }

    if (scores.empathy < 0.3) {
      patterns.push({
        type: 'low_empathy',
        severity: 'medium',
        dimension: 'empathy',
        score: scores.empathy
      });
    }

    if (scores.efficiency < 0.3) {
      patterns.push({
        type: 'low_efficiency',
        severity: 'low',
        dimension: 'efficiency',
        score: scores.efficiency
      });
    }

    return patterns.length > 0 ? patterns : [{
      type: 'general_failure',
      severity: 'medium',
      dimension: 'overall',
      score: scores.overall
    }];
  }

  /**
   * Identify success pattern from evaluation
   */
  identifySuccessPattern(evaluation) {
    const scores = evaluation.scores;
    const patterns = [];

    for (const [dimension, score] of Object.entries(scores)) {
      if (dimension !== 'overall' && score > 0.85) {
        patterns.push({
          type: `high_${dimension}`,
          dimension,
          score
        });
      }
    }

    return patterns;
  }

  /**
   * Add failure pattern to tracking
   */
  addFailurePattern(pattern, context) {
    const key = pattern.type || pattern[0]?.type || 'unknown';
    
    if (!this.failurePatterns.has(key)) {
      this.failurePatterns.set(key, {
        type: key,
        count: 0,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        examples: [],
        severity: pattern.severity || 'medium',
        dimensions: new Set()
      });
    }

    const existing = this.failurePatterns.get(key);
    existing.count++;
    existing.lastSeen = new Date().toISOString();
    existing.examples.push({
      input: context.userInput?.substring(0, 100),
      response: context.agentResponse?.substring(0, 100),
      timestamp: context.timestamp
    });

    if (pattern.dimension) {
      existing.dimensions.add(pattern.dimension);
    }

    // Keep only last 20 examples
    if (existing.examples.length > 20) {
      existing.examples = existing.examples.slice(-20);
    }
  }

  /**
   * Add success pattern to tracking
   */
  addSuccessPattern(pattern, context) {
    const key = pattern.type || pattern[0]?.type || 'unknown';
    
    if (!this.successPatterns.has(key)) {
      this.successPatterns.set(key, {
        type: key,
        count: 0,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        examples: [],
        dimensions: new Set()
      });
    }

    const existing = this.successPatterns.get(key);
    existing.count++;
    existing.lastSeen = new Date().toISOString();
    existing.examples.push({
      input: context.userInput?.substring(0, 100),
      response: context.agentResponse?.substring(0, 100),
      timestamp: context.timestamp
    });

    if (pattern.dimension) {
      existing.dimensions.add(pattern.dimension);
    }

    if (existing.examples.length > 20) {
      existing.examples = existing.examples.slice(-20);
    }
  }

  /**
   * Update conversation context for multi-turn analysis
   */
  updateConversationContext(evaluation) {
    const { conversationId } = evaluation;
    
    if (!this.conversationContexts.has(conversationId)) {
      this.conversationContexts.set(conversationId, {
        turns: [],
        topics: new Set(),
        entities: new Map(),
        sentimentTrend: [],
        startTime: evaluation.timestamp
      });
    }

    const context = this.conversationContexts.get(conversationId);
    context.turns.push({
      turnNumber: evaluation.turnNumber,
      userInput: evaluation.userInput,
      agentResponse: evaluation.agentResponse,
      scores: evaluation.scores,
      timestamp: evaluation.timestamp
    });

    // Extract topics
    const topics = this.extractTopics(evaluation.userInput);
    topics.forEach(t => context.topics.add(t));

    // Track sentiment
    const sentiment = this.analyzeSentiment(evaluation.userInput);
    context.sentimentTrend.push(sentiment);
  }

  /**
   * Extract topics from user input
   */
  extractTopics(text) {
    const topicPatterns = {
      billing: /bill|payment|charge|invoice|refund|price|cost/i,
      technical: /error|bug|crash|not working|broken|issue|problem/i,
      account: /account|login|password|profile|settings|register/i,
      product: /product|item|feature|specification|model/i,
      shipping: /ship|delivery|tracking|address|package/i,
      support: /help|support|assist|guide|tutorial|how to/i
    };

    const topics = [];
    for (const [topic, pattern] of Object.entries(topicPatterns)) {
      if (pattern.test(text)) {
        topics.push(topic);
      }
    }

    return topics;
  }

  /**
   * Simple sentiment analysis
   */
  analyzeSentiment(text) {
    const positive = ['thank', 'great', 'awesome', 'excellent', 'good', 'helpful',
                      'perfect', 'love', 'amazing', 'wonderful', 'happy'];
    const negative = ['bad', 'terrible', 'awful', 'horrible', 'worst', 'hate',
                      'angry', 'frustrated', 'annoying', 'useless', 'broken'];

    const words = text.toLowerCase().split(/\s+/);
    let score = 0;

    words.forEach(word => {
      if (positive.includes(word)) score += 0.2;
      if (negative.includes(word)) score -= 0.2;
    });

    return Math.max(-1, Math.min(1, score));
  }

  /**
   * Detect user emotion
   */
  detectEmotion(text, indicators) {
    const textLower = text.toLowerCase();
    
    for (const [emotion, keywords] of Object.entries(indicators)) {
      if (keywords.some(kw => textLower.includes(kw))) {
        return emotion;
      }
    }

    return null;
  }

  /**
   * Evaluate context consistency
   */
  evaluateContextConsistency(response, context) {
    // Check if response references previous conversation elements
    const contextKeywords = this.extractKeywords(
      context.turns.map(t => t.userInput).join(' ')
    );
    
    const responseKeywords = this.extractKeywords(response);
    const overlap = contextKeywords.filter(kw => responseKeywords.includes(kw));
    
    return contextKeywords.length > 0 ? 
      overlap.length / Math.min(contextKeywords.length, 10) : 0.5;
  }

  /**
   * Check factual consistency with previous responses
   */
  checkFactualConsistency(currentResponse, previousResponses) {
    if (!previousResponses || previousResponses.length === 0) return 0.5;

    // Simple check: look for contradictions in numbers and facts
    const currentNumbers = currentResponse.match(/\d+(\.\d+)?/g) || [];
    let consistencyScore = 0.5;

    for (const prevResponse of previousResponses) {
      const prevNumbers = prevResponse.match(/\d+(\.\d+)?/g) || [];
      
      // Check if same numbers appear (consistency indicator)
      const numberOverlap = currentNumbers.filter(n => prevNumbers.includes(n));
      if (numberOverlap.length > 0) {
        consistencyScore += 0.1;
      }
    }

    return Math.min(1, consistencyScore);
  }

  /**
   * Calculate information density
   */
  calculateInformationDensity(text) {
    const words = text.split(/\s+/);
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or',
      'but', 'not', 'no', 'yes', 'this', 'that', 'it', 'its'
    ]);

    const contentWords = words.filter(w => !stopWords.has(w.toLowerCase()));
    return words.length > 0 ? contentWords.length / words.length : 0;
  }

  /**
   * Extract keywords from text
   */
  extractKeywords(text) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'can', 'shall',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'and', 'or', 'but', 'not', 'no', 'yes', 'this', 'that',
      'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
      'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their'
    ]);

    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
  }

  /**
   * Get comprehensive improvement suggestions
   */
  getImprovementSuggestions() {
    const suggestions = [];

    // Analyze failure patterns
    for (const [type, pattern] of this.failurePatterns) {
      if (pattern.count >= this.thresholds.patternMinOccurrences) {
        const suggestion = this.generateSuggestionForPattern(type, pattern);
        if (suggestion) suggestions.push(suggestion);
      }
    }

    // Analyze dimension trends
    const dimensionTrends = this.analyzeDimensionTrends();
    dimensionTrends.forEach(trend => {
      if (trend.declining) {
        suggestions.push({
          type: 'declining_dimension',
          priority: 'medium',
          dimension: trend.dimension,
          suggestion: `Improve ${trend.dimension}: score declining by ${trend.changePercent}%`,
          currentScore: trend.currentScore,
          previousScore: trend.previousScore
        });
      }
    });

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => 
      (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3)
    );

    return suggestions;
  }

  /**
   * Generate specific suggestion for a failure pattern
   */
  generateSuggestionForPattern(type, pattern) {
    const suggestions = {
      low_relevance: {
        priority: 'high',
        suggestion: 'Enhance intent recognition and context understanding. Consider adding more training data for misunderstood intents.',
        action: 'Review and expand intent training examples'
      },
      low_accuracy: {
        priority: 'high',
        suggestion: 'Improve knowledge base accuracy and tool integration. Verify data sources and add validation checks.',
        action: 'Audit knowledge base and tool responses'
      },
      low_helpfulness: {
        priority: 'medium',
        suggestion: 'Add more actionable steps, examples, and follow-up suggestions to responses.',
        action: 'Enhance response templates with actionable content'
      },
      low_empathy: {
        priority: 'medium',
        suggestion: 'Improve emotional intelligence in responses. Add empathetic language for frustrated users.',
        action: 'Add empathy training examples'
      },
      low_efficiency: {
        priority: 'low',
        suggestion: 'Optimize response generation and tool calls. Consider caching frequent responses.',
        action: 'Profile and optimize slow operations'
      },
      user_dissatisfaction: {
        priority: 'high',
        suggestion: 'Address user dissatisfaction patterns. Review feedback categories for common issues.',
        action: 'Analyze user feedback and implement fixes'
      }
    };

    const template = suggestions[type] || {
      priority: 'medium',
      suggestion: `Address ${type.replace(/_/g, ' ')} pattern (${pattern.count} occurrences)`,
      action: 'Investigate and implement improvements'
    };

    return {
      type,
      ...template,
      occurrences: pattern.count,
      firstSeen: pattern.firstSeen,
      lastSeen: pattern.lastSeen,
      affectedDimensions: Array.from(pattern.dimensions || []),
      examples: pattern.examples?.slice(-3) || []
    };
  }

  /**
   * Analyze dimension score trends
   */
  analyzeDimensionTrends() {
    const trends = [];
    const recentEvaluations = this.evaluationHistory.slice(-100);
    
    if (recentEvaluations.length < 20) return trends;

    const midpoint = Math.floor(recentEvaluations.length / 2);
    const firstHalf = recentEvaluations.slice(0, midpoint);
    const secondHalf = recentEvaluations.slice(midpoint);

    for (const dimension of config.dimensions) {
      const firstAvg = this.averageScore(firstHalf, dimension);
      const secondAvg = this.averageScore(secondHalf, dimension);
      
      if (firstAvg > 0 && secondAvg > 0) {
        const change = ((secondAvg - firstAvg) / firstAvg) * 100;
        
        trends.push({
          dimension,
          previousScore: firstAvg,
          currentScore: secondAvg,
          changePercent: Math.round(change * 100) / 100,
          declining: change < -5 // 5% decline threshold
        });
      }
    }

    return trends;
  }

  /**
   * Calculate average score for a dimension
   */
  averageScore(evaluations, dimension) {
    if (evaluations.length === 0) return 0;
    
    const sum = evaluations.reduce(
      (total, item) => total + (item.scores[dimension] || 0), 0
    );
    
    return sum / evaluations.length;
  }

  /**
   * Get comprehensive evaluation summary
   */
  getEvaluationSummary() {
    if (this.evaluationHistory.length === 0) {
      return { message: 'No evaluations yet', status: 'idle' };
    }

    const recentEvaluations = this.evaluationHistory.slice(-100);
    
    // Calculate average scores
    const avgScores = {};
    for (const dimension of [...config.dimensions, 'overall']) {
      avgScores[dimension] = this.averageScore(recentEvaluations, dimension);
    }

    // Calculate trends
    const trends = this.analyzeDimensionTrends();

    // Get improvement suggestions
    const suggestions = this.getImprovementSuggestions();

    // Calculate user satisfaction
    const recentFeedback = this.userFeedback.slice(-50);
    const avgUserRating = recentFeedback.length > 0
      ? recentFeedback.reduce((sum, f) => sum + (f.rating || 0), 0) / recentFeedback.length
      : null;

    return {
      status: avgScores.overall > 0.7 ? 'healthy' : 
              avgScores.overall > 0.4 ? 'warning' : 'critical',
      totalEvaluations: this.evaluationHistory.length,
      recentEvaluations: recentEvaluations.length,
      averageScores: avgScores,
      trends,
      userSatisfaction: {
        averageRating: avgUserRating,
        totalFeedback: this.userFeedback.length,
        recentFeedback: recentFeedback.length,
        wouldUseAgain: recentFeedback.filter(f => f.wouldUseAgain).length / 
                      Math.max(recentFeedback.length, 1)
      },
      failurePatterns: Array.from(this.failurePatterns.values())
        .sort((a, b) => b.count - a.count),
      successPatterns: Array.from(this.successPatterns.values())
        .sort((a, b) => b.count - a.count),
      improvementSuggestions: suggestions,
      dimensionTrends: trends
    };
  }

  /**
   * A/B Testing support
   */
  setABTestVariant(variantId, config) {
    this.abTestVariants.set(variantId, {
      id: variantId,
      config,
      startTime: new Date().toISOString(),
      evaluations: []
    });
  }

  getABTestResults(variantId) {
    const variant = this.abTestVariants.get(variantId);
    if (!variant) return null;

    const evaluations = this.evaluationHistory.filter(
      e => e.metadata.abTestVariant === variantId
    );

    return {
      variantId,
      config: variant.config,
      evaluationCount: evaluations.length,
      averageScores: this.calculateAverageScores(evaluations),
      comparedToBaseline: this.compareToBaseline(variantId)
    };
  }

  calculateAverageScores(evaluations) {
    if (evaluations.length === 0) return {};
    
    const scores = {};
    for (const dimension of [...config.dimensions, 'overall']) {
      scores[dimension] = this.averageScore(evaluations, dimension);
    }
    
    return scores;
  }

  compareToBaseline(variantId) {
    const variantEvals = this.evaluationHistory.filter(
      e => e.metadata.abTestVariant === variantId
    );
    
    const baselineEvals = this.evaluationHistory.filter(
      e => !e.metadata.abTestVariant
    );

    if (variantEvals.length === 0 || baselineEvals.length === 0) return null;

    const variantScores = this.calculateAverageScores(variantEvals);
    const baselineScores = this.calculateAverageScores(baselineEvals);

    const comparison = {};
    for (const dimension of [...config.dimensions, 'overall']) {
      if (variantScores[dimension] && baselineScores[dimension]) {
        comparison[dimension] = {
          variant: variantScores[dimension],
          baseline: baselineScores[dimension],
          improvement: variantScores[dimension] - baselineScores[dimension],
          improvementPercent: ((variantScores[dimension] - baselineScores[dimension]) / 
                              baselineScores[dimension]) * 100
        };
      }
    }

    return comparison;
  }
}

module.exports = { EnhancedEvaluator, config };
