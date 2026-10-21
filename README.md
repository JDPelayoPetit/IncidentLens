# IncidentLens

IncidentLens is an AI-assisted production incident investigation and triage system built on Cloudflare Workers, Cloudflare Agents SDK, and Workers AI. It analyzes incident descriptions, affected services, recent changes, and diagnostic log streams to produce structured, evidence-grounded hypotheses and prioritized next steps for incident responders.

---

## Key Features & Workflow

1. **Structured Incident Intake**:
   - Collects incident metadata with explicit client-side and server-side validation: title (max 160 chars), description (max 2,000 chars), raw logs/evidence (max 12,000 chars), recent changes (max 1,000 chars), and affected services (up to 20 services, 120 chars each).
   - Quick evaluation button (**"Load Sample Incident"**) populates a realistic payment gateway cascade failure for immediate inspection.

2. **Untrusted Data Boundary**:
   - Isolates user diagnostic data, logs, and stack traces inside an explicit demarcation boundary (`=== BEGIN UNTRUSTED INCIDENT DATA ===`) to protect system instructions from prompt injection.

3. **Evidence-Grounded 3-Part Investigation**:
   - Enforces a calibrated, concise Markdown report format:
     - **Incident Summary & Confirmed Facts**: Chronological timeline and observed anomalies strictly verified in the evidence.
     - **Ranked Root-Cause Hypotheses**: At most three plausible hypotheses with supporting evidence, caveats, and calibrated confidence levels (Low / Medium / High).
     - **Prioritized Diagnostic Next Steps**: At most three actionable checks with stated objectives to confirm or rule out hypotheses.

4. **Contextual Follow-Up Chat**:
   - Interactive multi-turn chat allowing operators to ask clarifying questions while retaining active incident context.
   - Strict 2,000-character upper bound enforced on both client and server for follow-up questions.

5. **Truncation Detection & Warning**:
   - Detects incomplete reports caused by model output token limits using primary finish-reason metadata (`part.finishReason === "length"`, `part.truncated === true`) and a structural fallback checking for Section 3 completeness, terminal punctuation, and list completion.
   - Displays a prominent warning banner when output truncation is identified.

6. **State Management & Mutual Exclusion**:
   - Employs generation identifiers and abort controllers to prevent concurrent analysis collisions.
   - **"Clear Incident"** cleanly aborts in-flight turns, drains the execution queue, and resets agent state to `idle`.

---

## Architecture & Technology Stack

