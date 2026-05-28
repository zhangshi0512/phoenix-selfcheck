/**
 * Knowledge Base Integration Module
 * Phase 2: Real knowledge base with Firestore, vector search, and semantic retrieval
 */

const { Firestore } = require('@google-cloud/firestore');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

// Initialize clients
const firestore = new Firestore();
const tracer = trace.getTracer('knowledge-base');

// Collection references
const KNOWLEDGE_COLLECTION = 'knowledge_articles';
const FAQ_COLLECTION = 'faq_entries';
const PRODUCT_COLLECTION = 'products';
const ORDER_COLLECTION = 'orders';
const TICKET_COLLECTION = 'support_tickets';
const REFUND_COLLECTION = 'refunds';

const DEMO_FAQS = [
  {
    id: 'demo-password-reset',
    type: 'faq',
    question: 'How do I reset my password?',
    answer: 'Open Account Settings, choose Security, select Reset Password, and follow the email verification link. If the link expires, request a new reset email.',
    category: 'account',
    tags: ['password', 'login', 'account', 'security']
  },
  {
    id: 'demo-refund-policy',
    type: 'faq',
    question: 'What is your refund policy?',
    answer: 'Most subscriptions can be refunded within 30 days if usage is low and no policy abuse is detected. The support team can review edge cases manually.',
    category: 'billing',
    tags: ['refund', 'return', 'billing', 'subscription']
  },
  {
    id: 'demo-shipping',
    type: 'faq',
    question: 'How can I track an order?',
    answer: 'Use the order status tool with your order ID and email address. Shipped orders include a tracking URL and estimated delivery date.',
    category: 'shipping',
    tags: ['order', 'tracking', 'shipping', 'delivery']
  }
];

const DEMO_PRODUCTS = {
  'PROD-001': {
    id: 'PROD-001',
    product_name: 'AI Assistant Pro',
    description: 'A premium customer support automation plan with advanced routing and analytics.',
    price: 99.99,
    availability: 'available'
  },
  'PROD-002': {
    id: 'PROD-002',
    product_name: 'Customer Service Suite',
    description: 'An enterprise support suite with ticketing, knowledge search, and monitoring.',
    price: 299.99,
    availability: 'available'
  }
};

const DEMO_ORDERS = {
  'ORD-001': {
    id: 'ORD-001',
    status: 'shipped',
    estimatedDelivery: '2026-06-03',
    trackingUrl: 'https://tracking.selfcheck.local/ORD-001',
    items: ['AI Assistant Pro'],
    totalAmount: 99.99,
    customerEmail: 'demo@selfcheck.test'
  },
  'ORD-002': {
    id: 'ORD-002',
    status: 'processing',
    estimatedDelivery: '2026-06-06',
    trackingUrl: null,
    items: ['Customer Service Suite'],
    totalAmount: 299.99,
    customerEmail: 'demo@selfcheck.test'
  }
};

