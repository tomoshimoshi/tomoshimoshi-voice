import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
export function internalToken() {
  if (process.env.CALLORI_INTERNAL_TOKEN) {
    const token = process.env.CALLORI_INTERNAL_TOKEN.trim();
    if (token.length < 32 || /\s/.test(token))
      throw new Error(
        "CALLORI_INTERNAL_TOKEN must contain at least 32 non-whitespace characters.",
      );
    return token;
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("CALLORI_INTERNAL_TOKEN is required in production");
  // Runtime-only local storage must never be traced into a deployment bundle.
  const dir = resolve(
    /* turbopackIgnore: true */ process.env.CALLORI_DATA_DIR || ".callori",
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, "internal-token");
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "The local internal token is invalid. Restore or regenerate it before starting.",
    );
  return token;
}
