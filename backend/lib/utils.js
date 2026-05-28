/**
 * Shared Utilities Module
 *
 * Common helper functions used across backend modules.
 * Extracted to eliminate code duplication between:
 *   - backend/modules/arize-phoenix.js
 *   - backend/modules/enhanced-evaluator.js
 *   - backend/modules/knowledge-base.js
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'and', 'or', 'but', 'not', 'no', 'yes', 'this', 'that',
  'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
  'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their',
  'how', 'what', 'when', 'where', 'why', 'who', 'which'
]);

/**
 * Extract meaningful keywords from text, removing stop words and punctuation.
 */
function extractKeywords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Simple sentiment analysis based on keyword counting.
 * Returns a score between -1 (very negative) and 1 (very positive).
 */
function analyzeSentiment(text) {
  if (!text) return 0;

  const positive = [
    'thank', 'great', 'awesome', 'excellent', 'good', 'helpful',
    'perfect', 'love', 'amazing', 'wonderful', 'happy', 'appreciate',
    'fantastic', 'brilliant', 'superb', 'outstanding'
  ];

  const negative = [
    'bad', 'terrible', 'awful', 'horrible', 'worst', 'hate',
    'angry', 'frustrated', 'annoying', 'useless', 'broken',
    'disappointed', 'unacceptable', 'ridiculous', 'stupid', 'wrong'
  ];

  const words = text.toLowerCase().split(/\s+/);
  let score = 0;

  words.forEach(word => {
    if (positive.includes(word)) score += 0.25;
    if (negative.includes(word)) score -= 0.25;
  });

  return Math.max(-1, Math.min(1, score));
}

/**
 * Describe sentiment score in human-readable terms.
 */
function describeSentiment(score) {
  if (score > 0.5) return 'very positive';
  if (score > 0.2) return 'positive';
  if (score > -0.2) return 'neutral';
  if (score > -0.5) return 'negative';
  return 'very negative';
}

module.exports = {
  extractKeywords,
  analyzeSentiment,
  describeSentiment,
  STOP_WORDS
};
