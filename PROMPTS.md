# PROMPTS.md

A transparent log of the AI prompts used to design and build `cf_ai_taskflow`.

---

1. **Architecture planning**
   > "I need to build a Cloudflare AI-powered task manager. The requirements are: Workers AI for LLM inference (llama-3.3-70b-instruct-fp8-fast), Durable Objects for per-session task state, Cloudflare Pages for a single-file frontend, and Hono for routing. Help me design the file structure and data flow before writing any code."

   *Outcome:* Established the split between `src/index.ts` (Hono router + AI glue), `src/taskDurableObject.ts` (stateful CRUD), and `public/index.html` (frontend). Decided to key Durable Object instances by a session cookie rather than user auth to keep the demo self-contained.

---

2. **Durable Object with full CRUD**
   > "Write the TaskDurableObject class in TypeScript using the new DO API style (constructor takes DurableObjectState and Env). It should persist an array of Task objects in durable storage and expose GET /tasks, POST /tasks, PATCH /tasks/:id, DELETE /tasks/:id, and POST /tasks/bulk for batch AI-driven operations. Use Math.random() for IDs — no external packages."

   *Outcome:* Complete `taskDurableObject.ts` with all five routes, typed Task interface, and bulk operation handler that accepts an array of `{action: "create"|"update"|"delete", ...fields}` objects.

---

3. **Hono Worker with AI integration and session handling**
   > "Write src/index.ts using Hono. It needs to: (1) proxy /api/tasks/* to the user's Durable Object identified by a session cookie, (2) handle POST /api/chat by fetching current tasks, calling Workers AI with a context-aware system prompt, parsing a JSON actions block from the response, executing any task operations via the DO's bulk endpoint, and returning { reply, tasks }."

   *Outcome:* Full worker with cookie-based session management, DO stub helper, AI call with typed response, JSON block extraction via regex, and bulk task execution before returning the unified response to the frontend.

---

4. **System prompt for dual-mode task parsing**
   > "Design a system prompt for llama-3.3-70b that makes the model operate in two modes: (1) task operations — respond with a JSON block containing an actions array and a reply string; (2) plain conversation — respond with text only. The prompt should inject the current task list as JSON, explain how to infer priority from urgency language, and handle relative due date parsing."

   *Outcome:* The `SYSTEM_PROMPT` template in `index.ts` that injects live task state, defines the exact JSON schema for actions, and includes guidance on priority inference and date parsing relative to today's date.

---

5. **Split-panel chat UI**
   > "Build public/index.html as a single file with no framework. Dark mode aesthetic like Linear or Notion. Left panel (40%) shows tasks grouped by status with priority badges and due dates, clicking a card shows inline status controls. Right panel (60%) is a chat interface with typing indicator, message bubbles, and suggestion chips. On chat send, call POST /api/chat and re-render the task list. No external JS libraries."

   *Outcome:* Complete single-file frontend with CSS custom properties for theming, vanilla JS task rendering with group headers, expand/collapse cards, cycle-status button, typing animation, and welcome state with suggestion chips.

---

6. **wrangler.toml configuration**
   > "Write the wrangler.toml for wrangler v3 with: name cf-ai-taskflow, Workers AI binding named AI, Durable Objects binding TASK_STORE pointing to TaskDurableObject, a migration entry for new_classes, and a static assets binding for the public/ folder."

   *Outcome:* Correct `wrangler.toml` with `[ai]`, `[[durable_objects.bindings]]`, `[[migrations]]`, and `[assets]` sections in v3 TOML syntax.

---

7. **README**
   > "Write a professional README for a job application portfolio project. Include: one-line description, tech stack table, features list, local dev instructions, deployment instructions, and a brief architecture diagram showing how Workers, Durable Objects, and Workers AI interact."

   *Outcome:* `README.md` with ASCII architecture diagram, table-format tech stack, and step-by-step setup instructions.
