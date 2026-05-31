/**
 * Monitoring & Alerting Module
 * Phase 2: Google Cloud Monitoring integration with custom metrics and alerting
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const monitoring = require('@google-cloud/monitoring');

const tracer = trace.getTracer('monitoring-alerting');

// Lazy-initialize Monitoring client (only when GCP credentials available)
let client = null;
function getMonitoringClient() {
  if (!client) {
    try {
      client = new monitoring.MetricServiceClient();
    } catch (e) {
      console.warn('[MonitoringAlerting] Cloud Monitoring unavailable:', e.message);
    }
  }
  return client;
}

class MonitoringAlerting {
  constructor(options = {}) {
    this.projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
    this.enabled = options.enabled ?? !!(this.projectId && process.env.GOOGLE_APPLICATION_CREDENTIALS);
    this.alertPolicies = new Map();
    this.metricBuffer = [];
    this.flushInterval = options.flushInterval || 60000; // 1 minute
    this.maxBufferSize = options.maxBufferSize || 100;
    this.alertHandlers = new Map();
    this.notificationChannels = options.notificationChannels || [];
    
    // Start auto-flush only when Cloud Monitoring can be used.
    this.flushTimer = this.enabled ? setInterval(() => this.flushMetrics(), this.flushInterval) : null;

    // Graceful shutdown
    if (this.flushTimer) {
      const cleanup = () => this.destroy();
      process.once('SIGTERM', cleanup);
      process.once('SIGINT', cleanup);
    }
  }

  /**
   * Record a custom metric
   */
  async recordMetric(metricType, value, labels = {}) {
    const span = tracer.startSpan('record-metric');

    try {
      if (!this.enabled) {
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const metric = {
        type: metricType,
        value,
        labels: {
          ...labels,
          environment: process.env.NODE_ENV || 'production',
          service: 'selfcheck-agent'
        },
        timestamp: new Date()
      };

      this.metricBuffer.push(metric);

      // Auto-flush if buffer is full
      if (this.metricBuffer.length >= this.maxBufferSize) {
        await this.flushMetrics();
      }

      span.setAttributes({
        'metric.type': metricType,
        'metric.value': value
      });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } finally {
      span.end();
    }
  }

  /**
   * Record evaluation metrics
   */
  async recordEvaluationMetrics(evaluation) {
    const metrics = [
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/overall_score',
        value: evaluation.scores.overall,
        labels: { conversation_id: evaluation.conversationId }
      },
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/relevance',
        value: evaluation.scores.relevance,
        labels: { conversation_id: evaluation.conversationId }
      },
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/accuracy',
        value: evaluation.scores.accuracy,
        labels: { conversation_id: evaluation.conversationId }
      },
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/helpfulness',
        value: evaluation.scores.helpfulness,
        labels: { conversation_id: evaluation.conversationId }
      },
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/empathy',
        value: evaluation.scores.empathy,
        labels: { conversation_id: evaluation.conversationId }
      },
      {
        type: 'custom.googleapis.com/selfcheck/evaluation/efficiency',
        value: evaluation.scores.efficiency,
        labels: { conversation_id: evaluation.conversationId }
      }
    ];

    for (const metric of metrics) {
      await this.recordMetric(metric.type, metric.value, metric.labels);
    }
  }

  /**
   * Record conversation metrics
   */
  async recordConversationMetrics(conversation) {
    const metrics = [
      {
        type: 'custom.googleapis.com/selfcheck/conversation/turns',
        value: conversation.turns || 0,
        labels: { conversation_id: conversation.id }
      },
      {
        type: 'custom.googleapis.com/selfcheck/conversation/duration_ms',
        value: conversation.duration || 0,
        labels: { conversation_id: conversation.id }
      },
      {
        type: 'custom.googleapis.com/selfcheck/conversation/resolved',
        value: conversation.resolved ? 1 : 0,
        labels: { conversation_id: conversation.id }
      }
    ];

    for (const metric of metrics) {
      await this.recordMetric(metric.type, metric.value, metric.labels);
    }
  }

  /**
   * Record tool usage metrics
   */
  async recordToolMetrics(toolName, success, durationMs) {
    await this.recordMetric(
      'custom.googleapis.com/selfcheck/tool/usage',
      1,
      { tool: toolName, success: success.toString() }
    );

    await this.recordMetric(
      'custom.googleapis.com/selfcheck/tool/duration_ms',
      durationMs,
      { tool: toolName }
    );
  }

  /**
   * Record error metrics
   */
  async recordError(errorType, errorMessage, context = {}) {
    await this.recordMetric(
      'custom.googleapis.com/selfcheck/errors/count',
      1,
      { error_type: errorType, ...context }
    );

    // Check alert thresholds
    await this.checkErrorThresholds(errorType);
  }

  /**
   * Record user feedback metrics
   */
  async recordFeedbackMetrics(feedback) {
    await this.recordMetric(
      'custom.googleapis.com/selfcheck/feedback/rating',
      feedback.rating || 0,
      { conversation_id: feedback.conversationId }
    );

    if (feedback.helpful !== undefined) {
      await this.recordMetric(
        'custom.googleapis.com/selfcheck/feedback/helpful',
        feedback.helpful ? 1 : 0,
        { conversation_id: feedback.conversationId }
      );
    }
  }

  /**
   * Flush buffered metrics to Cloud Monitoring
   */
  async flushMetrics() {
    if (this.metricBuffer.length === 0) return;
    if (!this.enabled) {
      this.metricBuffer = [];
      return;
    }

    const span = tracer.startSpan('flush-metrics');
    const metrics = [...this.metricBuffer];
    this.metricBuffer = [];

    try {
      const monClient = getMonitoringClient();
      if (!monClient) {
        // Cloud Monitoring unavailable — silently discard
        return;
      }

      const timeSeries = metrics.map(metric => ({
        metric: {
          type: metric.type,
          labels: metric.labels
        },
        resource: {
          type: 'cloud_function',
          labels: {
            function_name: 'selfcheck-webhook',
            project_id: this.projectId,
            region: process.env.FUNCTION_REGION || 'us-central1'
          }
        },
        points: [{
          interval: {
            endTime: {
              seconds: Math.floor(metric.timestamp.getTime() / 1000)
            }
          },
          value: {
            doubleValue: metric.value
          }
        }]
      }));

      const request = {
        name: monClient.projectPath(this.projectId),
        timeSeries
      };

      await monClient.createTimeSeries(request);
      
      span.setAttributes({
        'metrics.flushed': metrics.length,
        'metrics.types': [...new Set(metrics.map(m => m.type))].length
      });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      console.error('Failed to flush metrics:', error.message);
      
      // Re-buffer metrics on failure (up to max)
      if (this.metricBuffer.length < this.maxBufferSize) {
        this.metricBuffer.push(...metrics.slice(0, this.maxBufferSize - this.metricBuffer.length));
      }
    } finally {
      span.end();
    }
  }

  /**
   * Create an alert policy
   */
  async createAlertPolicy(config) {
    const {
      name,
      metricType,
      threshold,
      duration = '60s',
      comparison = 'COMPARISON_GT',
      notificationChannels = this.notificationChannels,
      documentation = ''
    } = config;

    try {
      const monClient = getMonitoringClient();
      if (!monClient) throw new Error('Cloud Monitoring unavailable');

      const policy = {
        displayName: name,
        documentation: {
          content: documentation,
          mimeType: 'text/markdown'
        },
        conditions: [{
          displayName: `${name} condition`,
          conditionThreshold: {
            filter: `metric.type="${metricType}" resource.type="cloud_function"`,
            comparison,
            thresholdValue: threshold,
            duration: { seconds: this.parseDuration(duration) },
            trigger: {
              count: 1
            },
            aggregations: [{
              alignmentPeriod: { seconds: 60 },
              perSeriesAligner: 'ALIGN_MEAN'
            }]
          }
        }],
        combiner: 'OR',
        enabled: { value: true },
        notificationChannels
      };

      const request = {
        name: monClient.projectPath(this.projectId),
        alertPolicy: policy
      };

      const [result] = await monClient.createAlertPolicy(request);
      
      this.alertPolicies.set(name, {
        id: result.name,
        config,
        createdAt: new Date().toISOString()
      });

      return {
        name: result.name,
        displayName: result.displayName,
        enabled: result.enabled?.value
      };
    } catch (error) {
      console.error('Failed to create alert policy:', error);
      throw error;
    }
  }

  /**
   * Create standard alert policies for SelfCheck
   */
  async createStandardAlerts() {
    const alerts = [
      {
        name: 'Low Overall Evaluation Score',
        metricType: 'custom.googleapis.com/selfcheck/evaluation/overall_score',
        threshold: 0.4,
        comparison: 'COMPARISON_LT',
        duration: '300s',
        documentation: `# Low Evaluation Score Alert

The overall evaluation score has dropped below 0.4.

**Action Required:**
1. Check recent conversation quality
2. Review failure patterns in Arize Phoenix
3. Verify knowledge base accuracy
4. Check for model degradation`
      },
      {
        name: 'High Error Rate',
        metricType: 'custom.googleapis.com/selfcheck/errors/count',
        threshold: 10,
        comparison: 'COMPARISON_GT',
        duration: '60s',
        documentation: `# High Error Rate Alert

Error count has exceeded threshold.

**Action Required:**
1. Check Cloud Function logs
2. Verify external service connectivity
3. Review recent deployments
4. Check quota limits`
      },
      {
        name: 'Low User Satisfaction',
        metricType: 'custom.googleapis.com/selfcheck/feedback/rating',
        threshold: 2.5,
        comparison: 'COMPARISON_LT',
        duration: '300s',
        documentation: `# Low User Satisfaction Alert

Average user rating has dropped below 2.5.

**Action Required:**
1. Review recent conversations
2. Check for common complaints
3. Verify response quality
4. Consider A/B test rollback`
      },
      {
        name: 'High Response Time',
        metricType: 'custom.googleapis.com/selfcheck/conversation/duration_ms',
        threshold: 10000,
        comparison: 'COMPARISON_GT',
        duration: '300s',
        documentation: `# High Response Time Alert

Average response time has exceeded 10 seconds.

**Action Required:**
1. Check Cloud Function cold starts
2. Verify external API latency
3. Review tool execution times
4. Consider scaling adjustments`
      }
    ];

    const results = [];
    for (const alert of alerts) {
      try {
        const result = await this.createAlertPolicy(alert);
        results.push({ name: alert.name, ...result });
      } catch (error) {
        results.push({ name: alert.name, error: error.message });
      }
    }

    return results;
  }

  /**
   * Register an alert handler
   */
  registerAlertHandler(alertName, handler) {
    if (!this.alertHandlers.has(alertName)) {
      this.alertHandlers.set(alertName, []);
    }
    this.alertHandlers.get(alertName).push(handler);
  }

  /**
   * Trigger alert handlers
   */
  async triggerAlert(alertName, data) {
    const handlers = this.alertHandlers.get(alertName) || [];
    
    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (error) {
        console.error(`Alert handler error for ${alertName}:`, error);
      }
    }
  }

  /**
   * Check error thresholds and trigger alerts
   */
  async checkErrorThresholds(errorType) {
    // Count recent errors of this type
    const recentErrors = this.metricBuffer.filter(
      m => m.type === 'custom.googleapis.com/selfcheck/errors/count' &&
           m.labels.error_type === errorType
    );

    if (recentErrors.length >= 5) {
      await this.triggerAlert('High Error Rate', {
        errorType,
        count: recentErrors.length,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get current metrics snapshot
   */
  async getMetricsSnapshot() {
    if (!this.enabled) return { error: 'Cloud Monitoring unavailable' };

    const now = Math.floor(Date.now() / 1000);
    const fiveMinutesAgo = now - 300;

    try {
      const monClient = getMonitoringClient();
      if (!monClient) return { error: 'Cloud Monitoring unavailable' };

      const request = {
        name: monClient.projectPath(this.projectId),
        filter: 'metric.type = starts_with("custom.googleapis.com/selfcheck/")',
        interval: {
          startTime: { seconds: fiveMinutesAgo },
          endTime: { seconds: now }
        },
        aggregation: {
          alignmentPeriod: { seconds: 60 },
          perSeriesAligner: 'ALIGN_MEAN'
        }
      };

      const [timeSeries] = await monClient.listTimeSeries(request);

      const snapshot = {
        timestamp: new Date().toISOString(),
        metrics: {}
      };

      timeSeries.forEach(series => {
        const metricType = series.metric.type.replace('custom.googleapis.com/selfcheck/', '');
        const points = series.points || [];
        
        if (points.length > 0) {
          const values = points.map(p => p.value?.doubleValue || p.value?.int64Value || 0);
          snapshot.metrics[metricType] = {
            current: values[values.length - 1],
            average: values.reduce((a, b) => a + b, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            sampleCount: values.length
          };
        }
      });

      return snapshot;
    } catch (error) {
      console.error('Failed to get metrics snapshot:', error);
      return { error: error.message };
    }
  }

  /**
   * Create a dashboard for monitoring
   */
  async createMonitoringDashboard() {
    const dashboard = {
      displayName: 'SelfCheck Agent Monitoring',
      gridLayout: {
        columns: '2',
        widgets: [
          {
            title: 'Overall Evaluation Score',
            xyChart: {
              dataSets: [{
                timeSeriesQuery: {
                  timeSeriesFilter: {
                    filter: 'metric.type="custom.googleapis.com/selfcheck/evaluation/overall_score"',
                    aggregation: {
                      alignmentPeriod: '60s',
                      perSeriesAligner: 'ALIGN_MEAN'
                    }
                  }
                }
              }],
              timeshiftDuration: '0s',
              yAxis: { scale: 'LINEAR' }
            }
          },
          {
            title: 'Error Rate',
            xyChart: {
              dataSets: [{
                timeSeriesQuery: {
                  timeSeriesFilter: {
                    filter: 'metric.type="custom.googleapis.com/selfcheck/errors/count"',
                    aggregation: {
                      alignmentPeriod: '60s',
                      perSeriesAligner: 'ALIGN_RATE'
                    }
                  }
                }
              }],
              yAxis: { scale: 'LINEAR' }
            }
          },
          {
            title: 'User Satisfaction',
            xyChart: {
              dataSets: [{
                timeSeriesQuery: {
                  timeSeriesFilter: {
                    filter: 'metric.type="custom.googleapis.com/selfcheck/feedback/rating"',
                    aggregation: {
                      alignmentPeriod: '300s',
                      perSeriesAligner: 'ALIGN_MEAN'
                    }
                  }
                }
              }],
              yAxis: { scale: 'LINEAR' }
            }
          },
          {
            title: 'Response Time (ms)',
            xyChart: {
              dataSets: [{
                timeSeriesQuery: {
                  timeSeriesFilter: {
                    filter: 'metric.type="custom.googleapis.com/selfcheck/conversation/duration_ms"',
                    aggregation: {
                      alignmentPeriod: '60s',
                      perSeriesAligner: 'ALIGN_MEAN'
                    }
                  }
                }
              }],
              yAxis: { scale: 'LINEAR' }
            }
          },
          {
            title: 'Evaluation Dimensions',
            xyChart: {
              dataSets: [
                {
                  timeSeriesQuery: {
                    timeSeriesFilter: {
                      filter: 'metric.type="custom.googleapis.com/selfcheck/evaluation/relevance"',
                      aggregation: {
                        alignmentPeriod: '300s',
                        perSeriesAligner: 'ALIGN_MEAN'
                      }
                    }
                  },
                  plotType: 'LINE',
                  legendTemplate: 'Relevance'
                },
                {
                  timeSeriesQuery: {
                    timeSeriesFilter: {
                      filter: 'metric.type="custom.googleapis.com/selfcheck/evaluation/accuracy"',
                      aggregation: {
                        alignmentPeriod: '300s',
                        perSeriesAligner: 'ALIGN_MEAN'
                      }
                    }
                  },
                  plotType: 'LINE',
                  legendTemplate: 'Accuracy'
                },
                {
                  timeSeriesQuery: {
                    timeSeriesFilter: {
                      filter: 'metric.type="custom.googleapis.com/selfcheck/evaluation/helpfulness"',
                      aggregation: {
                        alignmentPeriod: '300s',
                        perSeriesAligner: 'ALIGN_MEAN'
                      }
                    }
                  },
                  plotType: 'LINE',
                  legendTemplate: 'Helpfulness'
                }
              ],
              yAxis: { scale: 'LINEAR' }
            }
          },
          {
            title: 'Tool Usage Distribution',
            pieChart: {
              dataSets: [{
                timeSeriesQuery: {
                  timeSeriesFilter: {
                    filter: 'metric.type="custom.googleapis.com/selfcheck/tool/usage"',
                    aggregation: {
                      alignmentPeriod: '3600s',
                      perSeriesAligner: 'ALIGN_SUM'
                    }
                  }
                }
              }],
              chartType: 'PIE'
            }
          }
        ]
      }
    };

    return dashboard;
  }

  /**
   * Parse duration string to seconds
   */
  parseDuration(duration) {
    const match = duration.match(/^(\d+)(s|m|h)$/);
    if (!match) return 60;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      default: return 60;
    }
  }

  /**
   * Get alert policy status
   */
  async getAlertStatus() {
    const status = [];
    
    for (const [name, policy] of this.alertPolicies) {
      try {
        const request = { name: policy.id };
        const monClient = getMonitoringClient();
        if (!monClient) throw new Error('Cloud Monitoring unavailable');
        const [result] = await monClient.getAlertPolicy(request);
        
        status.push({
          name,
          id: policy.id,
          enabled: result.enabled?.value,
          conditions: result.conditions?.length || 0,
          createdAt: policy.createdAt
        });
      } catch (error) {
        status.push({
          name,
          id: policy.id,
          error: error.message
        });
      }
    }

    return status;
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushMetrics(); // Final flush
  }
}

module.exports = { MonitoringAlerting };
