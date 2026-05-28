/**
 * Gemini AI Client
 *
 * Provides LLM-as-Judge evaluation and prompt improvement generation
 * using the @google/genai SDK (v2.x).
 *
 * Used by:
 *   - enhanced-evaluator.js (LLM-as-Judge fallback)
 *   - improvement-engine.js (prompt generation)
 */

const { GoogleGenAI } = require('@google/genai');

// Initialize client once
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
});

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Use Gemini as LLM-as-Judge to evaluate a single conversation turn.
 *
 * Returns structured scores for relevance, accuracy, helpfulness,
 * empathy, and efficiency. Falls back to null if evaluation fails.
 */
async function evaluateWithLLM(userInput, agentResponse, context = {}) {
  if (!userInput || !agentResponse) return null;

  const prompt = `You are an AI quality evaluator. Score the following customer service interaction.

User query: "${userInput}"
Agent response: "${agentResponse}"
${context.conversationHistory ? `Previous conversation turns: ${JSON.stringify(context.conversationHistory.slice(-3))}` : ''}

Evaluate these dimensions on a scale of 0.0 to 1.0.
Return ONLY a JSON object with no markdown, no explanation outside the JSON:

{
  "relevance": 0.0,
  "accuracy": 0.0,
  "helpfulness": 0.0,
  "empathy": 0.0,
  "efficiency": 0.0,
  "overall": 0.0,
  "failure_type": "none",
  "improvement_hint": ""
}

failure_type must be one of: "none", "low_relevance", "low_accuracy", "low_helpfulness", "low_empathy", "hallucination", "incomplete"
improvement_hint should be a concise sentence on how to improve.`;

  try {
    const response = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    });

    const text = response.text;
    if (!text) return null;

    // Clean potential markdown wrapping
    const jsonStr = text.replace(/```json\s*\n?|```\s*\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    // Validate structure
    if (result.relevance === undefined) return null;
    return result;
  } catch (error) {
    console.warn('[GeminiClient] LLM-as-Judge evaluation failed:', error.message);
    return null;
  }
}

/**
 * Generate an improved system prompt based on detected failure patterns.
 */
async function generateImprovedPrompt(failurePatterns, currentPrompt) {
  if (!failurePatterns || failurePatterns.length === 0) return null;

  const prompt = `You are an AI prompt engineer. A customer service AI agent has the following failure patterns:

${JSON.stringify(failurePatterns.map(p => ({
  type: p.type,
  count: p.count || 0,
  examples: (p.examples || []).slice(0, 3)
})), null, 2)}

Current system prompt:
"""
${currentPrompt}
"""

Generate an improved system prompt that:
1. Addresses the specific failure patterns
2. Maintains a helpful, professional tone
3. Is concise but comprehensive (max 500 words)
4. Includes guidelines to avoid the detected failures

Return ONLY the new prompt text. No markdown, no explanation.`;

  try {
    const response = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 1000
      }
    });

    const text = response.text;
    if (!text) return null;

    return text.trim();
  } catch (error) {
    console.warn('[GeminiClient] Prompt improvement generation failed:', error.message);
    return null;
  }
}

module.exports = { evaluateWithLLM, generateImprovedPrompt };
