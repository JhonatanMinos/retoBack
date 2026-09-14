import "dotenv/config";
import path from "path";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db";

const dbFile = process.env.DB_FILE ?? path.join(process.cwd(), "data.sqlite");
const db = createDb(dbFile);
runMigrations(db);

const app = createApp(db);
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`🚀 API listening on http://localhost:${port}`);
  console.log(`📦 DB: ${dbFile}`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received — shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
