import { Router } from "express";
import { z } from "zod";
import { DB } from "../db";
import { ApiError } from "../errors";
import { idempotencyMiddleware } from "../middleware/idempotency";
import { dispatchNotification } from "../services/notifications";

const createTaskSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  description: z.string().optional(),
});

const assignSchema = z.object({
  userIds: z
    .array(z.number().int().positive())
    .min(1, "userIds must not be empty"),
});

const completeSchema = z.object({
  userId: z.number().int().positive(),
});

const statusSchema = z.enum(["open", "archived"]);

export function createTasksRouter(db: DB): Router {
  const router = Router();

  // ---------------------------------------------------------------
  // POST /tasks
  // ---------------------------------------------------------------
  router.post(
    "/",
    idempotencyMiddleware(db, async (req) => {
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const { title, description } = parsed.data;

      const info = db
        .prepare(
          `INSERT INTO tasks (title, description, status) VALUES (?, ?, 'open')`,
        )
        .run(title, description ?? null);

      const task = db
        .prepare(
          `SELECT id, title, description, status,
                  created_at AS createdAt, archived_at AS archivedAt
             FROM tasks WHERE id = ?`,
        )
        .get(info.lastInsertRowid);

      return { status: 201, body: task };
    }),
  );

  // ---------------------------------------------------------------
  // POST /tasks/:idTask/assign
  // ---------------------------------------------------------------
  router.post(
    "/:idTask/assign",
    idempotencyMiddleware(db, async (req) => {
      const taskId = Number(req.params.idTask);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new ApiError(400, "INVALID_ID", "Invalid task id");
      }

      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const { userIds } = parsed.data;

      const task = db
        .prepare("SELECT id, status FROM tasks WHERE id = ?")
        .get(taskId) as { id: number; status: string } | undefined;
      if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
      if (task.status !== "open") {
        throw new ApiError(
          409,
          "TASK_NOT_OPEN",
          "Only open tasks can be assigned",
        );
      }

      const checkUser = db.prepare("SELECT id FROM users WHERE id = ?");
      for (const uid of userIds) {
        if (!checkUser.get(uid)) {
          throw new ApiError(404, "USER_NOT_FOUND", `User ${uid} not found`);
        }
      }

      const insert = db.prepare(
        "INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)",
      );
      const tx = db.transaction((ids: number[]) => {
        for (const uid of ids) insert.run(taskId, uid);
      });
      tx(userIds);

      return { status: 200, body: { message: "Users assigned successfully" } };
    }),
  );

  // ---------------------------------------------------------------
  // POST /tasks/:idTask/complete
  // ---------------------------------------------------------------
  router.post(
    "/:idTask/complete",
    idempotencyMiddleware(db, async (req) => {
      const taskId = Number(req.params.idTask);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new ApiError(400, "INVALID_ID", "Invalid task id");
      }

      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const { userId } = parsed.data;

      const task = db
        .prepare("SELECT id, title, status FROM tasks WHERE id = ?")
        .get(taskId) as
        { id: number; title: string; status: string } | undefined;
      if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");

      const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
      if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

      const assignment = db
        .prepare(
          "SELECT completed FROM task_assignments WHERE task_id = ? AND user_id = ?",
        )
        .get(taskId, userId) as { completed: number } | undefined;
      if (!assignment) {
        throw new ApiError(
          400,
          "USER_NOT_ASSIGNED",
          "User is not assigned to this task",
        );
      }

      const now = new Date().toISOString();

      // 1. Mark user's part as complete (idempotent)
      db.prepare(
        `UPDATE task_assignments
            SET completed = 1, completed_at = ?
          WHERE task_id = ? AND user_id = ? AND completed = 0`,
      ).run(now, taskId, userId);

      // 2. Atomic archive: only one caller wins when the last users complete
      const archive = db.transaction((): string | null => {
        const pending = db
          .prepare(
            "SELECT COUNT(*) AS c FROM task_assignments WHERE task_id = ? AND completed = 0",
          )
          .get(taskId) as { c: number };
        if (pending.c > 0) return null;

        const t = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(taskId) as {
          status: string;
        };
        if (t.status !== "open") return null;

        const at = new Date().toISOString();
        const info = db
          .prepare(
            `UPDATE tasks SET status = 'archived', archived_at = ?
              WHERE id = ? AND status = 'open'`,
          )
          .run(at, taskId);

        return info.changes === 1 ? at : null;
      });

      const archivedAt = archive();

      // 3. Notify exactly once (fire and forget)
      if (archivedAt) {
        dispatchNotification(db, taskId, task.title, archivedAt).catch((e) =>
          console.error("[notify] failed", e),
        );
      }

      return {
        status: 200,
        body: {
          message: "Task completed",
          archived: archivedAt !== null,
          archivedAt,
        },
      };
    }),
  );

  // ---------------------------------------------------------------
  // GET /tasks?status=open|archived
  // ---------------------------------------------------------------
  router.get("/", (req, res) => {
    const raw = req.query.status;
    let status: "open" | "archived" | undefined;

    if (raw !== undefined) {
      const parsed = statusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "INVALID_STATUS",
          'status must be "open" or "archived"',
        );
      }
      status = parsed.data;
    }

    const rows = status
      ? db
          .prepare(
            `SELECT id, title, description, status,
                    created_at AS createdAt, archived_at AS archivedAt
               FROM tasks
              WHERE status = ?
              ORDER BY id`,
          )
          .all(status)
      : db
          .prepare(
            `SELECT id, title, description, status,
                    created_at AS createdAt, archived_at AS archivedAt
               FROM tasks
              WHERE status != 'cancelled'
              ORDER BY id`,
          )
          .all();

    const getUsers = db.prepare(
      `SELECT u.id,
              u.name,
              u.last_name AS lastName,
              u.email,
              ta.completed,
              ta.completed_at AS completedAt
         FROM task_assignments ta
         JOIN users u ON u.id = ta.user_id
        WHERE ta.task_id = ?
        ORDER BY u.id`,
    );

    res.json(
      (rows as Array<Record<string, unknown> & { id: number }>).map((t) => ({
        ...t,
        assignedUsers: (
          getUsers.all(t.id) as Array<
            Record<string, unknown> & { completed: number }
          >
        ).map((u) => ({ ...u, completed: !!u.completed })),
      })),
    );
  });

  // ---------------------------------------------------------------
  // GET /tasks/:idTask/notifications  (must be before /:idTask)
  // ---------------------------------------------------------------
  router.get("/:idTask/notifications", (req, res) => {
    const taskId = Number(req.params.idTask);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new ApiError(400, "INVALID_ID", "Invalid task id");
    }

    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");

    const rows = db
      .prepare(
        `SELECT id,
                attempt,
                status_code AS statusCode,
                error,
                created_at AS createdAt
           FROM notifications
          WHERE task_id = ?
          ORDER BY attempt`,
      )
      .all(taskId);

    res.json(rows);
  });

  // ---------------------------------------------------------------
  // DELETE /tasks/:idTask  →  soft delete (extra feature)
  // ---------------------------------------------------------------
  router.delete(
    "/:idTask",
    idempotencyMiddleware(db, async (req) => {
      const taskId = Number(req.params.idTask);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new ApiError(400, "INVALID_ID", "Invalid task id");
      }

      const task = db
        .prepare("SELECT id, status FROM tasks WHERE id = ?")
        .get(taskId) as { id: number; status: string } | undefined;
      if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
      if (task.status === "cancelled") {
        return { status: 200, body: { message: "Task already cancelled" } };
      }
      if (task.status !== "open") {
        throw new ApiError(
          409,
          "TASK_NOT_OPEN",
          "Only open tasks can be cancelled",
        );
      }

      const at = new Date().toISOString();
      db.prepare(
        `UPDATE tasks SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
      ).run(at, taskId);

      return {
        status: 200,
        body: { message: "Task cancelled", cancelledAt: at },
      };
    }),
  );

  // ---------------------------------------------------------------
  // GET /tasks/:idTask
  // ---------------------------------------------------------------
  router.get("/:idTask", (req, res) => {
    const taskId = Number(req.params.idTask);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new ApiError(400, "INVALID_ID", "Invalid task id");
    }

    const task = db
      .prepare(
        `SELECT id, title, description, status,
                created_at AS createdAt,
                archived_at AS archivedAt,
                cancelled_at AS cancelledAt
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as Record<string, unknown> | undefined;

    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");

    const users = (
      db
        .prepare(
          `SELECT u.id,
                  u.name,
                  u.last_name AS lastName,
                  u.email,
                  ta.completed,
                  ta.completed_at AS completedAt
             FROM task_assignments ta
             JOIN users u ON u.id = ta.user_id
            WHERE ta.task_id = ?
            ORDER BY u.id`,
        )
        .all(taskId) as Array<Record<string, unknown> & { completed: number }>
    ).map((u) => ({ ...u, completed: !!u.completed }));

    res.json({ ...task, assignedUsers: users });
  });

  return router;
}
