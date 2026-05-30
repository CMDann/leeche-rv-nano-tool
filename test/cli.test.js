import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const node = process.execPath;

function runCli(args) {
  return spawnSync(node, ["src/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

describe("CLI smoke tests", () => {
  it("prints help", () => {
    const result = runCli(["help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /leeche-rv-nano/);
    assert.match(result.stdout, /prepare --disk/);
  });

  it("lists built-in image sources", () => {
    const result = runCli(["sources"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /official/);
    assert.match(result.stdout, /LicheeRV-Nano-Build/);
  });

  it("can render a dry-run configure command", () => {
    const result = runCli([
      "configure",
      "--host",
      "root@192.0.2.10",
      "--hostname",
      "licheerv-nano",
      "--dry-run"
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ssh root@192\.0\.2\.10/);
    assert.match(result.stdout, /licheerv-nano/);
  });

  it("rejects flash without an image path", () => {
    const result = runCli(["flash", "--disk", "/dev/disk999"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing --image PATH/);
  });
});
