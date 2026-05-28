/**
 * A/B Testing Framework
 * Phase 2: Experiment management, traffic splitting, and statistical analysis
 */

class ABTestingFramework {
  constructor(options = {}) {
    this.experiments = new Map();
    this.allocations = new Map();
    this.results = new Map();
    this.defaultSplit = options.defaultSplit || { control: 0.5, treatment: 0.5 };
    this.minSampleSize = options.minSampleSize || 100;
    this.confidenceLevel = options.confidenceLevel || 0.95;
  }

  /**
   * Create a new A/B test experiment
   */
  createExperiment(config) {
    const {
      name,
      description = '',
      variants,
      metrics = [],
      split = this.defaultSplit,
      minSampleSize = this.minSampleSize,
      duration = '7d',
      targetMetrics = {}
    } = config;

    const experiment = {
      id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      name,
      description,
      status: 'draft',
      variants: variants.map((v, i) => ({
        id: `variant-${i}`,
        name: v.name || `Variant ${i + 1}`,
        config: v.config,
        description: v.description || '',
        isControl: v.isControl || (i === 0)
      })),
      metrics,
      split,
      minSampleSize,
      duration,
      targetMetrics,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      sampleSize: 0,
      allocations: {}
    };

    this.experiments.set(experiment.id, experiment);
    this.allocations.set(experiment.id, {});
    this.results.set(experiment.id, {});

    return experiment;
  }

  /**
   * Start an experiment
   */
  startExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    experiment.status = 'running';
    experiment.startedAt = new Date().toISOString();

