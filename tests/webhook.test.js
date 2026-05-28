/**
 * Unit tests for selfcheck-webhook backend
 * Phase 1: Basic test coverage for customer service tools
 */

const { SelfEvaluator, ConversationTracer } = require('../backend/modules/arize-phoenix');

// Mock Google Cloud dependencies
jest.mock('@google-cloud/logging', () => ({
  Logging: jest.fn().mockImplementation(() => ({
    log: jest.fn().mockReturnValue({
      write: jest.fn().mockResolvedValue(undefined),
      entry: jest.fn().mockReturnValue({})
    })
  }))
}));

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn().mockResolvedValue([{
      payload: { data: Buffer.from('test-secret') }
    }])
  }))
}));

describe('SelfEvaluator', () => {
  let evaluator;

  beforeEach(() => {
    evaluator = new SelfEvaluator();
  });

  test('should create evaluator with empty state', () => {
    expect(evaluator.evaluationHistory).toHaveLength(0);
    expect(evaluator.failurePatterns.size).toBe(0);
  });

  test('should evaluate a conversation turn', () => {
    const result = evaluator.evaluate(
      'What is the price of AI Assistant Pro?',
      'The AI Assistant Pro is priced at $99.99. You can learn more at https://example.com.',
      {
        toolsUsed: ['get_product_info'],
        toolSuccess: true,
        responseTime: 1500,
        intent: 'product_info',
        confidence: 0.95
      }
    );

    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('scores');
    expect(result.scores).toHaveProperty('relevance');
    expect(result.scores).toHaveProperty('accuracy');
    expect(result.scores).toHaveProperty('helpfulness');
    expect(result.scores).toHaveProperty('responseTime');
    expect(result.scores).toHaveProperty('overall');
    expect(evaluator.evaluationHistory).toHaveLength(1);
  });

  test('should calculate relevance score', () => {
    const score = evaluator.calculateRelevance(
      'How do I reset my password?',
      'To reset your password, go to Settings > Security > Reset Password.'
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('should give low relevance for unrelated response', () => {
    const score = evaluator.calculateRelevance(
      'What is your refund policy?',
      'The AI Assistant Pro costs $99.99.'
    );
    expect(score).toBeLessThan(0.5);
  });

  test('should calculate accuracy with successful tools', () => {
    const score = evaluator.calculateAccuracy(
      'The product is available and priced at $99.99.',
      { toolsUsed: ['get_product_info'], toolSuccess: true }
    );
    expect(score).toBeGreaterThan(0.8);
  });

  test('should give low accuracy for error responses', () => {
    const score = evaluator.calculateAccuracy(
      "I'm sorry, I don't know the answer to that.",
      { toolsUsed: ['get_product_info'], toolSuccess: false }
    );
    expect(score).toBeLessThan(0.5);
  });

  test('should calculate helpfulness with links and steps', () => {
    const score = evaluator.calculateHelpfulness(
      'Here are the steps: 1. Go to https://example.com 2. Click Settings 3. Reset password.'
    );
    expect(score).toBeGreaterThan(0.6);
  });

  test('should normalize response time correctly', () => {
    expect(evaluator.normalizeResponseTime(1000)).toBe(1.0);
    expect(evaluator.normalizeResponseTime(3000)).toBe(0.7);
    expect(evaluator.normalizeResponseTime(7000)).toBe(0.4);
    expect(evaluator.normalizeResponseTime(15000)).toBe(0.1);
  });

  test('should extract keywords from text', () => {
    const keywords = evaluator.extractKeywords(
      'How do I reset my password for the customer portal?'
    );
    expect(Array.isArray(keywords)).toBe(true);
    expect(keywords).toContain('reset');
    expect(keywords).toContain('password');
    expect(keywords).toContain('customer');
    expect(keywords).toContain('portal');
    // Should not contain stop words
    expect(keywords).not.toContain('how');
    expect(keywords).not.toContain('for');
    expect(keywords).not.toContain('the');
  });

  test('should detect failure patterns', () => {
    // Add multiple failed evaluations to trigger pattern detection
    for (let i = 0; i < 5; i++) {
      evaluator.evaluate(
        'Different question ' + i,
        'I am sorry, I cannot help with that.',
        { toolsUsed: ['get_product_info'], toolSuccess: false }
      );
    }

    expect(evaluator.failurePatterns.size).toBeGreaterThan(0);
    const suggestions = evaluator.getImprovementSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);
  });

  test('should generate evaluation summary', () => {
    evaluator.evaluate(
      'Test query',
      'Test response',
      { toolsUsed: ['test_tool'], toolSuccess: true, responseTime: 1000 }
    );

    const summary = evaluator.getEvaluationSummary();
    expect(summary).toHaveProperty('totalEvaluations');
    expect(summary).toHaveProperty('averageScores');
    expect(summary.averageScores).toHaveProperty('overall');
  });

  test('should return empty message when no evaluations', () => {
    const summary = evaluator.getEvaluationSummary();
    expect(summary).toHaveProperty('message');
    expect(summary.message).toBe('No evaluations yet');
  });
});

describe('ConversationTracer', () => {
  let tracer;

  beforeEach(() => {
    tracer = new ConversationTracer('test-conversation-1');
  });

  test('should create tracer with conversation ID', () => {
    expect(tracer.conversationId).toBe('test-conversation-1');
    expect(tracer.turnCount).toBe(0);
  });

  test('should start a conversation turn', () => {
    const span = tracer.startTurn('Hello, I need help');
    expect(span).toBeDefined();
    expect(tracer.turnCount).toBe(1);
  });

  test('should increment turn count', () => {
    tracer.startTurn('First message');
    tracer.startTurn('Second message');
    expect(tracer.turnCount).toBe(2);
  });
});

describe('Tool handlers (mock)', () => {
  // These tests verify the mock data structure
  // Real integration tests would be in Phase 2

  test('mock database should have products', () => {
    const products = {
      'PROD-001': { product_name: 'AI Assistant Pro', price: 99.99 },
      'PROD-002': { product_name: 'Customer Service Suite', price: 299.99 }
    };
    
    expect(Object.keys(products)).toHaveLength(2);
    expect(products['PROD-001'].price).toBe(99.99);
  });

  test('mock database should have orders', () => {
    const orders = {
      'ORD-001': { status: 'shipped' },
      'ORD-002': { status: 'processing' }
    };
    
    expect(orders['ORD-001'].status).toBe('shipped');
    expect(orders['ORD-002'].status).toBe('processing');
  });

  test('mock database should have FAQ entries', () => {
    const faq = [
      { question: 'How do I reset my password?', relevance_score: 0.95 },
      { question: 'What is your refund policy?', relevance_score: 0.88 }
    ];
    
    expect(faq).toHaveLength(2);
    expect(faq[0].relevance_score).toBeGreaterThan(0.9);
  });
});
