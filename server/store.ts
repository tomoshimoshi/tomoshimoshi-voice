import { randomUUID } from "node:crypto";
import type { Call, Profile } from "../lib/types";
import { defaultProfile, profileComplete } from "../lib/profile";
import { database } from "./database";
export { defaultProfile } from "../lib/profile";
export type Identity = { sub: string; email: string; emailVerified: boolean };
import { transaction } from "./transaction";
export { transaction } from "./transaction";
import { authorizeCall } from "./calls/billing";
export async function ensureUser(identity: Identity): Promise<string> {
  return transaction(async (client) => {
    // A stable subject identifies the account; matching email alone never merges users.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      identity.sub,
    ]);
    const existing = await client.query(
      "SELECT id FROM users WHERE auth0_sub=$1",
      [identity.sub],
    );
    if (
      identity.emailVerified &&
      identity.email.toLowerCase() === "leodcastaneda@gmail.com"
    ) {
      const reserved = await client.query(
        "SELECT id FROM users WHERE legacy_owner AND auth0_sub IS NULL AND lower(email)=$1 FOR UPDATE",
        [identity.email.toLowerCase()],
      );
      if (reserved.rows[0]) {
        const legacyId = reserved.rows[0].id;
        if (!existing.rows[0]) {
          await client.query(
            "UPDATE users SET auth0_sub=$1,email_verified=true,updated_at=now() WHERE id=$2",
            [identity.sub, legacyId],
          );
          return legacyId;
        }
        // The same Auth0 subject may have explored the app before verifying email.
        const id = existing.rows[0].id;
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          "INSERT INTO profiles(user_id,data) SELECT $1,data FROM profiles WHERE user_id=$2 ON CONFLICT(user_id) DO UPDATE SET data=CASE WHEN btrim(profiles.data->>'firstName')<>'' AND btrim(profiles.data->>'lastName')<>'' THEN profiles.data ELSE excluded.data END",
          [id, legacyId],
        );
        await client.query(
          "INSERT INTO contacts(user_id,place_id,country,created_at) SELECT $1,place_id,country,created_at FROM contacts WHERE user_id=$2 ON CONFLICT DO NOTHING",
          [id, legacyId],
        );
        await client.query("UPDATE calls SET user_id=$1 WHERE user_id=$2", [
          id,
          legacyId,
        ]);
        await client.query("UPDATE requests SET user_id=$1 WHERE user_id=$2", [
          id,
          legacyId,
        ]);
        await client.query(
          "UPDATE call_consents SET user_id=$1 WHERE user_id=$2",
          [id, legacyId],
        );
        // Imported ownership can remove only a pristine wallet, never transfer credit
        // or erase a financial history. A funded legacy account requires review.
        await client.query(
          "DELETE FROM wallets w WHERE user_id=$1 AND available_balance=0 AND reserved_balance=0 AND NOT EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.wallet_id=w.id) AND NOT EXISTS (SELECT 1 FROM wallet_reservations r WHERE r.wallet_id=w.id)",
          [legacyId],
        );
        await client.query("DELETE FROM users WHERE id=$1", [legacyId]);
        await client.query("UPDATE users SET legacy_owner=true WHERE id=$1", [
          id,
        ]);
      }
    }
    if (existing.rows[0]) {
      await client.query(
        "UPDATE users SET email=$2,email_verified=$3,updated_at=now() WHERE id=$1 AND (email<>$2 OR email_verified<>$3)",
        [existing.rows[0].id, identity.email, identity.emailVerified],
      );
      return existing.rows[0].id;
    }
    const id = randomUUID();
    await client.query(
      "INSERT INTO users(id,auth0_sub,email,email_verified) VALUES($1,$2,$3,$4)",
      [id, identity.sub, identity.email, identity.emailVerified],
    );
    return id;
  });
}
export async function profile(userId: string): Promise<Profile> {
  const { rows } = await database().query(
    "SELECT data FROM profiles WHERE user_id=$1",
    [userId],
  );
  return rows[0]?.data || { ...defaultProfile };
}
export async function saveProfile(value: Profile, userId: string) {
  await database().query(
    "INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=now()",
    [userId, JSON.stringify(value)],
  );
  return value;
}
export async function calls(
  userId: string,
  limit = 100,
  before?: string,
  beforeId = "ffffffff-ffff-ffff-ffff-ffffffffffff",
  summaries = false,
): Promise<Call[]> {
  const { rows } = await database().query(
    "SELECT CASE WHEN $5 THEN (data - 'transcript') || '{\"transcript\":[]}'::jsonb ELSE data END AS data FROM calls_with_billing WHERE user_id=$1 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $2",
    [userId, limit, before || null, beforeId, summaries],
  );
  return rows.map((row) => row.data);
}
export async function activeCalls(): Promise<Call[]> {
  return (
    await database().query(
      "SELECT data FROM calls_with_billing WHERE status IN ('dialing','connected','waiting')",
    )
  ).rows.map((row) => row.data);
}
// Unscoped access is exclusively for authenticated provider callbacks and recovery.
export async function getCall(
  id: string,
  userId?: string,
): Promise<Call | undefined> {
  const { rows } = await database().query(
    "SELECT data FROM calls_with_billing WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)",
    [id, userId || null],
  );
  return rows[0]?.data;
}
export async function saveCall(call: Call) {
  await database().query("UPDATE calls SET data=$2,status=$3 WHERE id=$1", [
    call.id,
    JSON.stringify(call),
    call.status,
  ]);
  return call;
}
export async function saveTranslation(
  id: string,
  entryId: string,
  translations: Record<string, string>,
) {
  await database().query(
    `UPDATE calls SET data=jsonb_set(data,'{transcript}',(SELECT coalesce(jsonb_agg(CASE WHEN line->>'id'=$2 THEN line || jsonb_build_object('translations',$3::jsonb) ELSE line END ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(data->'transcript') WITH ORDINALITY AS entries(line,ordinal))) WHERE id=$1`,
    [id, entryId, JSON.stringify(translations)],
  );
}
export async function reserveCall(call: Call, userId: string, key: string) {
  return transaction(async (client) => {
    const user = await client.query(
      "SELECT last_call_at FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    const prior = await client.query(
      "SELECT c.data FROM requests r JOIN calls_with_billing c ON c.id=r.call_id WHERE r.user_id=$1 AND r.key=$2",
      [userId, key],
    );
    if (prior.rows[0])
      return { call: prior.rows[0].data as Call, created: false };
    const p = await client.query("SELECT data FROM profiles WHERE user_id=$1", [
      userId,
    ]);
    if (!profileComplete(p.rows[0]?.data || defaultProfile))
      throw new Error("PROFILE_REQUIRED");
    const active = await client.query(
      "SELECT 1 FROM calls_with_billing WHERE user_id=$1 AND status IN ('dialing','connected','waiting')",
      [userId],
    );
    if (active.rows.length) throw new Error("ACTIVE_CALL");
    if (
      user.rows[0]?.last_call_at &&
      Date.now() - new Date(user.rows[0].last_call_at).getTime() < 30000
    )
      throw new Error("RATE_LIMIT");
    await client.query(
      "INSERT INTO calls(id,user_id,status,created_at,data) VALUES($1,$2,$3,$4,$5)",
      [call.id, userId, call.status, call.createdAt, JSON.stringify(call)],
    );
    call.billing = await authorizeCall(client, call.id, userId);
    await client.query(
      "INSERT INTO requests(user_id,key,call_id) VALUES($1,$2,$3)",
      [userId, key, call.id],
    );
    await client.query(
      "INSERT INTO call_consents(call_id,user_id,share_profile) VALUES($1,$2,$3)",
      [call.id, userId, call.shareProfile],
    );
    await client.query("UPDATE users SET last_call_at=now() WHERE id=$1", [
      userId,
    ]);
    return { call, created: true };
  });
}
export async function requestCall(key: string, userId: string) {
  const { rows } = await database().query(
    "SELECT c.data FROM requests r JOIN calls_with_billing c ON c.id=r.call_id WHERE r.user_id=$1 AND r.key=$2",
    [userId, key],
  );
  return rows[0]?.data as Call | undefined;
}
export async function seenEvent(id: string) {
  const result = await database().query(
    "INSERT INTO webhooks(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
    [id],
  );
  return !result.rows.length;
}
export async function forgetEvent(id: string) {
  await database().query("DELETE FROM webhooks WHERE id=$1", [id]);
}
export async function pruneEvents() {
  await database().query(
    "DELETE FROM webhooks WHERE received < now()-interval '1 day'",
  );
}
export async function saveControl(id: string, controlId: string) {
  await transaction(async (tx) => {
    const billing = (
      await tx.query(
        "SELECT provider_control_id FROM call_billing WHERE call_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      billing?.provider_control_id &&
      billing.provider_control_id !== controlId
    )
      throw new Error("CALL_PROVIDER_MISMATCH");
    await tx.query(
      "UPDATE call_billing SET provider_control_id=$2 WHERE call_id=$1",
      [id, controlId],
    );
    await tx.query(
      "INSERT INTO provider_calls(id,control_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET control_id=excluded.control_id",
      [id, controlId],
    );
  });
}
export async function getControl(id: string) {
  return (
    await database().query(
      "SELECT control_id FROM provider_calls WHERE id=$1",
      [id],
    )
  ).rows[0]?.control_id as string | undefined;
}
export async function hangupCommand(id: string): Promise<string> {
  const command = randomUUID();
  return (
    (
      await database().query(
        "UPDATE provider_calls SET hangup_id=coalesce(hangup_id,$2) WHERE id=$1 RETURNING hangup_id",
        [id, command],
      )
    ).rows[0]?.hangup_id || command
  );
}
export async function clearControl(id: string) {
  await database().query("DELETE FROM provider_calls WHERE id=$1", [id]);
}
export async function pendingControls(): Promise<
  { id: string; control_id: string }[]
> {
  return (await database().query("SELECT id,control_id FROM provider_calls"))
    .rows;
}
export async function contacts(userId: string) {
  return (
    await database().query(
      'SELECT place_id AS "placeId",country,created_at AS "createdAt" FROM contacts WHERE user_id=$1 ORDER BY created_at DESC',
      [userId],
    )
  ).rows;
}
export async function saveContact(
  placeId: string,
  country: string,
  userId: string,
) {
  await transaction(async (client) => {
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const result = await client.query(
      "SELECT count(*)::int AS n,coalesce(bool_or(place_id=$2),false) AS exists FROM contacts WHERE user_id=$1",
      [userId, placeId],
    );
    if (!result.rows[0].exists && result.rows[0].n >= 100)
      throw new Error("CONTACT_LIMIT");
    await client.query(
      "INSERT INTO contacts(user_id,place_id,country) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [userId, placeId, country],
    );
  });
  return contacts(userId);
}
export async function removeContact(placeId: string, userId: string) {
  await database().query(
    "DELETE FROM contacts WHERE user_id=$1 AND place_id=$2",
    [userId, placeId],
  );
  return contacts(userId);
}
