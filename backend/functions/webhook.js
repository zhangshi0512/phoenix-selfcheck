/**
 * SelfCheck Webhook - Phase 2 Enhanced Version
 * Main entry point with all Phase 2 modules integrated:
 * - Enhanced Evaluator (LLM-as-Judge + rule-based scoring)
 * - Knowledge Base (Firestore replacement for mock data)
 * - Conversation Summarizer (multi-turn summary generation)
 * - Monitoring & Alerting (Google Cloud Monitoring)
 * - A/B Testing Framework (experiment management)
 * - Multi-Language Support (detection, translation, localization)
 * - Improvement Engine (self-improvement closed loop)
 */

const functions = require('@google-cloud/functions-framework');
const { Logging } = require('@google-cloud/logging');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

// Phase 2 modules
const { EnhancedEvaluator } = require('../modules/enhanced-evaluator');
const { KnowledgeBase } = require('../modules/knowledge-base');
const { ConversationSummarizer } = require('../modules/conversation-summarizer');
const { MonitoringAlerting } = require('../modules/monitoring-alerting');
const { ABTestingFramework } = require('../modules/ab-testing');
const { MultiLanguageSupport } = require('../modules/multi-language');
const { ImprovementEngine } = require('../lib/improvement-engine');
const { PhoenixIntrospector } = require('../modules/arize-phoenix');

// Initialize modules
const evaluator = new EnhancedEvaluator();
const knowledgeBase = new KnowledgeBase();
const summarizer = new ConversationSummarizer();
const monitoring = new MonitoringAlerting({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  notificationChannels: process.env.ALERT_CHANNELS ?
    process.env.ALERT_CHANNELS.split(',') : []
});
const abTesting = new ABTestingFramework();
const langSupport = new MultiLanguageSupport();
const improvementEngine = new ImprovementEngine();
const phoenixIntrospector = new PhoenixIntrospector();

// Initialize improvement engine
(async () => {
  try {
    await improvementEngine.init();
    console.log(`[SelfCheck] Improvement engine ready (prompt v${improvementEngine.getPromptVersion()})`);
  } catch (e) {
    console.warn('[SelfCheck] Improvement engine init warning:', e.message);
  }
})();

// Log name for Arize Phoenix tracing
const LOG_NAME = 'selfcheck-agent-conversations';

// Initialize logging (lazy — only creates client when GCP credentials are available)
let logging = null;
let loggingDisabled = false;

