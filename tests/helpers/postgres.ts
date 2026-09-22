import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mock, after } from "node:test";
import { readFile, readdir } from "node:fs/promises";
// Real PostgreSQL semantics in an isolated WASM database, never local credentials.
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.DATABASE_URL_POOLED = "";
export const testDatabase = new PGlite();
for (const file of (
  await readdir(new URL("../../db/migrations/", import.meta.url))
).sort()) {
  await testDatabase.exec(
    await readFile(
      new URL("../../db/migrations/" + file, import.meta.url),
      "utf8",
    ),
  );
}
let tail = Promise.resolve();
async function acquire() {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}
async function query(sql: string, values?: unknown[]) {
  const result = await testDatabase.query(sql, values);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
}
mock.method(
  pg.Pool.prototype,
  "query",
  async (sql: string, values?: unknown[]) => {
    const release = await acquire();
    try {
      return await query(sql, values);
    } finally {
      release();
    }
  },
);
mock.method(pg.Pool.prototype, "connect", async () => {
  const release = await acquire();
  return { query, release };
});
after(async () => {
  await tail;
  await testDatabase.close();
});
