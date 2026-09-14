import "dotenv/config";
import path from "path";
import { createDb, runMigrations } from "./index";

const dbFile = process.env.DB_FILE ?? path.join(process.cwd(), "data.sqlite");
const db = createDb(dbFile);
runMigrations(db);
console.log(`✅ Migrations applied to ${dbFile}`);
db.close();
