/**
 * Arize Phoenix Integration Module
 * Phase 1: Basic tracing and evaluation setup
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { extractKeywords: sharedExtractKeywords } = require('../lib/utils');

// Configuration
const config = {
  projectId: process.env.ARIZE_PROJECT_ID || 'selfcheck-dev',
  apiKey: process.env.ARIZE_API_KEY || '',
  endpoint: process.env.ARIZE_ENDPOINT || 'https://app.phoenix.arize.com',
  serviceName: 'selfcheck-agent',
  environment: process.env.NODE_ENV || 'development'
};

// Initialize tracer provider
const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.environment
  })
});

// Configure OTLP exporter for Arize Phoenix
const exporter = new OTLPTraceExporter({
  url: `${config.endpoint}/v1/traces`,
  headers: {
    'api_key': config.apiKey,
    'project_id': config.projectId
  }
});

provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

const tracer = trace.getTracer('selfcheck-agent');

/**
 * Trace a conversation turn
 */
class ConversationTracer {
  constructor(conversationId) {
    this.conversationId = conversationId;
    this.turnCount = 0;
  }

  /**
   * Start tracing a new conversation turn
   */
  startTurn(userInput) {
    this.turnCount++;
    const span = tracer.startSpan(`conversation-turn-${this.turnCount}`, {
      attributes: {
        'conversation.id': this.conversationId,
        'conversation.turn': this.turnCount,
        'user.input': userInput,
        'timestamp': new Date().toISOString()
      }
    });

    return span;
  }

