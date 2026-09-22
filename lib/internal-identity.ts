import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { internalToken } from "./internal-token";
const identitySchema = z
  .object({
    sub: z.string().min(1).max(255),
    email: z.email().max(320),
    emailVerified: z.boolean(),
    exp: z.number(),
  })
  .strict();
export function signIdentity(user: {
  sub: string;
  email: string;
  email_verified?: boolean;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.sub,
      email: user.email,
      emailVerified: user.email_verified === true,
      exp: Date.now() + 30000,
    }),
  ).toString("base64url");
  return (
    payload +
    "." +
    createHmac("sha256", internalToken()).update(payload).digest("base64url")
  );
}
export function verifyIdentity(value: string) {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra || value.length > 4096) return;
    const expected = createHmac("sha256", internalToken())
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return;
    const parsed = identitySchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    if (parsed.exp < Date.now() || parsed.exp > Date.now() + 35000) return;
    return parsed;
  } catch {
    return;
  }
}