function isGcpAvailable() {
  // Only use Cloud Logging when GOOGLE_APPLICATION_CREDENTIALS is explicitly set
  // (having GOOGLE_CLOUD_PROJECT alone is not sufficient for ADC)
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

function getLogger() {
  if (loggingDisabled) return null;
  if (!isGcpAvailable()) {
    loggingDisabled = true;
    console.log('[Webhook] Cloud Logging skipped (no GOOGLE_APPLICATION_CREDENTIALS)');
    return null;
  }
  if (!logging) {
    try {
      logging = new Logging();
    } catch (e) {
      console.warn('[Webhook] Cloud Logging unavailable:', e.message);
      loggingDisabled = true;
      return null;
    }
  }
  return logging;
}

// ----- Request Verification -----
function verifyRequest(req) {
  if (req.isSelfCheckLocalProxy) return true;

  const authToken = req.headers['authorization'];
  if (!authToken) {
    // In development, skip auth check
    if (process.env.NODE_ENV === 'development') return true;
    return false;
  }
  return authToken.startsWith('Bearer ') &&
    authToken.substring(7) === process.env.WEBHOOK_API_KEY;
}

// ----- Cloud Logging (Arize Phoenix tracing) -----
async function logConversationTurn(conversationLog) {
  try {
    const logger = getLogger();
    if (!logger) return;
    const log = logger.log(LOG_NAME);
    const metadata = {
      resource: { type: 'global' },
      severity: 'INFO',
      labels: {
        conversation_id: conversationLog.conversationId,
        turn_number: conversationLog.turnNumber?.toString(),
        language: conversationLog.detectedLanguage,
        timestamp: conversationLog.timestamp
      }
    };
    const entry = log.entry(metadata, conversationLog);
    await log.write(entry);
  } catch (err) {
    console.error('Failed to log conversation turn:', err.message);
  }
}

async function logErrorEntry(error, req) {
  try {
    const logger = getLogger();
    if (!logger) return;
    const log = logger.log(LOG_NAME);
    const metadata = {
      resource: { type: 'global' },
      severity: 'ERROR',
      labels: { error_type: error.name || 'Unknown' }
    };
    const entry = log.entry(metadata, {
      error_message: error.message,
      error_stack: error.stack,
      request_path: req.path,
      timestamp: new Date().toISOString()
    });
    await log.write(entry);
  } catch (logErr) {
    console.error('Failed to log error:', logErr.message);
  }
}

// ----- Main Webhook Handler -----
const webhookHandler = async (req, res) => {
  const span = trace.getTracer('webhook').startSpan('handle_request');
  const startTime = Date.now();

  try {
    // Route by path
    const path = req.path || '';

    if (!path.includes('/health') && !verifyRequest(req)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Unauthorized' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (path.includes('/chat'))           return await handleChat(req, res, span, startTime);
    if (path.includes('/feedback'))       return await handleFeedback(req, res);
    if (path.includes('/summarize'))      return await handleSummarize(req, res);
    if (path.includes('/tools/product'))  return await handleProductInfo(req, res);
    if (path.includes('/tools/order'))    return await handleOrderStatus(req, res);
    if (path.includes('/tools/search'))   return await handleSearchFAQ(req, res);
    if (path.includes('/tools/ticket'))   return await handleCreateTicket(req, res);
    if (path.includes('/tools/refund'))   return await handleInitiateRefund(req, res);
    if (path.includes('/experiments'))    return await handleExperiments(req, res);
    if (path.includes('/language'))       return await handleLanguage(req, res);
    if (path.includes('/monitoring'))     return await handleMonitoring(req, res);
    if (path.includes('/improvement'))    return res.json({ history: await improvementEngine.getImprovementHistory(10), currentVersion: improvementEngine.getPromptVersion() });
    if (path.includes('/health'))         return res.json({ status: 'healthy', version: '2.0.0', modules: ['evaluator', 'knowledge', 'summarizer', 'monitoring', 'ab-testing', 'language', 'improvement'] });

    span.setStatus({ code: SpanStatusCode.OK });
    return res.status(404).json({ error: 'Endpoint not found' });

  } catch (error) {
    await logErrorEntry(error, req);
    await monitoring.recordError('webhook_handler', error.message);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

    return res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
      requestId: span.spanContext().traceId
    });
  } finally {
    span.end();
  }
};

// Register for Cloud Functions deployment
functions.http('webhook', webhookHandler);

