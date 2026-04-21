export interface Task {
  id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  status: "todo" | "in-progress" | "done";
  createdAt: string;
  dueDate?: string;
}

type BulkOp =
  | { action: "create"; title: string; description?: string; priority?: Task["priority"]; dueDate?: string }
  | { action: "update"; id: string; title?: string; description?: string; priority?: Task["priority"]; status?: Task["status"]; dueDate?: string }
  | { action: "delete"; id: string };

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export class TaskDurableObject implements DurableObject {
  private storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.storage = ctx.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const tasks = await this.getTasks();

    // GET /tasks
    if (method === "GET" && path === "/tasks") {
      return json(tasks);
    }

    // POST /tasks/bulk
    if (method === "POST" && path === "/tasks/bulk") {
      const body = await request.json<{ ops: BulkOp[] }>();
      const ops: BulkOp[] = Array.isArray(body) ? body : body.ops ?? [];
      for (const op of ops) {
        if (op.action === "create") {
          const task: Task = {
            id: makeId(),
            title: op.title,
            description: op.description ?? "",
            priority: op.priority ?? "medium",
            status: "todo",
            createdAt: new Date().toISOString(),
            dueDate: op.dueDate,
          };
          tasks.push(task);
        } else if (op.action === "update") {
          const idx = tasks.findIndex((t) => t.id === op.id);
          if (idx !== -1) {
            tasks[idx] = { ...tasks[idx], ...op, action: undefined } as Task;
          }
        } else if (op.action === "delete") {
          const idx = tasks.findIndex((t) => t.id === op.id);
          if (idx !== -1) tasks.splice(idx, 1);
        }
      }
      await this.saveTasks(tasks);
      return json(tasks);
    }

    // POST /tasks
    if (method === "POST" && path === "/tasks") {
      const body = await request.json<Partial<Task>>();
      const task: Task = {
        id: makeId(),
        title: body.title ?? "Untitled",
        description: body.description ?? "",
        priority: body.priority ?? "medium",
        status: "todo",
        createdAt: new Date().toISOString(),
        dueDate: body.dueDate,
      };
      tasks.push(task);
      await this.saveTasks(tasks);
      return json(task, 201);
    }

    // PATCH /tasks/:id
    const patchMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (method === "PATCH" && patchMatch) {
      const id = patchMatch[1];
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return json({ error: "Not found" }, 404);
      const body = await request.json<Partial<Task>>();
      tasks[idx] = { ...tasks[idx], ...body, id };
      await this.saveTasks(tasks);
      return json(tasks[idx]);
    }

    // DELETE /tasks/:id
    const deleteMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const id = deleteMatch[1];
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return json({ error: "Not found" }, 404);
      tasks.splice(idx, 1);
      await this.saveTasks(tasks);
      return json({ ok: true });
    }

    // DELETE /tasks (clear all)
    if (method === "DELETE" && path === "/tasks") {
      await this.saveTasks([]);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  private async getTasks(): Promise<Task[]> {
    const stored = await this.storage.get<Task[]>("tasks");
    return stored ?? [];
  }

  private async saveTasks(tasks: Task[]): Promise<void> {
    await this.storage.put("tasks", tasks);
  }
}
