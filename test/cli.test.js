import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createAppServer } from "../src/server.js";

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

describe("GUI server smoke tests", () => {
  it("serves the app shell and health endpoint", async () => {
    const server = createAppServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
      assert.equal(health.node, process.version);

      const html = await fetch(baseUrl).then((response) => response.text());
      assert.match(html, /Leeche RV Nano Tool/);
      assert.match(html, /Admin password/);
      assert.match(html, /Flash selected image/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects flash jobs without overwrite acknowledgement", async () => {
    const server = createAppServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/jobs/flash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: "/tmp/test.img", disk: "/dev/disk999" })
      });
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.match(body.error, /acknowledgement/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