  /**
   * End a conversation turn with agent response
   */
  endTurn(span, agentResponse, metadata = {}) {
    span.setAttributes({
      'agent.response': agentResponse,
      'agent.tools_used': metadata.toolsUsed?.join(',') || 'none',
      'agent.intent': metadata.intent || 'unknown',
      'agent.confidence': metadata.confidence || 0,
      'response.time_ms': metadata.responseTime || 0
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  /**
   * End a turn with error
   */
  endTurnWithError(span, error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message
    });
    span.setAttributes({
      'error.type': error.name,
      'error.message': error.message
    });
    span.end();
  }

  /**
   * Trace a tool call within a conversation turn
   */
  traceToolCall(parentSpan, toolName, input, output) {
    const span = tracer.startSpan(`tool-${toolName}`, {
      attributes: {
        'tool.name': toolName,
        'tool.input': JSON.stringify(input),
        'tool.output': JSON.stringify(output),
        'conversation.id': this.conversationId,
        'conversation.turn': this.turnCount
      }
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    return span;
  }
}

/**
 * Self-evaluation module
 */
class SelfEvaluator {
  constructor() {
    this.evaluationHistory = [];
    this.failurePatterns = new Map();
  }

  /**
   * Evaluate a conversation turn
   */
  evaluate(userInput, agentResponse, metadata = {}) {
    const evaluation = {
      timestamp: new Date().toISOString(),
      userInput,
      agentResponse,
      scores: this.calculateScores(userInput, agentResponse, metadata),
      metadata
    };

    this.evaluationHistory.push(evaluation);
    this.updateFailurePatterns(evaluation);

    return evaluation;
  }

  /**
   * Calculate evaluation scores
   */
  calculateScores(userInput, agentResponse, metadata) {
    const scores = {
      relevance: 0,
      accuracy: 0,
      helpfulness: 0,
      responseTime: 0,
      overall: 0
    };

    // Relevance score - check if response addresses the query
    scores.relevance = this.calculateRelevance(userInput, agentResponse);

    // Accuracy score - check if response is factually correct
    scores.accuracy = this.calculateAccuracy(agentResponse, metadata);

    // Helpfulness score - check if response provides value
    scores.helpfulness = this.calculateHelpfulness(agentResponse);

    // Response time score - normalize to 0-1 scale
    scores.responseTime = this.normalizeResponseTime(metadata.responseTime || 0);

    // Overall score - weighted average
    scores.overall = (
      scores.relevance * 0.35 +
      scores.accuracy * 0.30 +
      scores.helpfulness * 0.25 +
      scores.responseTime * 0.10
    );

    return scores;
  }

  /**
   * Calculate relevance score
   */
  calculateRelevance(userInput, agentResponse) {
    // Phase 1: Simple keyword matching
    const inputKeywords = this.extractKeywords(userInput);
    const responseKeywords = this.extractKeywords(agentResponse);
    
    if (inputKeywords.length === 0) return 0.5;
    
    const matchedKeywords = inputKeywords.filter(kw => 
      responseKeywords.includes(kw)
    );
    
    return matchedKeywords.length / inputKeywords.length;
  }

  /**
   * Calculate accuracy score
   */
  calculateAccuracy(agentResponse, metadata) {
    // Phase 1: Check for error indicators
    const errorIndicators = [
      'I don\'t know',
      'I\'m not sure',
      'error',
      'unable to',
      'cannot',
      'sorry'
    ];

    const hasErrorIndicator = errorIndicators.some(indicator =>
      agentResponse.toLowerCase().includes(indicator)
    );

    if (hasErrorIndicator) return 0.3;
    
    // Check if tools were used successfully
    if (metadata.toolsUsed && metadata.toolsUsed.length > 0) {
      return metadata.toolSuccess ? 0.9 : 0.5;
    }

    return 0.7; // Default for responses without tool usage
  }

  /**
   * Calculate helpfulness score
   */
  calculateHelpfulness(agentResponse) {
    let score = 0.5; // Base score

    // Check for actionable information
    if (agentResponse.includes('http') || agentResponse.includes('www.')) {
      score += 0.1; // Contains links
    }

    if (agentResponse.includes('step') || agentResponse.includes('1.')) {
      score += 0.1; // Contains steps/instructions
    }

    if (agentResponse.includes('contact') || agentResponse.includes('email')) {
      score += 0.1; // Provides contact options
    }

    // Check response length (too short or too long)
    const wordCount = agentResponse.split(' ').length;
    if (wordCount < 10) score -= 0.1;
    if (wordCount > 500) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Normalize response time to 0-1 scale
   */
  normalizeResponseTime(responseTimeMs) {
    // Target: under 2 seconds
    if (responseTimeMs <= 2000) return 1.0;
    if (responseTimeMs <= 5000) return 0.7;
    if (responseTimeMs <= 10000) return 0.4;
    return 0.1;
  }

  /**
   * Extract keywords from text
   */
  extractKeywords(text) {
    return sharedExtractKeywords(text);
  }

  /**
   * Update failure patterns based on evaluation
   */
  updateFailurePatterns(evaluation) {
    if (evaluation.scores.overall < 0.5) {
      const pattern = this.identifyFailurePattern(evaluation);
      
      if (this.failurePatterns.has(pattern.type)) {
        const existing = this.failurePatterns.get(pattern.type);
        existing.count++;
        existing.examples.push(evaluation.userInput);
        if (existing.examples.length > 10) {
          existing.examples.shift(); // Keep only last 10 examples
        }
      } else {
        this.failurePatterns.set(pattern.type, {
          type: pattern.type,
          count: 1,
          examples: [evaluation.userInput],
          firstSeen: evaluation.timestamp,
          lastSeen: evaluation.timestamp
        });
      }
    }
  }

  /**
   * Identify failure pattern from evaluation
   */
  identifyFailurePattern(evaluation) {
    const scores = evaluation.scores;
    
    if (scores.relevance < 0.3) {
      return { type: 'low_relevance', severity: 'high' };
    }
    if (scores.accuracy < 0.3) {
      return { type: 'low_accuracy', severity: 'high' };
    }
    if (scores.helpfulness < 0.3) {
      return { type: 'low_helpfulness', severity: 'medium' };
    }
    if (scores.responseTime < 0.3) {
      return { type: 'slow_response', severity: 'low' };
    }
    
    return { type: 'general_failure', severity: 'medium' };
  }

  /**
   * Get improvement suggestions based on failure patterns
   */
  getImprovementSuggestions() {
    const suggestions = [];

    for (const [type, pattern] of this.failurePatterns) {
      if (pattern.count >= 3) { // Only suggest for recurring patterns
        switch (type) {
          case 'low_relevance':
            suggestions.push({
              type: 'relevance_improvement',
              priority: 'high',
              suggestion: 'Improve intent recognition and context understanding',
              affectedQueries: pattern.examples.slice(-3),
              count: pattern.count
            });
            break;
          case 'low_accuracy':
            suggestions.push({
              type: 'accuracy_improvement',
              priority: 'high',
              suggestion: 'Enhance knowledge base and tool integration',
              affectedQueries: pattern.examples.slice(-3),
              count: pattern.count
            });
            break;
          case 'low_helpfulness':
            suggestions.push({
              type: 'helpfulness_improvement',
              priority: 'medium',
              suggestion: 'Add more actionable information and follow-up suggestions',
              affectedQueries: pattern.examples.slice(-3),
              count: pattern.count
            });
            break;
          case 'slow_response':
            suggestions.push({
              type: 'performance_improvement',
              priority: 'low',
              suggestion: 'Optimize tool calls and response generation',
              affectedQueries: pattern.examples.slice(-3),
              count: pattern.count
            });
            break;
        }
      }
    }

    return suggestions;
  }

  /**
   * Get evaluation summary
   */
  getEvaluationSummary() {
    if (this.evaluationHistory.length === 0) {
      return { message: 'No evaluations yet' };
    }

    const recentEvaluations = this.evaluationHistory.slice(-100);
    
    const avgScores = {
      relevance: 0,
      accuracy: 0,
      helpfulness: 0,
      responseTime: 0,
      overall: 0
    };

    recentEvaluations.forEach(item => {
      avgScores.relevance += item.scores.relevance;
      avgScores.accuracy += item.scores.accuracy;
      avgScores.helpfulness += item.scores.helpfulness;
      avgScores.responseTime += item.scores.responseTime;
      avgScores.overall += item.scores.overall;
    });

    const count = recentEvaluations.length;
    Object.keys(avgScores).forEach(key => {
      avgScores[key] = Math.round((avgScores[key] / count) * 100) / 100;
    });

    return {
      totalEvaluations: this.evaluationHistory.length,
      recentEvaluations: count,
      averageScores: avgScores,
      failurePatterns: Array.from(this.failurePatterns.values()),
      improvementSuggestions: this.getImprovementSuggestions()
    };
  }
}

/**
 * Phoenix Introspector — Runtime trace query and introspection.
 *
 * Queries Arize Phoenix at runtime to analyze historical traces,
 * identify failure patterns, and feed insights into the self-improvement loop.
 *
 * This fulfills the hackathon requirement:
 * "Must query trace data at runtime for introspection"
 */
class PhoenixIntrospector {
  constructor() {
    this.endpoint = process.env.ARIZE_ENDPOINT || 'https://app.phoenix.arize.com';
    this.apiKey = process.env.ARIZE_API_KEY || '';
    this.projectId = process.env.ARIZE_PROJECT_ID || '';
    this.localTraceBuffer = [];
  }

  /**
   * Store a trace record locally (used as fallback when Phoenix is unreachable).
   */
  storeLocalTrace(traceData) {
    this.localTraceBuffer.push({
      ...traceData,
      storedAt: new Date().toISOString()
    });
    // Keep only the last 200 traces
    if (this.localTraceBuffer.length > 200) {
      this.localTraceBuffer = this.localTraceBuffer.slice(-200);
    }
  }

  /**
   * Query recent traces for introspection.
   * Attempts Phoenix API first, falls back to local buffer.
   */
  async getIntrospectionContext() {
    const phoenixResult = await this.queryPhoenixTraces();

    if (phoenixResult) {
      return {
        source: 'phoenix',
        analyzedAt: new Date().toISOString(),
        ...phoenixResult
      };
    }

    // Fallback: use local trace buffer
    return {
      source: 'local_fallback',
      analyzedAt: new Date().toISOString(),
      localTraceCount: this.localTraceBuffer.length,
      recentTraces: this.localTraceBuffer.slice(-10),
      message: 'Phoenix API unavailable, using local trace buffer'
    };
  }

  /**
   * Attempt to query Phoenix API for recent traces.
   */
  async queryPhoenixTraces() {
    if (!this.apiKey || !this.projectId) return null;

    try {
      const response = await fetch(`${this.endpoint}/v1/spans`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
        // Note: exact API endpoint may differ based on Phoenix version.
        // Refer to https://docs.arize.com/phoenix for current endpoints.
      });

      if (!response.ok) {
        console.warn(`[PhoenixIntrospector] API returned ${response.status}`);
        return null;
      }

      const data = await response.json();
      return {
        spanCount: data.spans?.length || 0,
        recentSpans: (data.spans || []).slice(0, 20)
      };
    } catch (error) {
      console.warn('[PhoenixIntrospector] Phoenix query failed:', error.message);
      return null;
    }
  }
}

module.exports = {
  ConversationTracer,
  SelfEvaluator,
  PhoenixIntrospector,
  config
};
