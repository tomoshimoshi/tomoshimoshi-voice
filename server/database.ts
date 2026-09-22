import pg from "pg";

export function connectionConfig(direct = false) {
  const connectionString = (
    direct
      ? process.env.DATABASE_URL
      : process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL
  )?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local) {
    // Never allow a connection string to silently disable certificate checks.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
      url.searchParams.delete(key);
    url.searchParams.delete("ssl");
    url.searchParams.delete("uselibpqcompat");
  }
  return {
    connectionString: url.toString(),
    ssl: local ? undefined : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    enableChannelBinding: true,
    application_name: "tomoshimoshi",
  };
}
let pool: pg.Pool | undefined;
export function database() {
  if (!pool) {
    pool = new pg.Pool(connectionConfig());
    pool.on("error", () => console.error("PostgreSQL connection failed"));
  }
  return pool;
}
export async function closeDatabase() {
  await pool?.end();
}