// ----- Chat Handler (core AI conversation) -----
async function handleChat(req, res, span, startTime) {
  const { session, query, conversation = [], userId, experimentId, language: preferredLang } = req.body;

  if (!query) return res.status(400).json({ error: 'query is required' });

  // Language detection & processing (with timeout)
  let userLang = preferredLang || langSupport.defaultLanguage;
  try {
    const langResult = await withTimeout(
      langSupport.processConversation(conversation, userId),
      3000,
      { userLanguage: userLang, agentLanguage: userLang }
    );
    userLang = langResult.userLanguage || userLang;
  } catch (e) {
    console.warn('Language processing fallback:', e.message);
  }

  // A/B test variant allocation
  let variant = null;
  if (experimentId) {
    variant = abTesting.allocateVariant(experimentId, userId || session);
  }

  // Knowledge base search (with 5s timeout to prevent hanging on cold Firestore)
  let knowledgeResults = await withTimeout(
    knowledgeBase.searchKnowledge(query, {
      maxResults: 5,
      minRelevance: 0.3
    }),
    5000,
    { results: [], suggestedActions: [], totalFound: 0, filteredResults: 0, searchTimeMs: 0 }
  );

  if (knowledgeResults.results.length === 0 && knowledgeBase.demoFallbackEnabled) {
    const demoResults = knowledgeBase.searchDemoKnowledge(query, null, 5)
      .filter(result => (result.relevanceScore || 0) >= 0.3);
    knowledgeResults = {
      query,
      results: demoResults,
      suggestedActions: knowledgeBase.generateSuggestedActions(query, demoResults),
      totalFound: demoResults.length,
      filteredResults: demoResults.length,
      searchTimeMs: 0,
      source: 'demo_fallback'
    };
  }

  // Generate response using current improvement engine prompt as context
  let response = generateResponse(query, knowledgeResults, userLang, improvementEngine.getCurrentPrompt());

  // Apply A/B variant
  if (variant) {
    response = applyVariant(response, variant);
    abTesting.recordMetric(experimentId, userId || session, 'response_generated', 1);
  }

  // Localize response
  let localizedResponse = response;
  try {
    localizedResponse = await langSupport.localizeResponse(response, userLang);
  } catch (e) {
    console.warn('Localization fallback:', e.message);
  }

  // Build turn record
  const turn = {
    session: session || `session-${Date.now()}`,
    userId: userId || `user-${Date.now()}`,
    query,
    response: localizedResponse,
    timestamp: new Date().toISOString(),
    language: userLang,
    variant: variant?.variantId
  };

  // Evaluate response quality (with 8s timeout — Gemini API can be slow)
  const evaluation = await withTimeout(
    evaluator.evaluate(query, localizedResponse, {
      conversationId: session,
      turnNumber: (conversation.length || 0) + 1,
      toolsUsed: ['knowledge_search'],
      toolSuccess: knowledgeResults.results.length > 0
    }),
    8000,
    { scores: { relevance: 0.5, accuracy: 0.5, helpfulness: 0.5, empathy: 0.5, efficiency: 0.5, overall: 0.5, _evaluator: 'timeout' }, metadata: {} }
  );

  // Record metrics (fire-and-forget — don't block response)
  const duration = Date.now() - startTime;
  withTimeout(monitoring.recordEvaluationMetrics(evaluation), 3000, null).catch(() => {});
  withTimeout(monitoring.recordToolMetrics('knowledge_search', true, duration), 3000, null).catch(() => {});
  if (userId) {
    withTimeout(monitoring.recordConversationMetrics({
      id: session,
      userId,
      turns: (conversation.length || 0) + 1,
      duration,
      resolved: isResolved(query, localizedResponse)
    }), 3000, null).catch(() => {});
  }

  // Summarize long conversations
  let summary = null;
  if (conversation.length >= 3) {
    summary = await summarizer.summarize({
      id: session,
      turns: [...conversation, turn]
    }, { format: 'short' });
  }

  // Log for Arize Phoenix
  await logConversationTurn({
    conversationId: session,
    turnNumber: (conversation.length || 0) + 1,
    query,
    response: localizedResponse,
    detectedLanguage: userLang,
    evaluationScore: evaluation.scores.overall,
    timestamp: turn.timestamp
  });

  // Store trace for Phoenix runtime introspection
  phoenixIntrospector.storeLocalTrace({
    session,
    turnNumber: (conversation.length || 0) + 1,
    query,
    response: localizedResponse,
    evaluationScore: evaluation.scores.overall,
    evaluatorType: evaluation.scores._evaluator || 'rule-based'
  });

  span.setAttributes({ 'chat.session': session, 'chat.evaluation_score': evaluation.scores.overall });
  span.setStatus({ code: SpanStatusCode.OK });

  // ----- Self-Improvement: trigger analysis every ~10 conversations -----
  // (runs asynchronously, does not block the response)
  if (evaluator.evaluationHistory.length % 10 === 0) {
    improvementEngine.analyzeAndImprove(evaluator).then(result => {
      if (result.action === 'improved') {
        console.log('[SelfCheck] Self-improvement cycle completed!', {
          version: result.newVersion,
          previousScore: result.previousScore,
          patterns: result.patternCount
        });
      }
    }).catch(err => {
      console.warn('[SelfCheck] Self-improvement cycle error:', err.message);
    });
  }

  return res.json({
    response: localizedResponse,
    evaluation: {
      overallScore: evaluation.scores.overall,
      dimensions: evaluation.scores,
      suggestions: evaluator.getImprovementSuggestions()
    },
    knowledge: {
      resultCount: knowledgeResults.results.length,
      hasAnswer: knowledgeResults.results.length > 0
    },
    language: { detected: userLang },
    summary: summary ? { keyPoints: summary.keyPoints, actionItems: summary.actionItems } : null,
    metadata: {
      session,
      turnNumber: (conversation.length || 0) + 1,
      processingTimeMs: duration,
      variant: variant?.variantId,
      promptVersion: improvementEngine.getPromptVersion(),
      evaluatorType: evaluation.scores._evaluator || 'rule-based',
      phoenixIntrospection: await withTimeout(phoenixIntrospector.getIntrospectionContext(), 3000, { source: 'timeout', message: 'Phoenix introspection skipped' })
    }
  });
}

