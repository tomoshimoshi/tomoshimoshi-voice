import "dotenv/config";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { internalToken } from "../lib/internal-token";
import {
  answerSchema,
  callSchema,
  profileSchema,
  contactSchema,
} from "../lib/validation";
import { terminal } from "../lib/types";
import {
  answerUser,
  attachMedia,
  authorizeMedia,
  createCall,
  endCall,
  recoverCalls,
  recoverOrphanedCalls,
  remoteHangup,
  sessions,
  update,
  flushCall,
  storageHealthy,
} from "./engine";
import {
  calls,
  ensureUser,
  forgetEvent,
  pruneEvents,
  getCall,
  profile,
  requestCall,
  saveProfile,
  seenEvent,
  saveControl,
  getControl,
  pendingControls,
  contacts,
  saveContact,
  removeContact,
} from "./store";
import { readiness, safeEqual, verifyWebhook } from "./security";
import { verifyIdentity } from "../lib/internal-identity";
import { profileComplete } from "../lib/profile";
import { database, closeDatabase, connectionConfig } from "./database";
import pg from "pg";
import {
  checkout,
  checkoutInput,
  processStripeEvent,
  walletSummary,
  paymentStatus,
} from "./billing/payments";
import { verifiedStripeEvent } from "./billing/stripe";
import { BillingConfigurationError } from "./billing/stripe/config";
import { billingLog } from "./billing/events";
import { observeCallEvent } from "./calls/billing";
import { voiceListener } from "./listener";
const token = internalToken();
const listener = voiceListener();
let accepting = false;
let shuttingDown = false;
let recoveryTimer: NodeJS.Timeout | undefined = undefined;
async function body(req: IncomingMessage, limit = 32768) {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      let healthy = accepting && storageHealthy();
      if (healthy) {
        try {
          await database().query("SELECT 1");
        } catch {
          healthy = false;
        }
      }
      return json(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "starting_stopping_or_unavailable",
      });
    }
    if (!accepting) return json(res, 503, { error: "SERVICE_UNAVAILABLE" });
    if (url.pathname === "/webhooks/stripe" && req.method === "POST") {
      const raw = await body(req, 262144);
      let event;
      try {
        event = verifiedStripeEvent(
          raw,
          String(req.headers["stripe-signature"] || ""),
        );
      } catch (error) {
        if (error instanceof BillingConfigurationError) throw error;
        return json(res, 400, { error: "INVALID_SIGNATURE" });
      }
      try {
        await processStripeEvent(event);
      } catch (error) {
        billingLog("payment.webhook_failed", { eventId: event.id });
        throw error;
      }
      return json(res, 200, { received: true });
    }
    if (url.pathname === "/webhooks/telnyx" && req.method === "POST") {
      const raw = await body(req);
      if (
        !verifyWebhook(
          raw,
          String(req.headers["telnyx-timestamp"] || ""),
          String(req.headers["telnyx-signature-ed25519"] || ""),
          process.env.TELNYX_PUBLIC_KEY || "",
        )
      )
        return json(res, 401, { error: "INVALID_SIGNATURE" });
      const event = z
        .object({
          data: z.object({
            id: z.string().min(1),
            event_type: z.string(),
            occurred_at: z.string(),
            payload: z
              .object({
                call_control_id: z.string(),
                client_state: z.string().optional(),
              })
              .passthrough(),
          }),
        })
        .parse(JSON.parse(raw)).data;
      const billingId = event.payload.client_state
        ? Buffer.from(event.payload.client_state, "base64").toString()
        : [...sessions.entries()].find(
            ([, s]) => s.controlId === event.payload.call_control_id,
          )?.[0];
      if (billingId && z.uuid().safeParse(billingId).success) {
        await observeCallEvent({
          callId: billingId,
          eventId: event.id,
          type: event.event_type,
          at: event.occurred_at,
          controlId: event.payload.call_control_id,
          cause:
            typeof event.payload.hangup_cause === "string"
              ? event.payload.hangup_cause
              : undefined,
        });
      }
      if (await seenEvent(event.id)) return json(res, 200, { ok: true });
      try {
        const id = event.payload.client_state
          ? Buffer.from(event.payload.client_state, "base64").toString()
          : [...sessions.entries()].find(
              ([, s]) => s.controlId === event.payload.call_control_id,
            )?.[0];
        if (id && (await getCall(id))?.mode === "live") {
          const knownControl = await getControl(id);
          if (knownControl && knownControl !== event.payload.call_control_id)
            return json(res, 200, { ok: true });
          if (event.event_type === "call.hangup") {
            await remoteHangup(id);
          } else if (
            ["call.initiated", "call.answered"].includes(event.event_type)
          ) {
            await saveControl(id, event.payload.call_control_id);
            const session = sessions.get(id);
            if (session) session.controlId = event.payload.call_control_id;
            if (terminal((await getCall(id))!.status))
              void recoverOrphanedCalls().catch(() =>
                console.error("Recovery check failed"),
              );
            else if (event.event_type === "call.answered")
              update(id, (c) => {
                if (c.status === "dialing") c.status = "connected";
              });
          }
        }
        if (id) await flushCall(id);
      } catch (error) {
        await forgetEvent(event.id);
        throw error;
      }
      return json(res, 200, { ok: true });
    }
    if (!safeEqual(String(req.headers.authorization || ""), `Bearer ${token}`))
      return json(res, 401, { error: "UNAUTHORIZED" });
    const identity = verifyIdentity(
      String(req.headers["x-callori-identity"] || ""),
    );
    if (!identity) return json(res, 401, { error: "UNAUTHORIZED" });
    const userId = await ensureUser(identity);
    if (req.method === "GET" && url.pathname === "/wallet")
      return json(res, 200, await walletSummary(userId));
    if (req.method === "POST" && url.pathname === "/billing/checkout") {
      const input = checkoutInput.parse(JSON.parse(await body(req)));
      const key = z.uuid().parse(req.headers["idempotency-key"]);
      return json(res, 200, await checkout(userId, input.packageCode, key));
    }
    const paymentMatch = url.pathname.match(
      /^\/billing\/payments\/([0-9a-f-]{36})$/,
    );
    if (req.method === "GET" && paymentMatch) {
      const payment = await paymentStatus(userId, paymentMatch[1]);
      return json(res, payment ? 200 : 404, payment || { error: "NOT_FOUND" });
    }
    if (req.method === "GET" && url.pathname === "/state") {
      const [history, personal, pending, wallet] = await Promise.all([
        calls(userId, 51, undefined, undefined, true),
        profile(userId),
        pendingControls(),
        walletSummary(userId),
      ]);
      const pendingCalls = await Promise.all(
        pending.map((row) => getCall(row.id)),
      );
      const recovered = pendingCalls.every(
        (call) => call && !terminal(call.status),
      );
      const configured = readiness();
      return json(res, 200, {
        calls: history.slice(0, 50),
        wallet,
        hasMoreCalls: history.length > 50,
        profile: personal,
        profileComplete: profileComplete(personal),
        emailVerified: identity.emailVerified,
        readiness: {
          ready: configured.ready && recovered && storageHealthy(),
          checks: [
            ...configured.checks,
            { name: "CALL_RECOVERY", configured: recovered },
          ],
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/calls") {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(url.searchParams.get("limit") || 50);
      const before = z.iso
        .datetime()
        .optional()
        .parse(url.searchParams.get("before") || undefined);
      const beforeId = z
        .string()
        .uuid()
        .optional()
        .parse(url.searchParams.get("beforeId") || undefined);
      return json(res, 200, await calls(userId, limit, before, beforeId, true));
    }
    if (req.method === "GET" && url.pathname === "/maps-config")
      return json(res, 200, {
        key: process.env.GOOGLE_MAPS_BROWSER_KEY || "",
        mapId: process.env.GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
      });
    if (req.method === "GET" && url.pathname === "/contacts")
      return json(res, 200, await contacts(userId));
    if (
      req.method === "POST" &&
      ["/contacts", "/contacts/remove"].includes(url.pathname)
    ) {
      const input = contactSchema.parse(JSON.parse(await body(req)));
      return json(
        res,
        200,
        url.pathname === "/contacts"
          ? await saveContact(input.placeId, input.country, userId)
          : await removeContact(input.placeId, userId),
      );
    }
    if (req.method === "PUT" && url.pathname === "/profile")
      return json(
        res,
        200,
        await saveProfile(
          profileSchema.parse(JSON.parse(await body(req))),
          userId,
        ),
      );
    if (req.method === "POST" && url.pathname === "/calls") {
      if (!identity.emailVerified)
        return json(res, 403, { error: "EMAIL_UNVERIFIED" });
      const key = z.string().uuid().parse(req.headers["idempotency-key"]);
      const prior = await requestCall(key, userId);
      if (prior) return json(res, 200, prior);
      const input = callSchema.parse(JSON.parse(await body(req)));
      if (!profileComplete(await profile(userId)))
        return json(res, 409, { error: "PROFILE_REQUIRED" });
      const call = await createCall(input, key, userId);
      return json(res, 201, call);
    }
    const match = url.pathname.match(
      /^\/calls\/([0-9a-f-]{36})(?:\/(answer|cancel))?$/,
    );
    if (match) {
      const id = match[1];
      if (!(await getCall(id, userId)))
        return json(res, 404, { error: "NOT_FOUND" });
      if (req.method === "GET" && !match[2])
        return json(res, 200, await getCall(id, userId));
      if (req.method === "POST" && match[2] === "answer") {
        const data = answerSchema.parse(JSON.parse(await body(req)));
        return json(
          res,
          200,
          await answerUser(id, data.questionId, data.answer),
        );
      }
      if (req.method === "POST" && match[2] === "cancel") {
        await endCall(id, "cancelled");
        await flushCall(id);
        return json(res, 200, await getCall(id, userId));
      }
    }
    json(res, 404, { error: "NOT_FOUND" });
  } catch (e) {
    if (e instanceof BillingConfigurationError) {
      console.error(e.message); // Configuration names only; never credential values.
      return json(res, 503, { error: "BILLING_NOT_CONFIGURED" });
    }
    const message = e instanceof Error ? e.message : "INTERNAL_ERROR";
    if (message === "INSUFFICIENT_CREDIT")
      billingLog("wallet.insufficient_funds");
    const known = [
      "INSUFFICIENT_CREDIT",
      "CHECKOUT_UNAVAILABLE",
      "CHECKOUT_EXPIRED",
      "IDEMPOTENCY_CONFLICT",
      "PRICING_NOT_CONFIGURED",
      "PAYMENT_MISMATCH",
      "UNSUPPORTED_PACKAGE",
      "ACTIVE_CALL",
      "PROFILE_REQUIRED",
      "RATE_LIMIT",
      "SERVICE_UNAVAILABLE",
      "NOT_CONFIGURED",
      "NUMBER_NOT_ALLOWED",
      "CALL_ENDED",
      "STALE_QUESTION",
      "CONNECTION_LOST",
      "BODY_TOO_LARGE",
      "RECOVERY_PENDING",
      "INVALID_INPUT",
      "CONTACT_LIMIT",
    ];
    json(
      res,
      message === "RATE_LIMIT"
        ? 429
        : [
              "SERVICE_UNAVAILABLE",
              "CHECKOUT_UNAVAILABLE",
              "PRICING_NOT_CONFIGURED",
            ].includes(message)
          ? 503
          : message === "BODY_TOO_LARGE"
            ? 413
            : e instanceof z.ZodError || e instanceof SyntaxError
              ? 400
              : known.includes(message)
                ? 409
                : 500,
      {
        error:
          e instanceof z.ZodError || e instanceof SyntaxError
            ? "INVALID_INPUT"
            : known.includes(message)
              ? message
              : "INTERNAL_ERROR",
      },
    );
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const match = url.pathname.match(/^\/media\/([0-9a-f-]{36})$/);
    if (
      !accepting ||
      !match ||
      !authorizeMedia(match[1], url.searchParams.get("token") || "")
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachMedia(match[1], ws));
  } catch {
    socket.destroy();
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
// Bind before recovering state. A duplicate launch must not terminate the running process's calls.
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(listener.port, listener.host, () => {
    server.off("error", reject);
    resolve();
  });
});
// A voice worker owns in-memory media sessions. Prevent a second worker from
// recovering another worker's live calls. Use a direct (non-PgBouncer) session.
const workerLock = new pg.Client(connectionConfig(true));
await workerLock.connect();
const lock = await workerLock.query(
  "SELECT pg_try_advisory_lock(731398215) AS acquired",
);
if (!lock.rows[0].acquired) {
  await workerLock.end();
  server.close();
  throw new Error("A voice worker already owns this database");
}
workerLock.on("error", () => void shutdown(true));
await recoverCalls();
accepting = true;
console.log(`ToMoshiMoshi voice service ready on ${listener.host}:${listener.port}.`);
recoveryTimer = setInterval(() => {
  void recoverOrphanedCalls()
    .then(() => pruneEvents())
    .catch(() => console.error("Recovery check failed"));
}, 30000);
recoveryTimer.unref();
export async function shutdown(exit = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  accepting = false;
  clearInterval(recoveryTimer);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  await Promise.allSettled(
    [...sessions.keys()].map((id) => endCall(id, "failed", "SERVER_RESTART")),
  );
  wss.close();
  await closeDatabase();
  await workerLock.end();
  clearTimeout(deadline);
  if (exit) process.exit(0);
}
process.on("SIGINT", () => void shutdown(true));
process.on("SIGTERM", () => void shutdown(true));
