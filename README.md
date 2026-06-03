# SelfCheck - Self-Improving Customer Service Agent

SelfCheck is a Gemini-powered customer service agent built for the Google Cloud Rapid Agent Hackathon, Arize track. It traces conversations, evaluates its own answers, detects recurring failure patterns, and uses those signals to improve future responses.

## Current Direction

The project direction is now SelfCheck, not CodeMem. The implementation is a Node.js customer-service agent with:

- Google Cloud Agent Builder configuration in `agent/`
- Gemini-based LLM-as-judge evaluation through `@google/genai`
- Arize Phoenix / OpenTelemetry tracing in `backend/modules/arize-phoenix.js`
- Firestore-backed knowledge, product, order, ticket, and refund workflows
- A static local dashboard at `frontend/dashboard.html`
- Cloud Functions Gen2 deployment config in `deployment/`

## What Works Today

- Local Express server: `npm start`
- Dashboard: `http://localhost:8080/dashboard.html`
- Health check: `http://localhost:8080/health`
- Chat endpoint: `POST /api/chat`
- Self-evaluation scoring with rule-based fallback when Gemini is unavailable
- Local demo knowledge fallback before Firestore is seeded
- A/B testing, monitoring, summarization, multi-language, feedback, and improvement modules

## Architecture

```text
Dashboard / API client
        |
        v
Express dev server or Cloud Function webhook
        |
        +-- KnowledgeBase: Firestore plus local demo fallback
        +-- EnhancedEvaluator: Gemini LLM-as-judge plus rule scoring
        +-- PhoenixIntrospector: Phoenix trace query plus local trace fallback
        +-- ImprovementEngine: prompt versioning and improvement history
        +-- MonitoringAlerting: Cloud Monitoring custom metrics
```

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Start **local Arize Phoenix** (no cloud account or API key):

```bash
pip install arize-phoenix
phoenix serve
```

Phoenix UI: `http://localhost:6006`

3. Create `.env` from `.env.example` and fill in at least:

```bash
GEMINI_API_KEY=...
GOOGLE_API_KEY=...
GOOGLE_CLOUD_PROJECT=...
WEBHOOK_API_KEY=...
NODE_ENV=development
# Phoenix defaults in .env.example (localhost:6006, no API key)
```

4. Start the local server (with Phoenix still running):

```bash
npm start
```

5. Open the dashboard:

```text
http://localhost:8080/dashboard.html
```

Traces are exported via OpenTelemetry to `http://localhost:6006/v1/traces`. Runtime introspection uses an in-app trace buffer when no API key is set (see `PhoenixIntrospector` in `backend/modules/arize-phoenix.js`).

### Phoenix Cloud (optional)

To use hosted Phoenix instead of `phoenix serve`, set `ARIZE_ENDPOINT=https://app.phoenix.arize.com`, `ARIZE_API_KEY`, and `ARIZE_PROJECT_ID` in `.env`.

## Verification

```bash
npm test
npm run lint
```

## Production Notes

- `/health` is public.
- All other webhook routes require `Authorization: Bearer <WEBHOOK_API_KEY>` when `NODE_ENV` is not `development`.
- Cloud Functions may still use `--allow-unauthenticated`; application-level authentication is enforced by the webhook.
- Firestore should be seeded before the final demo. Until then, the app has a local demo fallback for common customer-service questions.

## Submission Checklist

- Public repository with license
- Deployed Cloud Function URL
- Agent Builder app configured to call the webhook
- Arize Phoenix receiving traces (local `phoenix serve` or Phoenix Cloud)
- Firestore seeded with FAQ, products, and orders
- Demo dashboard working against production
- Three-minute demo video showing before/after improvement
