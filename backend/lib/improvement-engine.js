/**
 * Improvement Engine - Self-Improvement Closed Loop
 *
 * The core differentiator of SelfCheck: analyzes evaluation results,
 * identifies persistent failure patterns, and uses Gemini to generate
 * improved system prompts that are automatically applied.
 *
 * This is NOT just "evaluation + reporting" — it actively modifies agent
 * behavior by updating the system prompt based on what it learns.
 */

const { Firestore } = require('@google-cloud/firestore');
const { generateImprovedPrompt } = require('./gemini-client');

// In-memory fallback when Firestore is unavailable (local dev)
let inMemoryCurrentPrompt = null;
let inMemoryStrategies = [];
let inMemoryLastImprovement = null;

let firestore = null;
try {
  firestore = new Firestore();
} catch (e) {
  console.warn('[ImprovementEngine] Firestore unavailable, using in-memory storage');
}

const STRATEGIES_COLLECTION = 'improvement_strategies';
const PROMPT_COLLECTION = 'agent_prompts';

const BASELINE_PROMPT = `You are SelfCheck, a customer service AI assistant. Your goal is to help customers efficiently and accurately.

Core principles:
1. Be helpful and accurate — if you don't know something, say so clearly and offer to find the answer or escalate
2. Be concise but complete — give the customer exactly what they need, no more and no less
3. Show empathy — acknowledge customer frustration when present
4. Verify before acting — confirm order details before processing refunds or changes
5. Suggest next steps — end responses with a relevant follow-up question or action

When handling customer inquiries:
- For product questions: provide clear specs, pricing, and availability
- For order issues: check status first, then suggest appropriate actions
- For technical problems: offer step-by-step troubleshooting
- For complaints: acknowledge the issue, apologize, and present a solution path`;

class ImprovementEngine {
  constructor() {
    this.improvementThreshold = 0.5;    // Trigger improvement when avg score < 0.5
    this.minSamplesForAnalysis = 6;      // Need at least 6 evaluations before analyzing
    this.cooldownMinutes = 30;           // Don't change prompt more than once per 30 min
    this.currentPrompt = null;
    this.promptVersion = 0;
  }

  /**
   * Initialize: load current prompt from storage or use baseline.
   */
  async init() {
    try {
      if (firestore) {
        const doc = await firestore.collection(PROMPT_COLLECTION).doc('active').get();
        if (doc.exists) {
          const data = doc.data();
          this.currentPrompt = data.text;
          this.promptVersion = data.version || 0;
        }
      }
    } catch (e) {
      console.warn('[ImprovementEngine] Could not load prompt from Firestore:', e.message);
    }

    if (!this.currentPrompt) {
      this.currentPrompt = inMemoryCurrentPrompt || BASELINE_PROMPT;
      this.promptVersion = 0;
    }

    console.log(`[ImprovementEngine] Initialized. Prompt v${this.promptVersion}, ${this.currentPrompt.length} chars`);
    return this.currentPrompt;
  }

  /**
   * Get the current active system prompt.
   */
  getCurrentPrompt() {
    return this.currentPrompt || BASELINE_PROMPT;
  }

