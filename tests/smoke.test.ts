import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { createDb, runMigrations } from "../src/db";

describe("smoke", () => {
  it("can require better-sqlite3", () => {
    const D = require("better-sqlite3");
    const db = new D(":memory:");
    expect(db.prepare("select 1 as x").get()).toEqual({ x: 1 });
    db.close();
  });

  it("can create db via src/db", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    expect(db).toBeDefined();
    db.close();
  });

  it("can create app", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const app = createApp(db);
    expect(app).toBeDefined();
    db.close();
  });

  it("hits /health", async () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const app = createApp(db);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    db.close();
  });
});
