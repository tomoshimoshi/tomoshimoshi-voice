import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Call } from "../lib/types";
import { createRateLimiter } from "./rate-limit";

export const supportSchema = z.object({
  kind: z.enum(["bug", "contact"]),
  message: z.string().trim().min(10).max(5000),
  locale: z.enum(["en", "es", "ja"]),
  callId: z.uuid().optional(),
}).strict();

type Dependencies = {
  getCall: (id: string, userId: string) => Promise<Call | undefined>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log?: (event: string, data: Record<string, unknown>) => void;
};

// The voice worker holds a single-instance lease. Limits reset on restart,
// matching the existing API limiter; call-control requests have their own budget.
export function createSupportService(deps: Dependencies) {
  const allow = createRateLimiter(5, 15 * 60 * 1000);
  return async (userId: string, email: string, raw: unknown) => {
    const input = supportSchema.parse(raw);
    const env = deps.env ?? process.env;
    const apiKey = env.SENDGRID_API_KEY?.trim();
    const from = env.SENDGRID_FROM_EMAIL?.trim();
    if (!apiKey || !from || !z.email().safeParse(from).success)
      return { status: 503, data: { error: "SUPPORT_NOT_CONFIGURED" } };
    if (!allow(userId))
      return { status: 429, data: { error: "SUPPORT_RATE_LIMIT" } };

    // Never trust a caller-supplied ID to access someone else's call metadata.
    const call = input.callId ? await deps.getCall(input.callId, userId) : undefined;
    if (input.callId && !call)
      return { status: 404, data: { error: "NOT_FOUND" } };

    const reportId = randomUUID();
    const payload = {
      personalizations: [{ to: [{ email: "leodcastaneda@gmail.com" }] }],
      from: { email: from, name: "ToMoshiMoshi Support" },
      reply_to: { email },
      subject: `[ToMoshiMoshi] ${input.kind === "bug" ? "Bug report" : "Contact"} · ${reportId}`,
      content: [{
        type: "text/plain",
        value: [
          `Report: ${reportId}`,
          `Account: ${userId}`,
          `Reply to: ${email}`,
          `Language: ${input.locale}`,
          `Submitted: ${new Date().toISOString()}`,
          ...(call ? [
            `Call: ${call.id}`,
            `Call status: ${call.status}`,
            `Call mode: ${call.mode}`,
            `Call created: ${call.createdAt}`,
            `Call error: ${call.error || "none"}`,
          ] : []),
          "", "Message:", input.message,
        ].join("\n"),
      }],
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
    };
    const log = deps.log ?? ((event, data) => console.info(event, data));
    try {
      const response = await (deps.fetch ?? fetch)("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      // SendGrid's 202 means queued, not delivered. Do not log message contents,
      // credentials or provider error bodies, and do not retry ambiguous sends.
      log(response.status === 202 ? "support.queued" : "support.failed", {
        reportId, userId, callId: call?.id, status: response.status,
      });
      if (response.status !== 202)
        return { status: 503, data: { error: "SUPPORT_UNAVAILABLE" } };
      return { status: 202, data: { queued: true, reportId } };
    } catch {
      log("support.failed", { reportId, userId, callId: call?.id });
      return { status: 503, data: { error: "SUPPORT_UNAVAILABLE" } };
    }
  };
}
