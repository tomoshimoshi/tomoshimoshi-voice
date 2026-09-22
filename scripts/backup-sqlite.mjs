import "dotenv/config";
import { backup, DatabaseSync } from "node:sqlite";
import { closeSync, openSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const destination = process.argv[2];
if (!destination) {
  console.error("Usage: npm run backup -- /private/path/tomoshimoshi-backup.sqlite");
  process.exit(1);
}
const target = resolve(destination);
const source = resolve(
  process.env.CALLORI_DATA_DIR || ".callori",
  "callori.sqlite",
);
if (target === source)
  throw new Error("Backup must not overwrite the live database.");
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
// Reserve a new private file. Never overwrite an existing backup.
closeSync(openSync(target, "wx", 0o600));
let database;
try {
  database = new DatabaseSync(source, { readOnly: true });
  await backup(database, target);
  chmodSync(target, 0o600);
  const verify = new DatabaseSync(target, { readOnly: true });
  try {
    if (verify.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Backup integrity check failed.");
  } finally {
    verify.close();
  }
  console.log(`Verified SQLite backup saved to ${target}`);
} catch (error) {
  rmSync(target, { force: true });
  throw error;
} finally {
  database?.close();
}
