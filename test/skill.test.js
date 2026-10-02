import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sqlgate skill installs the Claude Code skill without a config", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlgate-skill-"));
  const r = spawnSync(process.execPath, ["src/cli.js", "skill", "--dir", dir], { encoding: "utf8", env: { ...process.env, SQLGATE_CONFIG: "/nonexistent.json" } });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(dir, "sqlgate", "SKILL.md"), "utf8");
  assert.ok(text.startsWith("---\nname: sqlgate\n"));
});
