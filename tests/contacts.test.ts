import { testDatabase } from "./helpers/postgres";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contactSchema } from "../lib/validation";
process.env.CALLORI_DATA_DIR = mkdtempSync(
  join(tmpdir(), "tomoshimoshi-contacts-"),
);
const store = await import("../server/store");
const userId = await store.ensureUser({
  sub: "auth0|contacts",
  email: "contacts@example.test",
  emailVerified: true,
});
after(() =>
  rmSync(process.env.CALLORI_DATA_DIR!, { recursive: true, force: true }),
);

test("saved contacts persist only place references, deduplicate, validate and enforce a bounded list", async () => {
  assert.equal(
    contactSchema.safeParse({ placeId: "test_place", country: "JP" }).success,
    true,
  );
  assert.equal(
    contactSchema.safeParse({ placeId: "test_place", country: "US" }).success,
    false,
  );
  assert.equal(
    contactSchema.safeParse({
      placeId: "test_place",
      country: "JP",
      phone: "+817012345678",
    }).success,
    false,
  );
  await store.saveContact("test_place", "JP", userId);
  await store.saveContact("test_place", "JP", userId);
  assert.equal((await store.contacts(userId)).length, 1);
  const columns = await testDatabase.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name='contacts' ORDER BY ordinal_position",
  );
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ["user_id", "place_id", "country", "created_at"],
  );
  for (let i = 1; i < 100; i++)
    await store.saveContact(`test_${i}`, "JP", userId);
  await assert.rejects(
    () => store.saveContact("overflow", "JP", userId),
    /CONTACT_LIMIT/,
  );
  await store.removeContact("test_place", userId);
  assert.equal((await store.contacts(userId)).length, 99);
});