- **Runtime & Compute**: [Cloudflare Workers](https://workers.cloudflare.com/) with `nodejs_compat` compatibility flag (`2026-06-11`).
- **Agent Framework**: Cloudflare Agents SDK (`agents@0.17.4`) and `@cloudflare/ai-chat` using Durable Objects (`IncidentLensAgent`) with SQLite storage for state persistence.
- **Model Inference**: [Workers AI](https://developers.cloudflare.com/workers-ai/) binding (`AI`), provisionally configured with `@cf/google/gemma-4-26b-a4b-it` via `workers-ai-provider` and the Vercel AI SDK (`ai`).
- **Frontend SPA**: React 19 application bundled with Vite (`@cloudflare/vite-plugin`), styled with Tailwind CSS v4 and Cloudflare Kumo design components (`@cloudflare/kumo`), with Markdown streaming rendered by `streamdown` and `@streamdown/code`.
- **Shared Validation & Utilities**: Pure TypeScript utility module ([src/analysis-utils.ts](file:///Users/jpelayop/Projects/incidentlens/src/analysis-utils.ts)) decoupled from Cloudflare and DOM runtimes, directly importable by server, client, and Node.js test runners.

---

## Prerequisites

- **Node.js**: `>= 20.x` (tested against v24.22.0)
- **npm**: `>= 10.x` (tested against v11.19.1)
- **Cloudflare Account**: Required for remote Workers AI inference and production deployment.

---

## Installation & Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the local development server**:
   ```bash
   npm run dev
   ```
   The application will be accessible at `http://localhost:5173`.

> **Note on Workers AI Binding**: The local configuration in `wrangler.jsonc` specifies `"ai": { "binding": "AI", "remote": true }`. Connecting to remote Workers AI during local development requires authenticating with Cloudflare (`npx wrangler login` or environment credentials).

---

## Verification, Testing & Build Commands

All checks run offline against local dependencies without requiring network access:

| Check | Command | Description |
|---|---|---|
| **Unit Tests** | `node --test test/truncation.test.mjs` | Executes 15 test cases covering truncation detection, metadata evaluation, and structural fallbacks. |
| **Linting** | `npm run lint` | Runs `oxlint src/` to verify code quality and style. |
| **Type Checking** | `npx tsc --noEmit` | Validates TypeScript types across the entire project. |
| **Production Build** | `npx vite build` | Builds static assets in `dist/client/` and the Cloudflare Worker bundle in `dist/incidentlens/`. |
| **Combined Check** | `npm run check` | Runs `oxfmt --check .`, `oxlint src/`, and `tsc`. |

---

## Configuration & Deployment Guidance

### Configuration Files
- [`wrangler.jsonc`](file:///Users/jpelayop/Projects/incidentlens/wrangler.jsonc): Configures the Worker entry point (`src/server.ts`), compatibility settings, Workers AI binding (`AI`), static assets directory (`./public`), and the `IncidentLensAgent` Durable Object binding and migration.
- [`vite.config.ts`](file:///Users/jpelayop/Projects/incidentlens/vite.config.ts): Configures Vite plugins for Cloudflare Workers (`@cloudflare/vite-plugin`), Agents (`agents/vite`), React, and Tailwind CSS.

### Deployment (Unverified Step)
To deploy the application to Cloudflare Workers:
```bash
npm run deploy
```
*(Executes `vite build && wrangler deploy`)*

> **Unverified Operational Notice**: Live deployment to a remote Cloudflare environment has not been executed or validated as part of this pre-commit audit. Successful deployment requires active Cloudflare account credentials (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` or an active `wrangler login` session) and access to Workers AI in the target account.

---

## Limitations & Responsible Use

- **Diagnostic Hypotheses Require Human Verification**: Model responses are hypotheses generated from provided diagnostic data, not definitive root causes. Responders must verify hypotheses against live telemetry, logs, and system metrics before taking remediating actions.
- **Untrusted Input Boundary**: While incident inputs are framed within an untrusted data boundary, operators should exercise caution with untrusted third-party inputs.
- **Output Token Truncation**: When model output exceeds token limits, reports may truncate before completing all sections. IncidentLens detects this and displays a warning banner, but operators must review truncated output carefully.
- **Input Bounds**: Strict limits apply to all fields (e.g., 12,000 chars for logs, 2,000 chars for follow-up chat) to protect model context windows and maintain deterministic performance.

---

## Dependency & Security Status

A targeted dependency remediation was applied to address supply-chain advisories:
- Updated `streamdown` to `^2.7.1`, `vite` to `^8.1.6`, and `wrangler` to `^4.151.3`.
- Applied npm overrides for `dompurify` (`^3.4.16`) and `tinypool` (`^2.1.2`).

Eight transitive findings remain in the dependency tree originating from `agents@0.17.4` &rarr; `@modelcontextprotocol/sdk@1.29.0` (1 critical, 4 high, 3 moderate). These advisories are not fixed, and the packages are not claimed to be universally safe; rather, an architectural and code-level exposure assessment determined that they are not reachable through the application's runtime paths:
- The critical `proxy-addr` vulnerability and related Node server packages (`@hono/node-server`, `hono`, `ip-address`, `qs`) are **completely absent** from the production Cloudflare Worker bundle.
- `@modelcontextprotocol/sdk` and `fast-uri` are present in the bundle only as dormant client connection logic in `Agent.createConnection()`.
- An RPC reachability audit verified that `IncidentLensAgent` defines zero MCP tools, exposes only two `@callable()` methods (`submitIncident`, `clearIncident`), and has no reachable path to initialize MCP client connections.
- Upgrading `agents` to `>=0.29.0` constitutes a major framework migration and remains intentionally deferred.

---

## Project Status

- **Implementation**: Complete.
- **Automated Validation**: All unit tests, linting, type-checking, and production builds pass.
- **Live Verification**: End-to-end live model inference and live Cloudflare deployment remain unverified pending production environment setup and live testing authorization.