  /**
   * Analyze recent evaluations and trigger self-improvement if conditions are met.
   * Called periodically (every ~10 conversations) from the webhook handler.
   */
  async analyzeAndImprove(evaluator) {
    const summary = evaluator.getEvaluationSummary();
    const totalEvals = summary.totalEvaluations || 0;

    // Not enough samples
    if (totalEvals < this.minSamplesForAnalysis) {
      return {
        action: 'skip',
        reason: `insufficient_samples (${totalEvals}/${this.minSamplesForAnalysis})`
      };
    }

    // Scores are acceptable
    if (summary.averageScores?.overall > this.improvementThreshold) {
      return {
        action: 'skip',
        reason: 'scores_acceptable',
        score: summary.averageScores.overall
      };
    }

    // Cooldown check
    const now = Date.now();
    const lastChange = await this.getLastImprovementTime();
    if (lastChange && (now - lastChange) < this.cooldownMinutes * 60 * 1000) {
      const remainingMin = Math.round((this.cooldownMinutes * 60 * 1000 - (now - lastChange)) / 60000);
      return {
        action: 'skip',
        reason: `cooldown (${remainingMin} min remaining)`
      };
    }

    // Trigger improvement
    console.log(`[ImprovementEngine] LOW SCORE (${summary.averageScores?.overall}), triggering self-improvement...`);

    try {
      const failurePatterns = summary.failurePatterns || [];
      const suggestions = evaluator.getImprovementSuggestions();

      // Generate improved prompt using Gemini
      const improvedPrompt = await generateImprovedPrompt(
        failurePatterns.map(p => ({
          type: p.type,
          count: p.count,
          examples: p.examples?.slice(-3)
        })),
        this.currentPrompt
      );

      if (!improvedPrompt) {
        return { action: 'error', message: 'Gemini prompt generation returned null' };
      }

      // Save the new prompt
      const previousPrompt = this.currentPrompt;
      this.currentPrompt = improvedPrompt;
      this.promptVersion++;

      // Persist to Firestore (or in-memory)
      if (firestore) {
        try {
          await firestore.collection(PROMPT_COLLECTION).doc('active').set({
            text: improvedPrompt,
            version: this.promptVersion,
            updatedAt: new Date(),
            triggerPatterns: failurePatterns.map(p => p.type),
            previousScore: summary.averageScores?.overall
          });

          await firestore.collection(STRATEGIES_COLLECTION).add({
            type: 'prompt_update',
            previousPromptSummary: previousPrompt.substring(0, 200),
            newPromptSummary: improvedPrompt.substring(0, 200),
            triggerScore: summary.averageScores?.overall,
            failurePatterns: failurePatterns.map(p => ({ type: p.type, count: p.count })),
            suggestions: suggestions.map(s => s.suggestion).slice(0, 5),
            timestamp: new Date(),
            promptVersion: this.promptVersion
          });
        } catch (e) {
          console.warn('[ImprovementEngine] Firestore write failed, using in-memory:', e.message);
        }
      }

      // In-memory backup
      inMemoryCurrentPrompt = improvedPrompt;
      inMemoryStrategies.push({
        version: this.promptVersion,
        timestamp: now,
        triggerScore: summary.averageScores?.overall
      });

      inMemoryLastImprovement = now;

      console.log(`[ImprovementEngine] SELF-IMPROVEMENT APPLIED! v${this.promptVersion}`);
      console.log(`[ImprovementEngine] New prompt length: ${improvedPrompt.length} chars`);
      console.log(`[ImprovementEngine] Triggered by ${failurePatterns.length} failure patterns`);

      return {
        action: 'improved',
        newVersion: this.promptVersion,
        newPromptLength: improvedPrompt.length,
        previousScore: summary.averageScores?.overall,
        patternCount: failurePatterns.length
      };
    } catch (error) {
      console.error('[ImprovementEngine] Improvement failed:', error);
      return { action: 'error', message: error.message };
    }
  }

  /**
   * Get the time of the last improvement (for cooldown).
   */
  async getLastImprovementTime() {
    if (firestore) {
      try {
        const snapshot = await firestore.collection(STRATEGIES_COLLECTION)
          .orderBy('timestamp', 'desc').limit(1).get();
        if (!snapshot.empty) {
          const data = snapshot.docs[0].data();
          return data.timestamp?.toDate?.()?.getTime() || null;
        }
      } catch (e) {
        // Fall through to in-memory
      }
    }
    return inMemoryLastImprovement;
  }

  /**
   * Get improvement history (for dashboard display).
   */
  async getImprovementHistory(limit = 20) {
    if (firestore) {
      try {
        const snapshot = await firestore.collection(STRATEGIES_COLLECTION)
          .orderBy('timestamp', 'desc').limit(limit).get();
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (e) {
        // Fall through to in-memory
      }
    }
    return inMemoryStrategies.slice(-limit);
  }

  /**
   * Get current prompt version.
   */
  getPromptVersion() {
    return this.promptVersion;
  }
}

module.exports = { ImprovementEngine, BASELINE_PROMPT };
