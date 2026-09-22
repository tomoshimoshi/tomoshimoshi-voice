import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("backup includes uncheckpointed WAL data, has private permissions, and refuses overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "tomoshimoshi-backup-"));
  const db = new DatabaseSync(join(dir, "callori.sqlite"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('fictional test data');",
    );
    const target = join(dir, "backup.sqlite");
    const options = {
      env: { ...process.env, CALLORI_DATA_DIR: dir },
      encoding: "utf8" as const,
    };
    const result = spawnSync(
      process.execPath,
      ["scripts/backup-sqlite.mjs", target],
      options,
    );
    assert.equal(result.status, 0, result.stderr);
    const restored = new DatabaseSync(target, { readOnly: true });
    assert.equal(
      restored.prepare("SELECT value FROM sample").get()?.value,
      "fictional test data",
    );
    restored.close();
    if (process.platform !== "win32")
      assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.notEqual(
      spawnSync(process.execPath, ["scripts/backup-sqlite.mjs", target], options)
        .status,
      0,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
