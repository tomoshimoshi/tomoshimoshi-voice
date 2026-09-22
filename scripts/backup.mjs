import "dotenv/config";
import { spawn } from "node:child_process";
import { open, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const destination = process.argv[2];
if (!destination || !process.env.DATABASE_URL) {
  console.error(
    "Usage: npm run backup -- /private/path/tomoshimoshi.dump (DATABASE_URL required; install PostgreSQL client tools)",
  );
  process.exit(1);
}
const target = resolve(destination);
const url = new URL(process.env.DATABASE_URL);
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
const file = await open(target, "wx", 0o600);
try {
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: ["localhost", "127.0.0.1"].includes(url.hostname)
      ? "prefer"
      : "verify-full",
  };
  // Credentials are passed through the environment, never the command line or logs.
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      { env, stdio: ["ignore", file.fd, "ignore"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("dump failed")),
    );
  });
  await file.sync();
  console.log(
    `PostgreSQL backup saved to ${target}. Verify restoration in an isolated database before relying on this backup.`,
  );
} catch {
  await rm(target, { force: true });
  console.error(
    "Backup failed. Install compatible pg_dump client tools and check database access. No partial backup retained.",
  );
  process.exitCode = 1;
} finally {
  await file.close();
}
