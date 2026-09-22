export function voiceListener(
  env: Record<string, string | undefined> = process.env,
) {
  // A hosting platform's assigned port wins over local development settings.
  const rawPort = env.PORT?.trim() || env.VOICE_PORT?.trim() || "3001";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT or VOICE_PORT must be an integer between 1 and 65535");

  // Local development remains private; the voice container opts into 0.0.0.0.
  const host = env.VOICE_HOST?.trim() || "127.0.0.1";
  return { port, host };
}
