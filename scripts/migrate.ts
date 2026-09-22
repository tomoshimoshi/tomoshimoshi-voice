import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { connectionConfig } from "../server/database";
const client = new pg.Client(connectionConfig(true));
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(731398214)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const directory = new URL("../db/migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = await client.query(
      "SELECT checksum FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (prior.rows.length) {
      if (prior.rows[0].checksum !== checksum)
        throw new Error("Applied migration changed: " + name);
      continue;
    }
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
      [name, checksum],
    );
    console.log("Applied " + name);
  }
  await client.query("COMMIT");
  console.log("PostgreSQL schema is up to date.");
} catch {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    "Migration failed; transaction rolled back. Check connectivity and schema permissions.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