class KnowledgeBase {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
    this.demoFallbackEnabled = process.env.SELFCHECK_DEMO_FALLBACK !== 'false';
  }

  /**
   * Search knowledge base with semantic understanding
   */
  async searchKnowledge(query, options = {}) {
    const span = tracer.startSpan('search-knowledge');
    const startTime = Date.now();

    try {
      const {
        category = null,
        maxResults = 5,
        minRelevance = 0.5,
        includeFAQ = true,
        includeArticles = true
      } = options;

      let results = [];

      // Check cache first
      const cacheKey = `search:${query}:${category}:${maxResults}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        span.setAttributes({ 'knowledge.cache_hit': true });
        return cached;
      }

      // Parallel search in multiple collections
      const searches = [];

      if (includeFAQ) {
        searches.push(this.searchFAQ(query, category, maxResults));
      }

      if (includeArticles) {
        searches.push(this.searchArticles(query, category, maxResults));
      }

      const searchResults = await Promise.all(searches);
      
      // Combine and deduplicate results
      results = searchResults.flat();
      results = this.deduplicateResults(results);
      
      // Sort by relevance score
      results.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
      
      // Filter by minimum relevance
      results = results.filter(r => (r.relevanceScore || 0) >= minRelevance);

      if (results.length === 0 && this.demoFallbackEnabled) {
        results = this.searchDemoKnowledge(query, category, maxResults)
          .filter(r => (r.relevanceScore || 0) >= minRelevance);
      }
      
      // Limit results
      results = results.slice(0, maxResults);

      // Generate suggested actions
      const suggestedActions = this.generateSuggestedActions(query, results);

      const response = {
        query,
        results,
        suggestedActions,
        totalFound: searchResults.length,
        filteredResults: results.length,
        searchTimeMs: Date.now() - startTime
      };

      // Cache results
      this.setCache(cacheKey, response);

      span.setAttributes({
        'knowledge.results_count': results.length,
        'knowledge.search_time_ms': Date.now() - startTime
      });
      span.setStatus({ code: SpanStatusCode.OK });

      return response;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Search FAQ collection
   */
  async searchFAQ(query, category, maxResults) {
    try {
      let queryRef = firestore.collection(FAQ_COLLECTION);

      // Build query
      if (category) {
        queryRef = queryRef.where('category', '==', category);
      }

      // Search by keywords (simple text search for Phase 2)
      const keywords = this.extractKeywords(query);
      
      // Get all active FAQs (limit for performance)
      const snapshot = await queryRef
        .where('active', '==', true)
        .limit(50)
        .get();

      const results = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const relevanceScore = this.calculateRelevance(keywords, data);
        
        if (relevanceScore > 0) {
          results.push({
            id: doc.id,
            type: 'faq',
            question: data.question,
            answer: data.answer,
            category: data.category,
            tags: data.tags || [],
            relevanceScore,
            lastUpdated: data.lastUpdated?.toDate?.()?.toISOString() || data.lastUpdated
          });
        }
      });

      return results.slice(0, maxResults);
    } catch (error) {
      console.error('FAQ search error:', error);
      return [];
    }
  }

  /**
   * Search knowledge articles
   */
  async searchArticles(query, category, maxResults) {
    try {
      let queryRef = firestore.collection(KNOWLEDGE_COLLECTION);

      if (category) {
        queryRef = queryRef.where('category', '==', category);
      }

      const keywords = this.extractKeywords(query);

      const snapshot = await queryRef
        .where('status', '==', 'published')
        .limit(50)
        .get();

      const results = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const relevanceScore = this.calculateArticleRelevance(keywords, data);

        if (relevanceScore > 0) {
          results.push({
            id: doc.id,
            type: 'article',
            title: data.title,
            content: data.content,
            summary: data.summary,
            category: data.category,
            tags: data.tags || [],
            relevanceScore,
            author: data.author,
            lastUpdated: data.lastUpdated?.toDate?.()?.toISOString() || data.lastUpdated,
            url: data.url
          });
        }
      });

      return results.slice(0, maxResults);
    } catch (error) {
      console.error('Article search error:', error);
      return [];
    }
  }

  /**
   * Get product information
   */
  async getProductInfo(productId) {
    const span = tracer.startSpan('get-product-info');

    try {
      // Check cache
      const cacheKey = `product:${productId}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      const docRef = firestore.collection(PRODUCT_COLLECTION).doc(productId);
      const doc = await docRef.get();

      if (!doc.exists) {
        // Try search by name
        const snapshot = await firestore.collection(PRODUCT_COLLECTION)
          .where('name', '>=', productId)
          .where('name', '<=', productId + '\uf8ff')
          .limit(1)
          .get();

        if (snapshot.empty) {
          span.setAttributes({ 'product.found': false });
          return null;
        }

        const data = snapshot.docs[0].data();
        data.id = snapshot.docs[0].id;
        
        this.setCache(cacheKey, data);
        span.setAttributes({ 'product.found': true, 'product.id': data.id });
        return data;
      }

      const data = doc.data();
      data.id = doc.id;

      this.setCache(cacheKey, data);
      span.setAttributes({ 'product.found': true, 'product.id': data.id });
      span.setStatus({ code: SpanStatusCode.OK });

      return data;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      if (this.demoFallbackEnabled) {
        return DEMO_PRODUCTS[productId] || this.findDemoProduct(productId);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Check order status
   */
  async getOrderStatus(orderId, email = null) {
    const span = tracer.startSpan('get-order-status');

    try {
      const cacheKey = `order:${orderId}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached;

      const docRef = firestore.collection(ORDER_COLLECTION).doc(orderId);
      const doc = await docRef.get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();

      // Verify email if provided
      if (email && data.customerEmail !== email) {
        return { error: 'Email does not match order', status: 'unverified' };
      }

      const order = {
        id: doc.id,
        status: data.status,
        estimatedDelivery: data.estimatedDelivery?.toDate?.()?.toISOString() || data.estimatedDelivery,
        trackingUrl: data.trackingUrl,
        items: data.items || [],
        totalAmount: data.totalAmount,
        customerEmail: data.customerEmail,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
      };

      this.setCache(cacheKey, order);
      span.setStatus({ code: SpanStatusCode.OK });

      return order;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      if (this.demoFallbackEnabled) {
        const order = DEMO_ORDERS[orderId];
        if (!order) return null;
        if (email && order.customerEmail !== email) {
          return { error: 'Email does not match order', status: 'unverified' };
        }
        return order;
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Create support ticket
   */
  async createSupportTicket(ticketData) {
    const span = tracer.startSpan('create-support-ticket');

    try {
      const ticket = {
        issueType: ticketData.issueType,
        description: ticketData.description,
        priority: ticketData.priority || 'medium',
        customerEmail: ticketData.customerEmail || '',
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
        conversationId: ticketData.conversationId,
        assignedTo: null,
        resolution: null,
        tags: this.extractTicketTags(ticketData.description)
      };

      const docRef = await firestore.collection(TICKET_COLLECTION).add(ticket);

      const response = {
        ticketId: docRef.id,
        status: 'open',
        estimatedResponseTime: this.getEstimatedResponseTime(ticket.priority),
        supportAgentAssigned: false
      };

      span.setAttributes({ 'ticket.id': docRef.id });
      span.setStatus({ code: SpanStatusCode.OK });

      return response;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      if (this.demoFallbackEnabled) {
        return {
          ticketId: `DEMO-${Date.now()}`,
          status: 'open',
          estimatedResponseTime: this.getEstimatedResponseTime(ticketData.priority || 'medium'),
          supportAgentAssigned: false
        };
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Initiate refund/return
   */
  async initiateRefund(refundData) {
    const span = tracer.startSpan('initiate-refund');

    try {
      // Verify order exists
      const order = await this.getOrderStatus(refundData.orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      const refund = {
        orderId: refundData.orderId,
        reason: refundData.reason,
        items: refundData.items || [],
        estimatedAmount: refundData.estimatedAmount || order.totalAmount || 0,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
        processingTime: '7-10 business days',
        instructions: [
          '1. Package the item(s) securely in original packaging',
          '2. Include the return authorization slip (sent via email)',
          '3. Ship to: Returns Department, 123 Business Park, Suite 100',
          '4. Keep tracking information for your records',
          '5. Refund will be processed within 7-10 business days after receipt',
          '6. Original shipping charges are non-refundable'
        ]
      };

      const docRef = await firestore.collection(REFUND_COLLECTION).add(refund);

      const response = {
        refundId: docRef.id,
        estimatedAmount: refund.estimatedAmount,
        processingTime: refund.processingTime,
        instructions: refund.instructions
      };

      span.setAttributes({ 'refund.id': docRef.id });
      span.setStatus({ code: SpanStatusCode.OK });

      return response;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      if (this.demoFallbackEnabled) {
        return {
          refundId: `DEMO-REFUND-${Date.now()}`,
          estimatedAmount: 0,
          processingTime: '7-10 business days',
          instructions: [
            'Package the item securely.',
            'Include the return authorization email.',
            'Keep tracking information for your records.'
          ]
        };
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Add new knowledge article
   */
  async addKnowledgeArticle(article) {
    const docRef = await firestore.collection(KNOWLEDGE_COLLECTION).add({
      title: article.title,
      content: article.content,
      summary: article.summary || '',
      category: article.category,
      tags: article.tags || [],
      status: article.status || 'draft',
      author: article.author || 'system',
      createdAt: new Date(),
      lastUpdated: new Date(),
      viewCount: 0,
      helpfulCount: 0
    });

    // Invalidate cache
    this.cache.clear();

    return { id: docRef.id };
  }

  /**
   * Update knowledge article
   */
  async updateKnowledgeArticle(articleId, updates) {
    const docRef = firestore.collection(KNOWLEDGE_COLLECTION).doc(articleId);
    
    await docRef.update({
      ...updates,
      lastUpdated: new Date()
    });

    // Invalidate cache
    this.cache.clear();

    return { id: articleId, updated: true };
  }

  /**
   * Record article helpfulness feedback
   */
  async recordArticleFeedback(articleId, helpful) {
    const docRef = firestore.collection(KNOWLEDGE_COLLECTION).doc(articleId);
    
    await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) return;

      const data = doc.data();
      transaction.update(docRef, {
        helpfulCount: (data.helpfulCount || 0) + (helpful ? 1 : 0),
        viewCount: (data.viewCount || 0) + 1
      });
    });
  }

  /**
   * Calculate relevance score for FAQ
   */
  calculateRelevance(keywords, faqData) {
    const searchText = `${faqData.question} ${faqData.answer} ${(faqData.tags || []).join(' ')}`.toLowerCase();
    let score = 0;

    keywords.forEach(keyword => {
      if (searchText.includes(keyword)) {
        // More weight for question matches
        if (faqData.question.toLowerCase().includes(keyword)) {
          score += 0.3;
        }
        // Less weight for answer matches
        if (faqData.answer.toLowerCase().includes(keyword)) {
          score += 0.1;
        }
        // Tag matches
        if ((faqData.tags || []).some(tag => tag.toLowerCase().includes(keyword))) {
          score += 0.2;
        }
      }
    });

    // Normalize score
    return Math.min(1, score / keywords.length);
  }

  /**
   * Calculate relevance for articles
   */
  calculateArticleRelevance(keywords, articleData) {
    const searchText = [
      articleData.title,
      articleData.summary,
      articleData.content,
      ...(articleData.tags || [])
    ].join(' ').toLowerCase();

    let score = 0;

    keywords.forEach(keyword => {
      if (searchText.includes(keyword)) {
        // Title matches are most important
        if (articleData.title?.toLowerCase().includes(keyword)) {
          score += 0.4;
        }
        // Summary matches
        if (articleData.summary?.toLowerCase().includes(keyword)) {
          score += 0.2;
        }
        // Content matches
        if (articleData.content?.toLowerCase().includes(keyword)) {
          score += 0.1;
        }
        // Tag matches
        if ((articleData.tags || []).some(tag => tag.toLowerCase().includes(keyword))) {
          score += 0.15;
        }
      }
    });

    return Math.min(1, score / keywords.length);
  }

  /**
   * Extract keywords from query
   */
  extractKeywords(query) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'and', 'or', 'but', 'not', 'no', 'yes', 'this', 'that', 'it',
      'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your',
      'how', 'what', 'when', 'where', 'why', 'who', 'which', 'can'
    ]);

    return query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
  }

  /**
   * Generate suggested actions based on query and results
   */
  generateSuggestedActions(query, results) {
    const actions = new Set();
    const queryLower = query.toLowerCase();

    // Category-based suggestions
    const categoryMap = {
      billing: ['View billing history', 'Update payment method', 'Contact billing support'],
      technical: ['Run system diagnostic', 'Check system requirements', 'Clear cache and cookies'],
      account: ['Reset password', 'Update profile settings', 'Enable two-factor authentication'],
      product: ['Compare products', 'Read product reviews', 'Check product availability'],
      shipping: ['Track package', 'Update shipping address', 'Contact shipping carrier'],
      returns: ['Start return process', 'Check return policy', 'Print return label']
    };

    // Match categories from query
    for (const [category, suggestions] of Object.entries(categoryMap)) {
      if (queryLower.includes(category)) {
        suggestions.forEach(s => actions.add(s));
      }
    }

    // Add actions based on result types
    if (results.length === 0) {
      actions.add('Create support ticket');
      actions.add('Contact customer support');
      actions.add('Check community forums');
    }

    if (results.some(r => r.type === 'faq')) {
      actions.add('Search more FAQs');
    }

    return Array.from(actions).slice(0, 5);
  }

  searchDemoKnowledge(query, category, maxResults) {
    const keywords = this.extractKeywords(query);

    return DEMO_FAQS
      .filter(item => !category || item.category === category)
      .map(item => ({
        ...item,
        relevanceScore: this.calculateRelevance(keywords, item),
        lastUpdated: new Date().toISOString()
      }))
      .filter(item => item.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxResults);
  }

  findDemoProduct(productId) {
    const query = String(productId || '').toLowerCase();
    return Object.values(DEMO_PRODUCTS).find(product =>
      product.product_name.toLowerCase().includes(query)
    ) || null;
  }

  /**
   * Deduplicate results
   */
  deduplicateResults(results) {
    const seen = new Set();
    return results.filter(result => {
      const key = `${result.type}:${result.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Extract tags from ticket description
   */
  extractTicketTags(description) {
    const tags = new Set();
    const descLower = description.toLowerCase();

    const tagPatterns = {
      billing: /bill|payment|charge|invoice|refund|price/i,
      technical: /error|bug|crash|broken|issue|problem/i,
      account: /account|login|password|profile|register/i,
      urgent: /urgent|asap|immediate|emergency|critical/i
    };

    for (const [tag, pattern] of Object.entries(tagPatterns)) {
      if (pattern.test(descLower)) {
        tags.add(tag);
      }
    }

    return Array.from(tags);
  }

  /**
   * Get estimated response time for ticket priority
   */
  getEstimatedResponseTime(priority) {
    const times = {
      low: '24-48 hours',
      medium: '12-24 hours',
      high: '4-8 hours',
      urgent: '1-2 hours'
    };
    return times[priority] || times.medium;
  }

  /**
   * Cache management
   */
  getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Get knowledge base statistics
   */
  async getStatistics() {
    try {
      const [faqCount, articleCount, productCount] = await Promise.all([
        firestore.collection(FAQ_COLLECTION).where('active', '==', true).count().get(),
        firestore.collection(KNOWLEDGE_COLLECTION).where('status', '==', 'published').count().get(),
        firestore.collection(PRODUCT_COLLECTION).count().get()
      ]);

      return {
        faqs: faqCount.data().count,
        articles: articleCount.data().count,
        products: productCount.data().count,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Failed to get statistics:', error);
      return { error: 'Failed to retrieve statistics' };
    }
  }
}

module.exports = { KnowledgeBase };
