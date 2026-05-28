/**
 * SelfCheck - Local Development Server
 *
 * Express wrapper that serves the frontend dashboard and proxies API requests
 * to the Cloud Functions webhook handler. Compatible with both local dev and
 * Cloud Functions deployment.
 */

// Load .env first, before any other module reads environment variables
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Map common env var aliases for compatibility
if (process.env.GOOGLE_CLOUD_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) {
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT_ID;
}
if (process.env.GOOGLE_CLOUD_API_KEY && !process.env.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
  process.env.GOOGLE_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
}

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- Static files: serve the frontend ---
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- API proxy: forward /api/* to the Cloud Function webhook handler ---
// webhook.js routes match paths like /chat, /feedback, /tools/product, etc.
// Frontend calls /api/chat, /api/feedback, etc.
// This middleware strips /api prefix and delegates to the webhook.
const { webhook } = require('./functions/webhook');

app.all('/api/*', (req, res) => {
  // Rewrite URL: /api/chat -> /chat
  req.url = req.url.replace(/^\/api/, '');
  req.isSelfCheckLocalProxy = true;
  if (!req.headers.authorization && process.env.WEBHOOK_API_KEY) {
    req.headers.authorization = `Bearer ${process.env.WEBHOOK_API_KEY}`;
  }
  return webhook(req, res);
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// --- Start server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('');
  console.log('  ============================================');
  console.log('   SelfCheck Agent - Development Server');
  console.log('  ============================================');
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard.html`);
  console.log(`   API Base  : http://localhost:${PORT}/api/`);
  console.log(`   Health    : http://localhost:${PORT}/health`);
  console.log('  ============================================');
  console.log('');
});

module.exports = app;
