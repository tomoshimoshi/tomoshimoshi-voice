// PostgreSQL-backed HTTP lifecycle and authorization checks; isolated PGlite,
// synthetic identities and disabled telephony. Never loads .env.
import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/http.test.ts"],
  { stdio: "inherit" },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
