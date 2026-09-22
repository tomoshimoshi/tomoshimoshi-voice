import { testDatabase } from "./helpers/postgres";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import * as store from "../server/store";
import { signIdentity, verifyIdentity } from "../lib/internal-identity";
import { profileComplete } from "../lib/profile";
import type { Call } from "../lib/types";
process.env.CALLORI_INTERNAL_TOKEN =
  "test-identity-secret-at-least-32-characters";
const alice = await store.ensureUser({
  sub: "auth0|alice",
  email: "alice@example.test",
  emailVerified: true,
});
const bob = await store.ensureUser({
  sub: "auth0|bob",
  email: "bob@example.test",
  emailVerified: true,
});
function call(): Call {
  return {
    id: randomUUID(),
    phone: "+817012345678",
    objective: "Ask about opening hours",
    context: "",
    constraints: "",
    language: "ja",
    mode: "live",
    shareProfile: false,
    scenario: "inquiry",
    status: "dialing",
    createdAt: new Date().toISOString(),
    transcript: [],
    uiLanguage: "en",
  };
}
test("profiles and contacts are isolated, new users never inherit legacy data", async () => {
  assert.equal(profileComplete(await store.profile(alice)), false);
  await store.saveProfile(
    { ...store.defaultProfile, firstName: "Alice", lastName: "Example" },
    alice,
  );
  assert.equal((await store.profile(bob)).firstName, "");
  await store.saveContact("place_alice", "JP", alice);
  await store.removeContact("place_alice", bob);
  assert.equal((await store.contacts(alice)).length, 1);
  assert.equal((await store.contacts(bob)).length, 0);
});
test("profile guard, atomic concurrent reservations, owner scoping and consent", async () => {
  await assert.rejects(
    store.reserveCall(call(), bob, randomUUID()),
    /PROFILE_REQUIRED/,
  );
  assert.equal((await store.calls(bob)).length, 0);
  const { credit } = await import("../server/wallet");
  await store.transaction((tx) =>
    credit(tx, alice, 1000n, {
      type: "fixture",
      id: randomUUID(),
      key: randomUUID(),
    }),
  );
  const key = randomUUID();
  const results = await Promise.all([
    store.reserveCall(call(), alice, key),
    store.reserveCall(call(), alice, key),
  ]);
  assert.equal(results.filter((x) => x.created).length, 1);
  assert.equal(results[0].call.id, results[1].call.id);
  const id = results[0].call.id;
  assert.equal(await store.getCall(id, bob), undefined);
  assert.equal(await store.requestCall(key, bob), undefined);
  assert.equal((await store.requestCall(key, alice))?.id, id);
  await assert.rejects(
    store.reserveCall(call(), alice, randomUUID()),
    /ACTIVE_CALL/,
  );
  const consent = await testDatabase.query<{
    share_profile: boolean;
    user_id: string;
  }>("SELECT * FROM call_consents WHERE call_id=$1", [id]);
  assert.equal(consent.rows[0].share_profile, false);
  assert.equal(consent.rows[0].user_id, alice);
  await store.saveCall({ ...results[0].call, status: "completed" });
  await assert.rejects(
    store.reserveCall(call(), alice, randomUUID()),
    /RATE_LIMIT/,
  );
});
test("only a verified owner can claim the imported profile; same-email identities do not merge", async () => {
  const id = randomUUID();
  await testDatabase.query(
    "INSERT INTO users(id,email,legacy_owner) VALUES($1,'leodcastaneda@gmail.com',true)",
    [id],
  );
  await store.saveProfile(
    { ...store.defaultProfile, firstName: "Reserved", lastName: "Owner" },
    id,
  );
  const unverified = await store.ensureUser({
    sub: "auth0|unverified",
    email: "leodcastaneda@gmail.com",
    emailVerified: false,
  });
  assert.notEqual(unverified, id);
  assert.equal((await store.profile(unverified)).firstName, "");
  const owner = await store.ensureUser({
    sub: "auth0|unverified",
    email: "leodcastaneda@gmail.com",
    emailVerified: true,
  });
  assert.equal(owner, unverified);
  assert.equal((await store.profile(owner)).firstName, "Reserved");
  const other = await store.ensureUser({
    sub: "auth0|other",
    email: "leodcastaneda@gmail.com",
    emailVerified: true,
  });
  assert.notEqual(other, owner);
  assert.equal((await store.profile(other)).firstName, "");
});
test("internal identities reject tampering, expiration and unsigned user headers", () => {
  const token = signIdentity({
    sub: "auth0|alice",
    email: "alice@example.test",
    email_verified: true,
  });
  assert.equal(verifyIdentity(token)?.emailVerified, true);
  assert.equal(verifyIdentity(token + "x"), undefined);
  assert.equal(verifyIdentity("auth0|alice"), undefined);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "auth0|alice",
      email: "alice@example.test",
      emailVerified: true,
      exp: Date.now() - 1000,
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", process.env.CALLORI_INTERNAL_TOKEN!)
    .update(payload)
    .digest("base64url");
  assert.equal(verifyIdentity(`${payload}.${sig}`), undefined);
});

test("history pagination uses ID to avoid skipping calls with the same timestamp and omits transcripts", async () => {
  const timestamp = "2025-01-01T00:00:00.000Z";
  const owner = await store.ensureUser({
    sub: "auth0|history",
    email: "history@example.test",
    emailVerified: true,
  });
  for (let i = 0; i < 3; i++) {
    const record = {
      ...call(),
      status: "completed",
      createdAt: timestamp,
      transcript: [
        {
          id: randomUUID(),
          role: "user",
          original: "Private transcript",
          translations: {},
          at: timestamp,
        },
      ],
    };
    await testDatabase.query(
      "INSERT INTO calls(id,user_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)",
      [record.id, owner, record.status, timestamp, JSON.stringify(record)],
    );
  }
  const first = await store.calls(owner, 2, undefined, undefined, true);
  assert.equal(first.length, 2);
  assert.deepEqual(first[0].transcript, []);
  const second = await store.calls(
    owner,
    2,
    first[1].createdAt,
    first[1].id,
    true,
  );
  assert.equal(second.length, 1);
  assert.equal(new Set([...first, ...second].map((x) => x.id)).size, 3);
  assert.equal(
    (await store.getCall(second[0].id, owner))?.transcript.length,
    1,
  );
});

test("late transcript translations preserve terminal state and other transcript entries", async () => {
  const owner = await store.ensureUser({
    sub: "auth0|translation",
    email: "translation@example.test",
    emailVerified: true,
  });
  const id = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  const record = {
    ...call(),
    id,
    status: "completed",
    transcript: [
      {
        id: first,
        role: "agent",
        original: "Hello",
        translations: {},
        at: new Date().toISOString(),
      },
      {
        id: second,
        role: "recipient",
        original: "Yes",
        translations: {},
        at: new Date().toISOString(),
      },
    ],
  };
  await testDatabase.query(
    "INSERT INTO calls(id,user_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)",
    [id, owner, record.status, record.createdAt, JSON.stringify(record)],
  );
  await Promise.all([
    store.saveTranslation(id, first, { en: "Hello", es: "Hola" }),
    store.saveTranslation(id, second, { en: "Yes", es: "Sí" }),
  ]);
  const saved = await store.getCall(id, owner);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.transcript[0].translations.es, "Hola");
  assert.equal(saved?.transcript[1].translations.es, "Sí");
});