// ----- User Feedback -----
async function handleFeedback(req, res) {
  const { session, turnNumber, rating, helpful, comment, categories } = req.body;
  if (!session || rating === undefined) return res.status(400).json({ error: 'session and rating are required' });

  const feedback = evaluator.collectUserFeedback(session, turnNumber, { rating, helpful, comment, categories });
  await monitoring.recordFeedbackMetrics(feedback);
  await evaluator.updatePatternsFromFeedback(feedback);

  return res.json({ success: true, feedbackId: feedback.id });
}

// ----- Conversation Summary -----
async function handleSummarize(req, res) {
  const { conversation, format = 'medium' } = req.body;
  if (!conversation?.length) return res.status(400).json({ error: 'conversation array is required' });

  const summary = await summarizer.summarize({ id: `summary-${Date.now()}`, turns: conversation }, { format });
  return res.json(summary);
}

// ----- Product Info (Phase 2: real DB) -----
async function handleProductInfo(req, res) {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id is required' });

  const product = await knowledgeBase.getProductInfo(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  return res.json(product);
}

// ----- Order Status (Phase 2: real DB) -----
async function handleOrderStatus(req, res) {
  const { order_id, email } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id is required' });

  const order = await knowledgeBase.getOrderStatus(order_id, email);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  return res.json(order);
}

// ----- FAQ Search (Phase 2: real DB) -----
async function handleSearchFAQ(req, res) {
  const { query, category, maxResults = 5 } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const results = await knowledgeBase.searchKnowledge(query, { category, maxResults: parseInt(maxResults) });
  return res.json(results);
}

// ----- Create Support Ticket (Phase 2: real DB) -----
async function handleCreateTicket(req, res) {
  const { issue_type, description, priority = 'medium', customer_email } = req.body;
  if (!issue_type || !description) return res.status(400).json({ error: 'issue_type and description are required' });

  const ticket = await knowledgeBase.createSupportTicket({ issueType: issue_type, description, priority, customerEmail: customer_email });
  return res.json(ticket);
}

// ----- Initiate Refund (Phase 2: real DB) -----
async function handleInitiateRefund(req, res) {
  const { order_id, reason, items } = req.body;
  if (!order_id || !reason) return res.status(400).json({ error: 'order_id and reason are required' });

  const refund = await knowledgeBase.initiateRefund({ orderId: order_id, reason, items });
  return res.json(refund);
}

// ----- A/B Testing -----
async function handleExperiments(req, res) {
  const method = req.method;
  const path = req.path;

  if (method === 'POST' && path.includes('start')) {
    // POST /experiments/:id/start
    const id = path.split('/').pop();
    return res.json(abTesting.startExperiment(id));
  }

  if (method === 'GET' && path.includes('results')) {
    // GET /experiments/:id/results
    const id = path.split('/')[2];
    return res.json(abTesting.calculateResults(id));
  }

  if (method === 'GET') {
    return res.json(abTesting.listExperiments());
  }

  if (method === 'POST') {
    const experiment = abTesting.createExperiment(req.body);
    return res.json(experiment);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ----- Language Support -----
async function handleLanguage(req, res) {
  const path = req.path;
  const body = req.body;

  if (path.includes('detect')) {
    if (!body.text) return res.status(400).json({ error: 'text is required' });
    return res.json(await langSupport.detectLanguage(body.text));
  }

  if (path.includes('translate')) {
    if (!body.text || !body.target) return res.status(400).json({ error: 'text and target are required' });
    return res.json(await langSupport.translateText(body.text, body.target, body.source));
  }

  if (path.includes('supported')) {
    return res.json(langSupport.getSupportedLanguages());
  }

  return res.status(404).json({ error: 'Language endpoint not found' });
}

// ----- Monitoring -----
async function handleMonitoring(req, res) {
  const path = req.path;

  if (path.includes('metrics')) {
    return res.json(await monitoring.getMetricsSnapshot());
  }

  if (path.includes('alerts')) {
    return res.json(await monitoring.getAlertStatus());
  }

  return res.status(404).json({ error: 'Monitoring endpoint not found' });
}

// ----- Helpers -----

/**
 * Execute a promise with a timeout. Returns fallback value if it exceeds the limit.
 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => {
      console.warn(`[Webhook] Operation timed out after ${ms}ms`);
      resolve(fallback);
    }, ms))
  ]);
}

function generateResponse(query, knowledgeResults, language, systemPrompt) {
  // Use system prompt as context for response quality (first 150 chars as guidance)
  const promptGuidance = systemPrompt ? systemPrompt.substring(0, 150) : '';
  const prefix = promptGuidance ? `[Guidance: ${promptGuidance}...]\n` : '';

  if (!knowledgeResults.results || !knowledgeResults.results.length) {
    return prefix + langSupport.getLocalizedApology(language) +
      ` I don't have specific information about "${query}". Could you provide more details?`;
  }

  const best = knowledgeResults.results[0];

  if (best.type === 'faq') {
    return `Based on our FAQ: ${best.answer}`;
  } else if (best.type === 'article') {
    return `Here's what I found: ${best.summary || best.content.substring(0, 200)}...`;
  } else if (best.type === 'product') {
    return `${best.product_name}: ${best.description}. Price: $${best.price}. Availability: ${best.availability}.`;
  } else if (best.type === 'order') {
    return `Your order ${best.order_id} is currently ${best.status}. Estimated delivery: ${best.estimated_delivery || 'pending'}.`;
  }

  return `I found information about ${query}: ${JSON.stringify(best).substring(0, 200)}...`;
}

function applyVariant(response, variant) {
  const config = variant.variant?.config || {};

  if (config.tone === 'formal') {
    response = response.replace(/I'm/g, 'I am').replace(/don't/g, 'do not').replace(/can't/g, 'cannot');
  } else if (config.tone === 'casual') {
    response = response.replace(/I am/g, "I'm").replace(/do not/g, "don't").replace(/cannot/g, "can't");
  }

  if (config.length_enforcement === 'short') {
    response = response.substring(0, Math.min(response.length, 120));
  } else if (config.length_enforcement === 'detailed') {
    response += ' For more details, please check our knowledge base.';
  }

  return response;
}

function isResolved(query, response) {
  const indicators = ["I don't know", "I'm not sure", "unable to", "cannot", "no information", "not available"];
  return !indicators.some(i => response.toLowerCase().includes(i.toLowerCase()));
}

module.exports = { webhook: webhookHandler };
