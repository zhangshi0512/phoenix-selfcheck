/**
 * Conversation Summarizer Module
 * Phase 2: Multi-turn conversation summarization with key points extraction
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { analyzeSentiment: sharedAnalyzeSentiment, describeSentiment: sharedDescribeSentiment } = require('../lib/utils');

const tracer = trace.getTracer('conversation-summarizer');

class ConversationSummarizer {
  constructor(options = {}) {
    this.maxConversationLength = options.maxConversationLength || 50;
    this.summaryCache = new Map();
    this.templates = {
      short: this.generateShortSummary.bind(this),
      medium: this.generateMediumSummary.bind(this),
      detailed: this.generateDetailedSummary.bind(this)
    };
  }

  /**
   * Summarize a conversation
   */
  async summarize(conversation, options = {}) {
    const span = tracer.startSpan('summarize-conversation');
    const startTime = Date.now();

    try {
      const {
        format = 'medium',
        includeActions = true,
        includeMetrics = true
      } = options;

      const turns = conversation.turns || [];
      if (turns.length === 0) {
        return { summary: 'No conversation to summarize', turns: 0 };
      }

      // Check cache
      const cacheKey = this.getCacheKey(conversation, options);
      const cached = this.summaryCache.get(cacheKey);
      if (cached) {
        span.setAttributes({ 'summary.cache_hit': true });
        return cached;
      }

      // Extract key information
      const extraction = await this.extractKeyInfo(turns);

      // Generate summary based on format
      const summaryGenerator = this.templates[format] || this.templates.medium;
      const summary = summaryGenerator(extraction);

      // Add action items
      const actionItems = includeActions ? 
        this.extractActionItems(turns) : [];

      // Add metrics
      const metrics = includeMetrics ? 
        this.calculateConversationMetrics(turns) : null;

      const result = {
        conversationId: conversation.id,
        turns: turns.length,
        summary,
        keyPoints: extraction.keyPoints,
        topics: extraction.topics,
        entities: extraction.entities,
        userSentiment: extraction.sentiment,
        resolution: extraction.resolution,
        actionItems,
        metrics,
        generatedAt: new Date().toISOString(),
        summaryTimeMs: Date.now() - startTime
      };

      // Cache result
      this.summaryCache.set(cacheKey, result);

      span.setAttributes({
        'summary.turns': turns.length,
        'summary.topics_count': extraction.topics.length,
        'summary.format': format
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Extract key information from conversation turns
   */
  async extractKeyInfo(turns) {
    const extraction = {
      keyPoints: [],
      topics: new Set(),
      entities: new Map(),
      sentiment: {
        overall: 0,
        trend: [],
        startSentiment: 0,
        endSentiment: 0
      },
      resolution: {
        resolved: false,
        type: 'unknown',
        requiredTurns: turns.length
      },
      userQuestions: [],
      agentActions: [],
      escalations: [],
      transfers: []
    };

    let totalSentiment = 0;
    let sentimentReadings = [];

    for (const turn of turns) {
      // Extract topics
      const turnTopics = this.extractTopics(turn.userInput || '');
      turnTopics.forEach(t => extraction.topics.add(t));

      // Extract entities
      const turnEntities = this.extractEntities(turn.userInput || '');
      turnEntities.forEach((value, key) => {
        if (!extraction.entities.has(key)) {
          extraction.entities.set(key, []);
        }
        extraction.entities.get(key).push(value);
      });

      // Extract user questions
      if (turn.userInput) {
        const questions = this.extractQuestions(turn.userInput);
        extraction.userQuestions.push(...questions);
      }

      // Extract agent actions
      if (turn.agentResponse) {
        const actions = this.extractAgentActions(turn.agentResponse, turn.metadata);
        extraction.agentActions.push(...actions);
      }

      // Track sentiment
      const sentiment = this.analyzeSentiment(turn.userInput || '');
      totalSentiment += sentiment;
      sentimentReadings.push({
        turn: turn.turnNumber || sentimentReadings.length + 1,
        score: sentiment,
        text: (turn.userInput || '').substring(0, 50)
      });

      // Track escalations and transfers
      if (turn.metadata?.escalated) {
        extraction.escalations.push({
          turn: turn.turnNumber,
          reason: turn.metadata.escalationReason || 'unknown'
        });
      }

      if (turn.metadata?.transferred) {
        extraction.transfers.push({
          turn: turn.turnNumber,
          to: turn.metadata.transferredTo || 'unknown'
        });
      }

      // Detect resolution
      if (this.isResolved(turn)) {
        extraction.resolution.resolved = true;
        extraction.resolution.type = this.getResolutionType(turn);
        extraction.resolution.requiredTurns = turn.turnNumber;
      }
    }

    // Calculate sentiment stats
    extraction.sentiment = {
      overall: turns.length > 0 ? totalSentiment / turns.length : 0,
      trend: sentimentReadings,
      startSentiment: sentimentReadings[0]?.score || 0,
      endSentiment: sentimentReadings[sentimentReadings.length - 1]?.score || 0,
      improvement: sentimentReadings.length > 1 ? 
        sentimentReadings[sentimentReadings.length - 1].score - sentimentReadings[0].score : 0
    };

    // Generate key points
    extraction.keyPoints = this.generateKeyPoints(extraction);

    // Convert sets to arrays
    extraction.topics = Array.from(extraction.topics);
    extraction.entities = Object.fromEntries(extraction.entities);

    return extraction;
  }

  /**
   * Generate key points from extraction
   */
  generateKeyPoints(extraction) {
    const keyPoints = [];

    // 1. Main topic
    if (extraction.topics.length > 0) {
      keyPoints.push({
        type: 'main_topic',
        text: `Main topics: ${extraction.topics.slice(0, 3).join(', ')}`,
        importance: 'high'
      });
    }

    // 2. Resolution status
    keyPoints.push({
      type: 'resolution',
      text: extraction.resolution.resolved ?
        `Issue resolved in ${extraction.resolution.requiredTurns} turns (${extraction.resolution.type})` :
        'Issue not yet resolved',
      importance: 'high'
    });

    // 3. Sentiment trend
    if (extraction.sentiment.improvement > 0.2) {
      keyPoints.push({
        type: 'sentiment',
        text: 'Customer sentiment improved significantly during conversation',
        importance: 'medium'
      });
    } else if (extraction.sentiment.improvement < -0.2) {
      keyPoints.push({
        type: 'sentiment_negative',
        text: 'Customer sentiment declined during conversation - may need follow-up',
        importance: 'high'
      });
    }

    // 4. Escalations
    if (extraction.escalations.length > 0) {
      keyPoints.push({
        type: 'escalation',
        text: `Escalated ${extraction.escalations.length} time(s): ${extraction.escalations.map(e => e.reason).join(', ')}`,
        importance: 'high'
      });
    }

    // 5. Entity summary
    const entityKeys = Object.keys(extraction.entities);
    if (entityKeys.length > 0) {
      keyPoints.push({
        type: 'entities',
        text: `Referenced: ${entityKeys.slice(0, 5).join(', ')}`,
        importance: 'low'
      });
    }

    // 6. Agent actions summary
    if (extraction.agentActions.length > 0) {
      const actionTypes = [...new Set(extraction.agentActions.map(a => a.type))];
      keyPoints.push({
        type: 'actions',
        text: `Agent performed: ${actionTypes.join(', ')}`,
        importance: 'medium'
      });
    }

    return keyPoints;
  }

  /**
   * Extract action items from turns
   */
  extractActionItems(turns) {
    const items = [];
    
    for (const turn of turns) {
      if (turn.agentResponse) {
        // Look for action verbs suggesting follow-ups
        const followUpPatterns = [
          { pattern: /I will (get back|follow up|check|investigate|look into|find out)/i, type: 'follow_up' },
          { pattern: /you (need to|should|must|have to) (update|check|review|confirm|provide)/i, type: 'user_action' },
          { pattern: /please (wait|hold|bear with)/i, type: 'wait' },
          { pattern: /expect (a response|to hear|an update)/i, type: 'expectation' }
        ];

        for (const { pattern, type } of followUpPatterns) {
          const match = turn.agentResponse.match(pattern);
          if (match) {
            items.push({
              type,
              description: match[0],
              turn: turn.turnNumber,
              status: 'pending'
            });
            break;
          }
        }
      }

      // Check metadata for explicit action items
      if (turn.metadata?.actionItems) {
        items.push(...turn.metadata.actionItems);
      }
    }

    return items;
  }

  /**
   * Generate short summary (1-2 sentences)
   */
  generateShortSummary(extraction) {
    const topicStr = extraction.topics.slice(0, 3).join(', ') || 'general inquiry';
    const resolutionStr = extraction.resolution.resolved ? 'resolved' : 'ongoing';
    const sentimentStr = extraction.sentiment.improvement > 0.1 ? 'positive' : 
                         extraction.sentiment.improvement < -0.1 ? 'negative' : 'neutral';

    let summary = `A ${resolutionStr} conversation about ${topicStr}. `;
    
    if (extraction.resolution.resolved) {
      summary += `The issue was resolved in ${extraction.resolution.requiredTurns} turns.`;
    } else {
      summary += `The conversation ended with ${sentimentStr} sentiment.`;
    }

    return summary;
  }

  /**
   * Generate medium summary (3-5 sentences)
   */
  generateMediumSummary(extraction) {
    const parts = [];

    // Opening
    const topics = extraction.topics.slice(0, 4).join(', ') || 'general inquiry';
    parts.push(`Customer contacted about ${topics}.`);

    // Key developments
    if (extraction.agentActions.length > 0) {
      const actions = extraction.agentActions.slice(0, 3).map(a => a.description || a.type);
      parts.push(`Agent ${actions.join(', ')}.`);
    }

    // Escalations
    if (extraction.escalations.length > 0) {
      parts.push(`Escalation occurred: ${extraction.escalations.map(e => e.reason).join(', ')}.`);
    }

    // Resolution
    if (extraction.resolution.resolved) {
      parts.push(`Issue resolved (${extraction.resolution.type}) in ${extraction.resolution.requiredTurns} turns with ${this.describeSentiment(extraction.sentiment.endSentiment)} customer sentiment.`);
    } else {
      parts.push(`Customer sentiment ${this.describeSentiment(extraction.sentiment.endSentiment)}; issue remains unresolved.`);
    }

    // Follow-up
    if (extraction.transfers.length > 0) {
      parts.push(`Transferred to ${extraction.transfers[extraction.transfers.length - 1].to}.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate detailed summary (8+ sentences with sections)
   */
  generateDetailedSummary(extraction) {
    const sections = [];

    // Overview section
    sections.push({
      header: 'Overview',
      items: [
        `Customer contact about: ${extraction.topics.join(', ') || 'general inquiry'}`,
        `Total turns: ${extraction.resolution.requiredTurns}`,
        `Resolution: ${extraction.resolution.resolved ? `Yes (${extraction.resolution.type})` : 'No'}`
      ]
    });

    // Timeline section
    sections.push({
      header: 'Conversation Flow',
      items: [
        `Initial sentiment: ${this.describeSentiment(extraction.sentiment.startSentiment)}`,
        `Final sentiment: ${this.describeSentiment(extraction.sentiment.endSentiment)}`,
        `Sentiment change: ${extraction.sentiment.improvement > 0 ? '+' : ''}${extraction.sentiment.improvement.toFixed(2)}`
      ]
    });

    // Actions section
    if (extraction.agentActions.length > 0) {
      sections.push({
        header: 'Agent Actions',
        items: extraction.agentActions.slice(0, 5).map(a => 
          `- ${a.type}: ${a.description || 'Action performed'}`
        )
      });
    }

    // Escalations section
    if (extraction.escalations.length > 0) {
      sections.push({
        header: 'Escalations',
        items: extraction.escalations.map(e => 
          `- Turn ${e.turn}: ${e.reason}`
        )
      });
    }

    // Key entities section
    if (Object.keys(extraction.entities).length > 0) {
      sections.push({
        header: 'Referenced Items',
        items: Object.entries(extraction.entities).map(([key, values]) => 
          `- ${key}: ${[...new Set(values)].join(', ')}`
        )
      });
    }

    // Recommendations section
    const recommendations = this.generateRecommendations(extraction);
    if (recommendations.length > 0) {
      sections.push({
        header: 'Recommendations',
        items: recommendations.map(r => `- ${r}`)
      });
    }

    // Convert sections to text
    return sections.map(section => 
      `**${section.header}**\n${section.items.join('\n')}`
    ).join('\n\n');
  }

  /**
   * Generate recommendations based on conversation analysis
   */
  generateRecommendations(extraction) {
    const recommendations = [];

    if (!extraction.resolution.resolved) {
      recommendations.push('Follow up with customer to ensure issue resolution');
    }

    if (extraction.sentiment.improvement < -0.2) {
      recommendations.push('Consider sending satisfaction survey and manager callback');
    }

    if (extraction.escalations.length > 1) {
      recommendations.push('Review escalation process - excessive escalations detected');
    }

    if (extraction.resolution.requiredTurns > 10) {
      recommendations.push('Long resolution time - consider knowledge base improvements');
    }

    return recommendations;
  }

  /**
   * Calculate conversation metrics
   */
  calculateConversationMetrics(turns) {
    if (turns.length === 0) return null;

    const metrics = {
      totalTurns: turns.length,
      averageResponseTime: 0,
      toolsUsed: new Set(),
      totalToolCalls: 0,
      firstResponseResolution: false,
      humanEscalation: false
    };

    let totalResponseTime = 0;
    let responseTimeCount = 0;

    for (const turn of turns) {
      // Response time
      if (turn.metadata?.responseTime) {
        totalResponseTime += turn.metadata.responseTime;
        responseTimeCount++;
      }

      // Tools used
      if (turn.metadata?.toolsUsed) {
        turn.metadata.toolsUsed.forEach(tool => metrics.toolsUsed.add(tool));
        metrics.totalToolCalls += turn.metadata.toolsUsed.length;
      }

      // Escalation check
      if (turn.metadata?.escalated || turn.metadata?.transferred) {
        metrics.humanEscalation = true;
      }
    }

    metrics.averageResponseTime = responseTimeCount > 0 ? 
      Math.round(totalResponseTime / responseTimeCount) : 0;
    metrics.firstResponseResolution = turns.length <= 2;
    metrics.toolsUsed = Array.from(metrics.toolsUsed);

    return metrics;
  }

  /**
   * Extract topics from text
   */
  extractTopics(text) {
    const topicPatterns = {
      billing: /bill|payment|charge|invoice|refund|price|cost/i,
      technical: /error|bug|crash|not working|broken|issue|problem/i,
      account: /account|login|password|profile|settings|register/i,
      product: /product|item|feature|specification|model/i,
      shipping: /ship|delivery|tracking|address|package/i,
      returns: /return|refund|exchange|warranty|replacement/i,
      upgrade: /upgrade|downgrade|change plan|subscription/i,
      cancellation: /cancel|terminate|close account|delete/i,
      security: /security|fraud|hacked|unauthorized|suspicious/i
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
   * Extract entities from text
   */
  extractEntities(text) {
    const entities = new Map();

    // Email addresses
    const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emails) entities.set('email', emails);

    // Order IDs
    const orderIds = text.match(/ORD-\d+/gi);
    if (orderIds) entities.set('order_id', orderIds);

    // Product IDs
    const productIds = text.match(/PROD-\d+/gi);
    if (productIds) entities.set('product_id', productIds);

    // Phone numbers
    const phones = text.match(/(\+?\d{1,3}[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}/g);
    if (phones) entities.set('phone', phones);

    // URLs
    const urls = text.match(/https?:\/\/[^\s]+/g);
    if (urls) entities.set('url', urls);

    // Dollar amounts
    const amounts = text.match(/\$\d+(\.\d{2})?/g);
    if (amounts) entities.set('amount', amounts);

    // Dates
    const dates = text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/g);
    if (dates) entities.set('date', dates);

    return entities;
  }

  /**
   * Extract questions from user input
   */
  extractQuestions(text) {
    const questions = [];
    
    // Direct questions (ends with ?)
    const directQuestions = text.match(/[^.!?]*\?/g);
    if (directQuestions) {
      questions.push(...directQuestions.map(q => ({
        type: 'direct',
        question: q.trim(),
        answerable: true
      })));
    }

    // Implicit questions
    const implicitPatterns = [
      { pattern: /I (want|need|would like) to know/i, type: 'implicit' },
      { pattern: /(tell|show|explain|help) me/i, type: 'imperative' },
      { pattern: /I don't (know|understand)/i, type: 'confusion' }
    ];

    for (const { pattern, type } of implicitPatterns) {
      const match = text.match(pattern);
      if (match) {
        const sentence = text.match(new RegExp(`[^.!?]*${match[0]}[^.!?]*`));
        if (sentence) {
          questions.push({
            type,
            question: sentence[0].trim()
          });
        }
      }
    }

    return questions;
  }

  /**
   * Extract agent actions from response
   */
  extractAgentActions(response, metadata) {
    const actions = [];

    // Tool-based actions
    if (metadata?.toolsUsed) {
      metadata.toolsUsed.forEach(tool => {
        actions.push({
          type: 'tool',
          tool,
          description: `Used ${tool} tool`,
          success: metadata.toolSuccess !== false
        });
      });
    }

    // Text-based actions
    const actionPatterns = [
      { pattern: /I (have|'ve) (looked up|searched|found|checked|reviewed)/i, type: 'lookup' },
      { pattern: /I (created|opened|started|initiated)/i, type: 'create' },
      { pattern: /I (updated|modified|changed|edited)/i, type: 'update' },
      { pattern: /I (sent|emailed|notified|contacted)/i, type: 'notify' },
      { pattern: /I (cancelled|canceled|deleted|removed)/i, type: 'cancel' },
      { pattern: /I (escalated|transferred|forwarded)/i, type: 'escalate' }
    ];

    for (const { pattern, type } of actionPatterns) {
      const match = response.match(pattern);
      if (match) {
        actions.push({
          type,
          description: match[0],
          success: true
        });
      }
    }

    return actions;
  }

  /**
   * Simple sentiment analysis
   */
  analyzeSentiment(text) {
    return sharedAnalyzeSentiment(text);
  }

  /**
   * Describe sentiment in words
   */
  describeSentiment(score) {
    return sharedDescribeSentiment(score);
  }

  /**
   * Check if a turn indicates resolution
   */
  isResolved(turn) {
    if (!turn.agentResponse) return false;

    const resolutionPatterns = [
      /has been resolved/i,
      /problem (is|has been) (fixed|solved)/i,
      /issue (is|has been) (fixed|solved|resolved)/i,
      /should (now )?be (working|fixed)/i,
      /all set/i,
      /you('re| are) all set/i,
      /is there anything else/i,
      /glad (I could|to) help/i,
      /have a (great|good|nice) day/i
    ];

    return resolutionPatterns.some(pattern => pattern.test(turn.agentResponse));
  }

  /**
   * Get resolution type
   */
  getResolutionType(turn) {
    const types = {
      self_service: /you can (now |find |access |use )/i,
      agent_fix: /I (have |'ve )(fixed|resolved|updated|changed)/i,
      information: /(here|this|that) (is|should|will) (help|answer|explain)/i,
      escalation: /(escalated|transferred|forwarded)/i,
      workaround: /(workaround|alternative|temporary|for now)/i
    };

    for (const [type, pattern] of Object.entries(types)) {
      if (pattern.test(turn.agentResponse || '')) return type;
    }

    return 'unknown';
  }

  /**
   * Get cache key
   */
  getCacheKey(conversation, options) {
    return `${conversation.id || 'unknown'}:${options.format}:${options.language}`;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.summaryCache.clear();
  }
}

module.exports = { ConversationSummarizer };
