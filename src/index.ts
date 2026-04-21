import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { TaskDurableObject } from "./taskDurableObject";

export { TaskDurableObject };

interface Env {
  AI: Ai;
  TASK_STORE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const SYSTEM_PROMPT = (tasksJson: string) => `\
You are a productivity assistant for a task manager app. You help users manage their tasks through natural conversation.

Current task list (JSON):
${tasksJson}

You operate in two modes:

MODE 1 — Task operations (create, update, delete):
If the user wants to create, update, or delete tasks, respond with ONLY this JSON block (no other text before or after):
\`\`\`json
{"actions":[...], "reply":"..."}
\`\`\`

Where "actions" is an array of operations. Each operation has an "action" field:
- Create: { "action": "create", "title": "...", "description": "...", "priority": "low|medium|high", "dueDate": "YYYY-MM-DD" }
- Update: { "action": "update", "id": "<existing task id>", "status": "todo|in-progress|done", "priority": "...", "title": "..." }
- Delete: { "action": "delete", "id": "<existing task id>" }

And "reply" is a short, friendly confirmation message to show the user.

When creating tasks from a natural description (e.g. "add tasks for my project launch"), infer reasonable titles, descriptions, and priorities.
When the user says to mark something done or change a status, find the matching task by title/id and update it.

MODE 2 — Conversation / questions:
If the user is just asking questions, chatting, or wants a summary, respond with plain text only (no JSON block).

Rules:
- Be concise and productivity-focused
- Infer priority from urgency words ("urgent", "asap" → high; "whenever" → low)
- If a due date is mentioned, parse it to YYYY-MM-DD format relative to today (${new Date().toISOString().slice(0, 10)})
- Never invent task IDs — only use IDs from the current task list above
- When multiple tasks are requested at once, include all of them in the actions array
`;

function getOrCreateSessionId(c: AppContext): string {
  let sessionId = getCookie(c, "session_id");
  if (!sessionId) {
    sessionId =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    setCookie(c, "session_id", sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return sessionId;
}

function getDoStub(env: Env, sessionId: string): DurableObjectStub {
  const id = env.TASK_STORE.idFromName(sessionId);
  return env.TASK_STORE.get(id);
}

async function doFetch(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return stub.fetch(`https://do${path}`, init);
}

// Proxy task CRUD endpoints
app.all("/api/tasks/*", async (c) => {
  const sessionId = getOrCreateSessionId(c);
  const stub = getDoStub(c.env, sessionId);
  const url = new URL(c.req.url);
  const doPath = url.pathname.replace("/api", "");

  const body =
    c.req.method !== "GET" && c.req.method !== "DELETE"
      ? await c.req.raw.arrayBuffer()
      : undefined;

  const resp = await doFetch(stub, doPath + url.search, {
    method: c.req.method,
    headers: { "Content-Type": "application/json" },
    body: body as ArrayBuffer | undefined,
  });

  const data = await resp.json();
  return c.json(data, resp.status as 200);
});

app.delete("/api/tasks", async (c) => {
  const sessionId = getOrCreateSessionId(c);
  const stub = getDoStub(c.env, sessionId);
  const resp = await doFetch(stub, "/tasks", { method: "DELETE" });
  const data = await resp.json();
  return c.json(data, resp.status as 200);
});

// Main AI chat endpoint
app.post("/api/chat", async (c) => {
  const { message, history = [] } = await c.req.json<{
    message: string;
    history: { role: string; content: string }[];
  }>();

  const sessionId = getOrCreateSessionId(c);
  const stub = getDoStub(c.env, sessionId);

  const tasksResp = await doFetch(stub, "/tasks");
  const tasks = await tasksResp.json<unknown[]>();
  const tasksJson =
    tasks.length > 0 ? JSON.stringify(tasks, null, 2) : "[] (no tasks yet)";

  const recentHistory = history.slice(-10);

  const messages = [
    ...recentHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: message },
  ];

  const aiResponse = await c.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      system: SYSTEM_PROMPT(tasksJson),
      messages,
    } as Parameters<Ai["run"]>[1]
  );

  const rawText =
    typeof aiResponse === "object" && aiResponse !== null && "response" in aiResponse
      ? (aiResponse as { response: string }).response
      : String(aiResponse);

  const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/);
  let reply = rawText;
  let updatedTasks: unknown[] = tasks;

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as {
        actions?: unknown[];
        reply?: string;
      };
      if (parsed.reply) reply = parsed.reply;
      if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
        const bulkResp = await doFetch(stub, "/tasks/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.actions),
        });
        updatedTasks = await bulkResp.json<unknown[]>();
      }
    } catch {
      reply = rawText.replace(/```json[\s\S]*?```/g, "").trim();
    }
  } else {
    const refreshResp = await doFetch(stub, "/tasks");
    updatedTasks = await refreshResp.json<unknown[]>();
  }

  return c.json({ reply, tasks: updatedTasks });
});

// Fallback to static assets
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