    return experiment;
  }

  /**
   * Stop an experiment
   */
  stopExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    experiment.status = 'completed';
    experiment.endedAt = new Date().toISOString();

    // Calculate final results
    const results = this.calculateResults(experimentId);
    this.results.set(experimentId, results);

    return { experiment, results };
  }

  /**
   * Pause an experiment
   */
  pauseExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    if (experiment.status !== 'running') {
      throw new Error(`Experiment ${experimentId} is not running`);
    }

    experiment.status = 'paused';
    return experiment;
  }

  /**
   * Resume an experiment
   */
  resumeExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    if (experiment.status !== 'paused') {
      throw new Error(`Experiment ${experimentId} is not paused`);
    }

    experiment.status = 'running';
    return experiment;
  }

  /**
   * Allocate a user/request to a variant
   */
  allocateVariant(experimentId, requestId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || experiment.status !== 'running') {
      return null;
    }

    // Check existing allocation
    const allocations = this.allocations.get(experimentId);
    if (allocations[requestId]) {
      return allocations[requestId];
    }

    // Deterministic allocation based on request ID
    const hash = this.hashString(`${experimentId}:${requestId}`);
    let cumulative = 0;
    const variantKeys = Object.keys(experiment.split);

    for (let i = 0; i < variantKeys.length; i++) {
      cumulative += experiment.split[variantKeys[i]];
      if (hash <= cumulative) {
        const variant = experiment.variants.find(v => v.id === variantKeys[i]);
        
        // Store allocation
        allocations[requestId] = {
          variantId: variantKeys[i],
          variant,
          allocatedAt: new Date().toISOString()
        };

        experiment.sampleSize++;
        return allocations[requestId];
      }
    }

    // Fallback to last variant
    const lastKey = variantKeys[variantKeys.length - 1];
    const lastVariant = experiment.variants.find(v => v.id === lastKey);
    
    allocations[requestId] = {
      variantId: lastKey,
      variant: lastVariant,
      allocatedAt: new Date().toISOString()
    };

    experiment.sampleSize++;
    return allocations[requestId];
  }

  /**
   * Record a metric for an experiment
   */
  recordMetric(experimentId, requestId, metricName, value) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || experiment.status !== 'running') return;

    const allocation = this.allocations.get(experimentId)?.[requestId];
    if (!allocation) return;

    const results = this.results.get(experimentId);
    
    if (!results[allocation.variantId]) {
      results[allocation.variantId] = {};
    }
    
    if (!results[allocation.variantId][metricName]) {
      results[allocation.variantId][metricName] = [];
    }

    results[allocation.variantId][metricName].push({
      value,
      requestId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Calculate experiment results with statistical analysis
   */
  calculateResults(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    const rawResults = this.results.get(experimentId);
    const analysis = {
      experimentId,
      experimentName: experiment.name,
      status: experiment.status,
      sampleSize: experiment.sampleSize,
      variantResults: {},
      winner: null,
      confidence: {},
      recommendations: []
    };

    // Find control variant
    const controlVariant = experiment.variants.find(v => v.isControl);
    
    // Calculate per-variant statistics
    for (const variant of experiment.variants) {
      const variantData = rawResults[variant.id] || {};
      const variantStats = {
        variantId: variant.id,
        variantName: variant.name,
        isControl: variant.isControl,
        sampleSize: 0,
        metrics: {}
      };

      for (const [metric, values] of Object.entries(variantData)) {
        variantStats.sampleSize = Math.max(variantStats.sampleSize, values.length);
        
        const numericValues = values.map(v => v.value).filter(v => typeof v === 'number');
        
        if (numericValues.length > 0) {
          variantStats.metrics[metric] = {
            mean: this.calculateMean(numericValues),
            median: this.calculateMedian(numericValues),
            stdDev: this.calculateStdDev(numericValues),
            min: Math.min(...numericValues),
            max: Math.max(...numericValues),
            count: numericValues.length
          };

          // Statistical comparison with control
          if (!variant.isControl && controlVariant && variantData[metric]) {
            const controlValues = (rawResults[controlVariant.id]?.[metric] || [])
              .map(v => v.value)
              .filter(v => typeof v === 'number');

            if (controlValues.length >= this.minSampleSize && numericValues.length >= this.minSampleSize) {
              const comparison = this.compareVariants(controlValues, numericValues);
              variantStats.metrics[metric].vsControl = comparison;
            }
          }
        }
      }

      analysis.variantResults[variant.id] = variantStats;
    }

    // Determine winner
    analysis.winner = this.determineWinner(analysis.variantResults, controlVariant?.id);

    // Generate recommendations
    analysis.recommendations = this.generateExperimentRecommendations(analysis, experiment);

    return analysis;
  }

  /**
   * Compare two variants statistically
   */
  compareVariants(controlValues, treatmentValues) {
    const controlMean = this.calculateMean(controlValues);
    const treatmentMean = this.calculateMean(treatmentValues);
    const controlStdDev = this.calculateStdDev(controlValues);
    const treatmentStdDev = this.calculateStdDev(treatmentValues);

    const lift = controlMean !== 0 ? ((treatmentMean - controlMean) / controlMean) * 100 : 0;
    
    // Welch's t-test
    const n1 = controlValues.length;
    const n2 = treatmentValues.length;
    const se = Math.sqrt((controlStdDev ** 2 / n1) + (treatmentStdDev ** 2 / n2));
    const tStat = se !== 0 ? (treatmentMean - controlMean) / se : 0;
    
    // Degrees of freedom (Welch-Satterthwaite)
    const dfNum = ((controlStdDev ** 2 / n1) + (treatmentStdDev ** 2 / n2)) ** 2;
    const dfDen = ((controlStdDev ** 2 / n1) ** 2 / (n1 - 1)) + ((treatmentStdDev ** 2 / n2) ** 2 / (n2 - 1));
    const df = dfDen !== 0 ? dfNum / dfDen : n1 + n2 - 2;

    // P-value approximation
    const pValue = this.approximatePValue(Math.abs(tStat), df);

    const significant = pValue < (1 - this.confidenceLevel);
    
    return {
      controlMean,
      treatmentMean,
      lift: Math.round(lift * 100) / 100,
      standardError: se,
      tStatistic: Math.round(tStat * 1000) / 1000,
      degreesOfFreedom: Math.round(df),
      pValue: Math.round(pValue * 10000) / 10000,
      significant,
      confidenceLevel: this.confidenceLevel,
      winner: significant ? 
        (lift > 0 ? 'treatment' : 'control') : 'none'
    };
  }

  /**
   * Determine overall winner
   */
  determineWinner(variantResults, controlId) {
    if (!controlId) return null;

    const control = variantResults[controlId];
    if (!control) return null;

    const winners = [];
    
    for (const [id, variant] of Object.entries(variantResults)) {
      if (id === controlId) continue;

      let winCount = 0;
      let totalMetrics = 0;

      for (const stats of Object.values(variant.metrics)) {
        if (stats.vsControl && stats.vsControl.significant) {
          totalMetrics++;
          if (stats.vsControl.winner === 'treatment') winCount++;
        }
      }

      if (totalMetrics > 0) {
        winners.push({
          variantId: id,
          variantName: variant.variantName,
          winRate: winCount / totalMetrics,
          significantMetrics: totalMetrics
        });
      }
    }

    if (winners.length === 0) return { variantId: null, reason: 'No significant difference detected' };

    winners.sort((a, b) => b.winRate - a.winRate);
    
    return {
      variantId: winners[0].variantId,
      variantName: winners[0].variantName,
      winRate: winners[0].winRate,
      confidence: 'high'
    };
  }

  /**
   * Generate experiment recommendations
   */
  generateExperimentRecommendations(analysis, experiment) {
    const recommendations = [];

    // Minimum sample size check
    if (experiment.sampleSize < experiment.minSampleSize) {
      recommendations.push({
        type: 'sample_size',
        severity: 'warning',
        message: `Sample size (${experiment.sampleSize}) is below minimum (${experiment.minSampleSize}). Results may not be reliable.`,
        action: 'Continue experiment to collect more data'
      });
    }

    // Winner recommendation
    if (analysis.winner?.variantId) {
      recommendations.push({
        type: 'rollout',
        severity: 'info',
        message: `Variant "${analysis.winner.variantName}" is the winner with ${Math.round(analysis.winner.winRate * 100)}% win rate across metrics.`,
        action: 'Consider rolling out the winning variant to 100% of traffic'
      });
    } else if (analysis.winner?.reason) {
      recommendations.push({
        type: 'no_winner',
        severity: 'info',
        message: analysis.winner.reason,
        action: 'Consider extending experiment duration or testing different variants'
      });
    }

    // Duration recommendation
    if (experiment.status === 'running' && experiment.startedAt) {
      const runningDays = (Date.now() - new Date(experiment.startedAt).getTime()) / (1000 * 60 * 60 * 24);
      const targetDays = this.parseDuration(experiment.duration);

      if (runningDays < targetDays) {
        recommendations.push({
          type: 'duration',
          severity: 'info',
          message: `Experiment has been running for ${Math.round(runningDays)} days (target: ${targetDays} days).`,
          action: 'Continue running to reach target duration'
        });
      }
    }

    return recommendations;
  }

  /**
   * Get experiment status
   */
  getExperimentStatus(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;

    return {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      sampleSize: experiment.sampleSize,
      variants: experiment.variants.map(v => ({
        id: v.id,
        name: v.name,
        isControl: v.isControl,
        allocationRate: experiment.split[v.id] || 0
      })),
      startedAt: experiment.startedAt,
      endedAt: experiment.endedAt,
      targetSampleSize: experiment.minSampleSize
    };
  }

  /**
   * List all experiments
   */
  listExperiments() {
    const experiments = [];
    
    for (const [id, experiment] of this.experiments) {
      experiments.push({
        id,
        name: experiment.name,
        status: experiment.status,
        sampleSize: experiment.sampleSize,
        variants: experiment.variants.length,
        createdAt: experiment.createdAt
      });
    }

    return experiments;
  }

  /**
   * Statistical helper: calculate mean
   */
  calculateMean(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Statistical helper: calculate median
   */
  calculateMedian(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? 
      (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /**
   * Statistical helper: calculate standard deviation
   */
  calculateStdDev(values) {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Approximate p-value from t-statistic and degrees of freedom
   */
  approximatePValue(tStat, df) {
    // Simple approximation using normal distribution for large df
    if (df > 30) {
      return 2 * (1 - this.normalCDF(Math.abs(tStat)));
    }

    // More complex approximation for smaller df
    const x = df / (df + tStat * tStat);
    const a = df / 2;
    const b = 0.5;
    
    // Incomplete beta function approximation
    const p = this.incompleteBeta(x, a, b);
    return 2 * Math.min(p, 1 - p);
  }

  /**
   * Normal CDF approximation
   */
  normalCDF(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Incomplete beta function approximation (simplified)
   */
  incompleteBeta(x, a, b) {
    // Simpson's rule approximation
    const n = 1000;
    const h = x / n;
    let sum = 0;

    for (let i = 1; i < n; i += 2) {
      const t = i * h;
      sum += 4 * Math.pow(t, a - 1) * Math.pow(1 - t, b - 1);
    }

    for (let i = 2; i < n - 1; i += 2) {
      const t = i * h;
      sum += 2 * Math.pow(t, a - 1) * Math.pow(1 - t, b - 1);
    }

    sum += Math.pow(x, a - 1) * Math.pow(1 - x, b - 1);

    return sum * h / 3;
  }

  /**
   * Hash string to [0, 1] for deterministic allocation
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return (Math.abs(hash) % 10000) / 10000;
  }

  /**
   * Parse duration string to days
   */
  parseDuration(duration) {
    const match = duration.match(/^(\d+)(h|d|w)$/);
    if (!match) return 7;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'h': return value / 24;
      case 'd': return value;
      case 'w': return value * 7;
      default: return 7;
    }
  }
}

module.exports = { ABTestingFramework };
