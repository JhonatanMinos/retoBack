import express, { Application } from "express";
import { DBType } from "./db";
import { createUsersRouter } from "./routes/users";
import { createTasksRouter } from "./routes/tasks";
import { errorHandler } from "./middleware/errorHandler";

export function createApp(db: DBType): Application {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/users", createUsersRouter(db));
  app.use("/tasks", createTasksRouter(db));

  // 404
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.use(errorHandler);

  return app;
}
