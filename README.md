# cf_ai_taskflow

An AI-powered task manager built on Cloudflare's developer platform — create, update, and query tasks through natural language chat.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Router | Hono |
| AI | Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| State | Durable Objects (one per user session) |
| Frontend | Cloudflare Pages — single-file vanilla JS/CSS |
| Config | Wrangler v3 |

## Features

- **Natural language task creation** — "Add three tasks for my product launch with high priority" just works
- **Persistent task state** — tasks survive page refreshes and new sessions via Durable Object storage
- **Per-user isolation** — each browser session gets its own Durable Object, keyed by cookie
- **Full CRUD via chat** — create, update status/priority, and delete tasks through conversation
- **Chat history** — the AI remembers the last 10 exchanges for contextual follow-ups
- **Inline status editing** — click any task card to change status without leaving the page
- **Dark, polished UI** — split-panel layout inspired by Linear and Notion dark mode

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the local dev server:
   ```bash
   npx wrangler dev
   ```

3. Open [localhost:8787](http://localhost:8787) in your browser.

> **Note:** Workers AI runs remotely even in local dev, so you need to be logged into Cloudflare (`npx wrangler login`) and have Workers AI enabled on your account.

## Deployment

```bash
npx wrangler deploy
```

Wrangler will automatically create the Durable Object migration and bind the AI model on first deploy.

## Architecture

```
Browser
  │
  ├── GET /          →  Static HTML (Cloudflare Pages / Assets binding)
  │
  ├── POST /api/chat →  Hono Worker
  │     │                 1. Reads session cookie → maps to Durable Object ID
  │     │                 2. Fetches current tasks from the DO
  │     │                 3. Calls Workers AI with task-aware system prompt
  │     │                 4. Parses AI response for task action JSON
  │     │                 5. Executes bulk task operations on the DO
  │     │                 6. Returns { reply, tasks } to the browser
  │     │
  │     └──────────→  TaskDurableObject (one per session)
  │                       · Stores task array in durable KV storage
  │                       · Handles GET/POST/PATCH/DELETE /tasks routes
  │
  └── /api/tasks/*  →  Proxied directly to the user's Durable Object
```

**Workers AI** runs inference on Cloudflare's GPU fleet — no external API keys needed beyond your Cloudflare account.

**Durable Objects** provide strongly-consistent, per-user storage with a built-in fetch handler, making them a natural fit for session-scoped state without a separate database.

---

> _Screenshot placeholder — add a screenshot of the app here_
