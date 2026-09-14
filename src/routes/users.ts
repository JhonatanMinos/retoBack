import { Router } from "express";
import { z } from "zod";
import { DB } from "../db";
import { ApiError } from "../errors";
import { idempotencyMiddleware } from "../middleware/idempotency";

const createUserSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  lastName: z.string().trim().min(1, "lastName is required"),
  email: z.string().trim().email("email must be a valid email"),
});

export function createUsersRouter(db: DB): Router {
  const router = Router();

  // POST /users
  router.post(
    "/",
    idempotencyMiddleware(db, async (req) => {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const { name, lastName, email } = parsed.data;

      const existing = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email);
      if (existing) {
        throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
      }

      const info = db
        .prepare("INSERT INTO users (name, last_name, email) VALUES (?, ?, ?)")
        .run(name, lastName, email);

      const user = db
        .prepare(
          `SELECT id, name, last_name AS lastName, email, created_at AS createdAt
           FROM users WHERE id = ?`,
        )
        .get(info.lastInsertRowid);

      return { status: 201, body: user };
    }),
  );

  // GET /users
  router.get("/", (_req, res) => {
    const users = db
      .prepare(
        `SELECT u.id,
                u.name,
                u.last_name AS lastName,
                u.email,
                u.created_at AS createdAt,
                (SELECT COUNT(*)
                   FROM task_assignments ta
                   JOIN tasks t ON t.id = ta.task_id
                  WHERE ta.user_id = u.id
                    AND t.status = 'open'
                    AND ta.completed = 0) AS pendingTasks
           FROM users u
          ORDER BY u.id`,
      )
      .all();
    res.json(users);
  });

  // GET /users/:idUser/tasks
  router.get("/:idUser/tasks", (req, res) => {
    const id = Number(req.params.idUser);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(400, "INVALID_ID", "Invalid user id");
    }

    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

    const tasks = (
      db
        .prepare(
          `SELECT t.id,
                  t.title,
                  t.description,
                  t.status,
                  ta.completed,
                  ta.completed_at AS completedAt
             FROM task_assignments ta
             JOIN tasks t ON t.id = ta.task_id
            WHERE ta.user_id = ?
              AND t.status != 'cancelled'
            ORDER BY t.id`,
        )
        .all(id) as Array<Record<string, unknown> & { completed: number }>
    ).map((t) => ({ ...t, completed: !!t.completed }));

    res.json(tasks);
  });

  return router;
}
