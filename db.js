// db.js: node:sqlite (built into Node 22.5+), zero dependencies, no native build.
// WAL on a persistent volume is the same durability story as Pythia's cube.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// Read-only handle for the AI query path: writes fail at the engine level,
// not just by convention.
export function openDbReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

// Numbered .sql files (001-name.sql). user_version tracks the last applied
// number; files run in order inside a transaction each.
function migrate(db) {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort();
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (const f of files) {
    const n = parseInt(f, 10);
    if (n <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
}
