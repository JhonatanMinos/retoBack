import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export function createDb(filename: string) {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function runMigrations(db: Database.Database) {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(migrationsDir).sort();
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  );
  const applied = new Set(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r: any) => r.name),
  );
  const insert = db.prepare("INSERT INTO _migrations (name) VALUES (?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
    insert.run(file);
  }
}

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "..", "database.sqlite");

// Exportamos la instancia ya creada con el nombre DB
export const DB = createDb(dbPath);
