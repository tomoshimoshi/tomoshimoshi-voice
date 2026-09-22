import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { connectionConfig } from "../server/database";
import { defaultProfile } from "../lib/profile";
import { profileSchema } from "../lib/validation";
const sqlite = new DatabaseSync(
  resolve(process.env.CALLORI_DATA_DIR || ".callori", "callori.sqlite"),
  { readOnly: true },
);
const client = new pg.Client(connectionConfig(true));
const email = "leodcastaneda@gmail.com";
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(731398214)");
  const done = await client.query(
    "SELECT 1 FROM data_imports WHERE name='sqlite-v1'",
  );
  if (done.rows.length) {
    console.log("SQLite import already completed; no changes.");
  } else {
    const legacyCalls = sqlite
      .prepare("SELECT data FROM calls")
      .all()
      .map((row) => JSON.parse(String(row.data)));
    if (
      legacyCalls.some(
        (call) => !["completed", "failed", "cancelled"].includes(call.status),
      )
    )
      throw new Error("Finish active calls before importing");
    const pending = sqlite
      .prepare("SELECT count(*) AS n FROM provider_calls")
      .get();
    if (Number(pending?.n))
      throw new Error("Resolve pending provider calls before importing");
    const existing = await client.query(
      "SELECT id FROM users WHERE legacy_owner",
    );
    let id = existing.rows[0]?.id;
    if (!id) {
      // If the verified owner has already signed in, preserve that account.
      const verified = await client.query(
        "SELECT id FROM users WHERE lower(email)=$1 AND email_verified FOR UPDATE",
        [email],
      );
      if (verified.rows.length > 1)
        throw new Error("Ambiguous verified legacy owner");
      id = verified.rows[0]?.id || randomUUID();
      if (verified.rows.length)
        await client.query("UPDATE users SET legacy_owner=true WHERE id=$1", [
          id,
        ]);
      else
        await client.query(
          "INSERT INTO users(id,email,legacy_owner) VALUES($1,$2,true)",
          [id, email],
        );
    }
    const row = sqlite.prepare("SELECT data FROM profile WHERE id=1").get();
    const personal = profileSchema.parse(
      row ? JSON.parse(String(row.data)) : defaultProfile,
    );
    await client.query(
      "INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
      [id, JSON.stringify(personal)],
    );
    for (const call of legacyCalls) {
      await client.query(
        "INSERT INTO calls(id,user_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)",
        [call.id, id, call.status, call.createdAt, JSON.stringify(call)],
      );
    }
    for (const row of sqlite.prepare("SELECT * FROM requests").all()) {
      // Ignore old development request keys that are not UUIDs.
      if (/^[0-9a-f-]{36}$/.test(String(row.key)))
        await client.query(
          "INSERT INTO requests(user_id,key,call_id) VALUES($1,$2,$3)",
          [id, row.key, row.call_id],
        );
    }
    const contacts = sqlite.prepare("SELECT * FROM contacts").all();
    for (const row of contacts)
      await client.query(
        "INSERT INTO contacts(user_id,place_id,country,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [id, row.place_id, row.country, row.created_at],
      );
    await client.query("INSERT INTO data_imports(name) VALUES('sqlite-v1')");
    console.log(
      `Imported one profile, ${legacyCalls.length} calls and ${contacts.length} contacts. Owner reserved for verified ${email}.`,
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    "Import rolled back; original SQLite unchanged.",
    error instanceof Error && !("code" in error)
      ? error.message
      : "Check database connectivity and schema.",
  );
  process.exitCode = 1;
} finally {
  sqlite.close();
  await client.end();
}
