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
You are the backend of a task manager app. You receive user messages and output task operations as JSON.

You ARE the task management system. When a user says "add a task", you add it. You do not need any external tools.

OUTPUT RULE: Every single response must be a raw JSON object. No prose, no markdown, no explanation — only JSON.

JSON format:
{"actions":[...],"reply":"..."}

"actions" is an array of zero or more operations:
  Create: {"action":"create","title":"...","description":"...","priority":"low|medium|high","dueDate":"YYYY-MM-DD"}
  Update: {"action":"update","id":"EXACT_ID","status":"todo|in-progress|done","priority":"low|medium|high","title":"..."}
  Delete: {"action":"delete","id":"EXACT_ID"}

"reply" is a short, friendly confirmation or answer shown in the chat UI.

Current tasks in the system:
${tasksJson}

Today's date: ${new Date().toISOString().slice(0, 10)}

Examples:
User: "add a high priority task to fix the login bug"
Output: {"actions":[{"action":"create","title":"Fix login bug","description":"Resolve the authentication issue preventing users from logging in","priority":"high"}],"reply":"Added \\"Fix login bug\\" as a high-priority task!"}

User: "what are my tasks?"
Output: {"actions":[],"reply":"You have N tasks: [list them]"}

User: "mark the login bug as done"
Output: {"actions":[{"action":"update","id":"EXACT_ID_FROM_LIST","status":"done"}],"reply":"Marked \\"Fix login bug\\" as done!"}
`;

type RawAction = Record<string, unknown>;

function extractStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function normalizeActions(raw: unknown): RawAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((op) => {
    if (typeof op !== "object" || op === null) return null;
    let o = { ...(op as RawAction) };

    // If the AI packed fields into a nested "task" or "data" object, flatten it
    for (const key of ["task", "data", "fields", "details"]) {
      if (typeof o[key] === "object" && o[key] !== null) {
        o = { ...o, ...(o[key] as RawAction) };
        delete o[key];
      }
    }

    // Normalize action verb
    const verb = String(o.action ?? "").toLowerCase();
    let action: string;
    if (verb.includes("delet") || verb.includes("remov") || verb.includes("drop")) {
      action = "delete";
    } else if (verb.includes("updat") || verb.includes("edit") || verb.includes("mark") || verb.includes("chang") || verb.includes("set")) {
      action = "update";
    } else if (verb.includes("add") || verb.includes("creat") || verb.includes("new")) {
      action = "create";
    } else {
      // Unknown verb — infer from presence of an id field
      action = (typeof o.id === "string" && o.id.length > 0) ? "update" : "create";
    }

    // Extract and normalize title — cover every field name the model might use
    const title =
      extractStr(o.title) ||
      extractStr(o.name) ||
      extractStr(o.task) ||
      extractStr(o.label) ||
      extractStr(o.content) ||
      extractStr(o.summary) ||
      extractStr(o.text) ||
      extractStr(o.description) ||
      "Untitled";

    // Normalize priority to lowercase
    const priority = extractStr(o.priority).toLowerCase() || undefined;

    return { ...o, action, title, ...(priority ? { priority } : {}) };
  }).filter(Boolean) as RawAction[];
}

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
    {
      role: "user" as const,
      content: `${message}\n\n[Respond with JSON only: {"actions":[...],"reply":"..."}]`,
    },
  ];

  const aiResponse = await c.env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      system: SYSTEM_PROMPT(tasksJson),
      messages,
    } as Parameters<Ai["run"]>[1]
  );

  // Workers AI may return response as a pre-parsed object or as a string
  const aiObj = (typeof aiResponse === "object" && aiResponse !== null)
    ? (aiResponse as Record<string, unknown>)
    : null;
  const responseField = aiObj?.response;

  let parsed: { actions?: unknown[]; reply?: string } | null = null;

  if (typeof responseField === "object" && responseField !== null) {
    // Workers AI already parsed the JSON for us
    parsed = responseField as { actions?: unknown[]; reply?: string };
  } else {
    // String response — try to extract JSON from code block or raw
    const text = typeof responseField === "string" ? responseField
      : typeof aiResponse === "string" ? aiResponse : "";
    const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonMatch = text.match(/\{[\s\S]*"(?:actions|reply)"[\s\S]*\}/);
    const jsonStr = codeMatch ? codeMatch[1] : jsonMatch ? jsonMatch[0] : null;
    if (jsonStr) {
      try { parsed = JSON.parse(jsonStr); } catch { /* fall through */ }
    }
  }

  let reply = parsed?.reply ?? "";
  let updatedTasks: unknown[] = tasks;

  if (parsed) {
    const actions = normalizeActions(parsed.actions);
    if (actions.length > 0) {
      const bulkResp = await doFetch(stub, "/tasks/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(actions),
      });
      updatedTasks = await bulkResp.json<unknown[]>();
    } else {
      const refreshResp = await doFetch(stub, "/tasks");
      updatedTasks = await refreshResp.json<unknown[]>();
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
