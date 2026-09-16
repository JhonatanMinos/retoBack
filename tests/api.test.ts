import { beforeEach, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../src/app";
import { createDb, runMigrations } from "../src/db";
import type { DB } from "../src/db";

let db: DB;
let app: Application;

beforeEach(() => {
  process.env.NOTIFY_URL = "";
  process.env.NOTIFY_RETRY_BASE_MS = "50";
  db = createDb(":memory:");
  runMigrations(db);
  app = createApp(db);
});

afterEach(() => {
  db.close();
});

async function makeUser(
  overrides: Partial<{ name: string; lastName: string; email: string }> = {},
) {
  const body = {
    name: "Ada",
    lastName: "Lovelace",
    email: `u${Date.now()}${Math.random().toString(36).slice(2)}@x.com`,
    ...overrides,
  };
  const res = await request(app).post("/users").send(body);
  return res.body;
}

async function makeTask(title = "Task") {
  const res = await request(app).post("/tasks").send({ title });
  return res.body;
}

// ---------------------------------------------------------------------------
// POST /users
// ---------------------------------------------------------------------------
describe("POST /users", () => {
  it("creates a user and returns id + info", async () => {
    const res = await request(app)
      .post("/users")
      .send({ name: "A", lastName: "B", email: "a@b.com" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.email).toBe("a@b.com");
    expect(res.body.name).toBe("A");
    expect(res.body.lastName).toBe("B");
  });

  it("rejects invalid email", async () => {
    const res = await request(app)
      .post("/users")
      .send({ name: "A", lastName: "B", email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing fields", async () => {
    const res = await request(app).post("/users").send({ name: "A" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate email", async () => {
    await request(app)
      .post("/users")
      .send({ name: "A", lastName: "B", email: "dup@x.com" });
    const res = await request(app)
      .post("/users")
      .send({ name: "C", lastName: "D", email: "dup@x.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });
});

// ---------------------------------------------------------------------------
// POST /tasks
// ---------------------------------------------------------------------------
describe("POST /tasks", () => {
  it("creates an open task", async () => {
    const res = await request(app).post("/tasks").send({ title: "T1" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.id).toBeTypeOf("number");
  });

  it("rejects task without title", async () => {
    const res = await request(app).post("/tasks").send({ description: "x" });
    expect(res.status).toBe(400);
  });

  it("accepts optional description", async () => {
    const res = await request(app)
      .post("/tasks")
      .send({ title: "T", description: "details" });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe("details");
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:idTask/assign
// ---------------------------------------------------------------------------
describe("POST /tasks/:idTask/assign", () => {
  it("assigns users to a task", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const t = await makeTask();

    const res = await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/tasks/${t.id}`);
    expect(detail.body.assignedUsers).toHaveLength(2);
  });

  it("rejects unknown user", async () => {
    const t = await makeTask();
    const res = await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [999999] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("rejects unknown task", async () => {
    const u = await makeUser();
    const res = await request(app)
      .post(`/tasks/999999/assign`)
      .send({ userIds: [u.id] });
    expect(res.status).toBe(404);
  });

  it("does not duplicate an existing assignment", async () => {
    const u = await makeUser();
    const t = await makeTask();

    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });

    const detail = await request(app).get(`/tasks/${t.id}`);
    expect(detail.body.assignedUsers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:idTask/complete
// ---------------------------------------------------------------------------
describe("POST /tasks/:idTask/complete", () => {
  it("rejects non-assigned user", async () => {
    const u = await makeUser();
    const t = await makeTask();
    const res = await request(app)
      .post(`/tasks/${t.id}/complete`)
      .send({ userId: u.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("USER_NOT_ASSIGNED");
  });

  it("marks user part as complete", async () => {
    const u = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });

    const res = await request(app)
      .post(`/tasks/${t.id}/complete`)
      .send({ userId: u.id });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
  });

  it("does not archive until all assigned complete", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });

    const r1 = await request(app)
      .post(`/tasks/${t.id}/complete`)
      .send({ userId: u1.id });
    expect(r1.body.archived).toBe(false);

    const mid = await request(app).get(`/tasks/${t.id}`);
    expect(mid.body.status).toBe("open");

    const r2 = await request(app)
      .post(`/tasks/${t.id}/complete`)
      .send({ userId: u2.id });
    expect(r2.body.archived).toBe(true);

    const final = await request(app).get(`/tasks/${t.id}`);
    expect(final.body.status).toBe("archived");
    expect(final.body.archivedAt).toBeTruthy();
  });

  it("archives exactly once when last two complete in parallel", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });

    const [r1, r2] = await Promise.all([
      request(app).post(`/tasks/${t.id}/complete`).send({ userId: u1.id }),
      request(app).post(`/tasks/${t.id}/complete`).send({ userId: u2.id }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const archivedCount =
      (r1.body.archived ? 1 : 0) + (r2.body.archived ? 1 : 0);
    expect(archivedCount).toBe(1);

    const task = (await request(app).get(`/tasks/${t.id}`)).body;
    expect(task.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// GET /tasks
// ---------------------------------------------------------------------------
describe("GET /tasks", () => {
  it("filters by status", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const openT = await makeTask("Open");
    const doneT = await makeTask("Done");
    await request(app)
      .post(`/tasks/${doneT.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });
    await request(app)
      .post(`/tasks/${doneT.id}/complete`)
      .send({ userId: u1.id });
    await request(app)
      .post(`/tasks/${doneT.id}/complete`)
      .send({ userId: u2.id });

    const open = (await request(app).get("/tasks?status=open")).body;
    const archived = (await request(app).get("/tasks?status=archived")).body;

    expect(open.find((t: any) => t.id === openT.id)).toBeTruthy();
    expect(open.find((t: any) => t.id === doneT.id)).toBeUndefined();
    expect(archived.find((t: any) => t.id === doneT.id)).toBeTruthy();
  });

  it("rejects invalid status", async () => {
    const res = await request(app).get("/tasks?status=foo");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });

  it("lists assigned users with completion flag", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const t = await makeTask("T");
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });
    await request(app).post(`/tasks/${t.id}/complete`).send({ userId: u1.id });

    const list = (await request(app).get("/tasks")).body;
    const found = list.find((x: any) => x.id === t.id);
    expect(found.assignedUsers).toHaveLength(2);
    const completed = found.assignedUsers.filter((u: any) => u.completed);
    expect(completed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /users + GET /users/:idUser/tasks
// ---------------------------------------------------------------------------
describe("GET /users", () => {
  it("lists users with pendingTasks count", async () => {
    const u = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });

    const list = (await request(app).get("/users")).body;
    const found = list.find((x: any) => x.id === u.id);
    expect(found.pendingTasks).toBe(1);
  });

  it("lists user tasks with completion flag", async () => {
    const u = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });

    const list = (await request(app).get(`/users/${u.id}/tasks`)).body;
    expect(list).toHaveLength(1);
    expect(list[0].completed).toBe(false);
  });

  it("404 for unknown user", async () => {
    const res = await request(app).get("/users/999999/tasks");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
describe("Idempotency", () => {
  it("parallel POST /users with same key runs once", async () => {
    const body = { name: "Z", lastName: "Q", email: "z@q.com" };
    const key = "idem-user-parallel";

    const [r1, r2] = await Promise.all([
      request(app).post("/users").set("Idempotency-Key", key).send(body),
      request(app).post("/users").set("Idempotency-Key", key).send(body),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).toBe(r2.body.id);

    const count = db.prepare("SELECT COUNT(*) AS c FROM users").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it("sequential POST /tasks with same key returns same response", async () => {
    const body = { title: "IdemTask" };
    const key = "idem-task-seq";

    const r1 = await request(app)
      .post("/tasks")
      .set("Idempotency-Key", key)
      .send(body);
    const r2 = await request(app)
      .post("/tasks")
      .set("Idempotency-Key", key)
      .send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).toBe(r2.body.id);

    const count = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it("rejects key reused with different body", async () => {
    const key = "idem-conflict";
    await request(app)
      .post("/users")
      .set("Idempotency-Key", key)
      .send({ name: "A", lastName: "B", email: "a1@b.com" });

    const res = await request(app)
      .post("/users")
      .set("Idempotency-Key", key)
      .send({ name: "A", lastName: "B", email: "a2@b.com" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("parallel complete with same key runs once", async () => {
    const u = await makeUser();
    const t = await makeTask();
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });

    const key = "idem-complete";
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/tasks/${t.id}/complete`)
        .set("Idempotency-Key", key)
        .send({ userId: u.id }),
      request(app)
        .post(`/tasks/${t.id}/complete`)
        .set("Idempotency-Key", key)
        .send({ userId: u.id }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
describe("Notifications", () => {
  it("logs failing attempts when NOTIFY_URL is unreachable", async () => {
    process.env.NOTIFY_URL = "http://127.0.0.1:1/never"; // fail fast
    process.env.NOTIFY_RETRY_BASE_MS = "50";

    const u1 = await makeUser();
    const u2 = await makeUser();
    const t = await makeTask("N");
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u1.id, u2.id] });
    await request(app).post(`/tasks/${t.id}/complete`).send({ userId: u1.id });
    await request(app).post(`/tasks/${t.id}/complete`).send({ userId: u2.id });

    // Wait for 3 attempts with base 50ms (0 + 50 + 100) + margin
    await new Promise((r) => setTimeout(r, 800));

    const logs = (await request(app).get(`/tasks/${t.id}/notifications`)).body;
    expect(logs.length).toBe(3);
    expect(logs.map((l: any) => l.attempt)).toEqual([1, 2, 3]);
    expect(logs.every((l: any) => l.statusCode === null)).toBe(true);
    expect(logs.every((l: any) => typeof l.error === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DELETE /tasks/:idTask  (extra feature)
// ---------------------------------------------------------------------------
describe("DELETE /tasks/:idTask (soft delete)", () => {
  it("marks task as cancelled and hides it from listings", async () => {
    const t = await makeTask("to-cancel");

    const del = await request(app).delete(`/tasks/${t.id}`);
    expect(del.status).toBe(200);

    const list = (await request(app).get("/tasks")).body;
    expect(list.find((x: any) => x.id === t.id)).toBeUndefined();

    const detail = (await request(app).get(`/tasks/${t.id}`)).body;
    expect(detail.status).toBe("cancelled");
    expect(detail.cancelledAt).toBeTruthy();
  });

  it("cannot cancel an archived task", async () => {
    const u = await makeUser();
    const t = await makeTask("archived");
    await request(app)
      .post(`/tasks/${t.id}/assign`)
      .send({ userIds: [u.id] });
    await request(app).post(`/tasks/${t.id}/complete`).send({ userId: u.id });

    const del = await request(app).delete(`/tasks/${t.id}`);
    expect(del.status).toBe(409);
  });

  it("is idempotent", async () => {
    const t = await makeTask("idem-del");
    const r1 = await request(app).delete(`/tasks/${t.id}`);
    const r2 = await request(app).delete(`/tasks/${t.id}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
