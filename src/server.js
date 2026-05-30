#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSource, imageSources } from "./sources.js";
import { fetchReleases, formatBytes, getDisks, matchingAssets } from "./cli.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(rootDir, "public");
const jobs = new Map();
let nextJobId = 1;

export function createAppServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }

      serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      platform: process.platform,
      node: process.version,
      cwd: rootDir
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sources") {
    sendJson(response, 200, {
      sources: Object.entries(imageSources).map(([name, source]) => ({
        name,
        label: source.label,
        owner: source.owner,
        repo: source.repo,
        docs: source.docs
      }))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/images") {
    const sourceName = url.searchParams.get("source") || "official";
    const limit = Number(url.searchParams.get("limit") || 10);
    const source = getSource(sourceName);
    const releases = await fetchReleases(source);
    const matchingReleases = releases.map((release) => ({
      tag: release.tag_name,
      name: release.name || "",
      publishedAt: release.published_at || null,
      assets: matchingAssets(source, release).map((asset) => ({
        name: asset.name,
        size: asset.size,
        sizeLabel: formatBytes(asset.size),
        url: asset.browser_download_url
      }))
    })).filter((release) => release.assets.length > 0);
    sendJson(response, 200, {
      source: sourceName,
      releases: matchingReleases.slice(0, limit)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/disks") {
    const disks = await getDisks();
    sendJson(response, 200, {
      disks: disks.map((disk) => ({
        ...disk,
        sizeLabel: formatBytes(disk.size)
      }))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/local-images") {
    sendJson(response, 200, { images: listLocalImages() });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = url.pathname.split("/").at(-1);
    const job = jobs.get(id);
    if (!job) {
      sendJson(response, 404, { error: "Job not found." });
      return;
    }
    sendJson(response, 200, job);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/download") {
    const body = await readJson(request);
    const args = ["download", "--source", body.source || "official", "--tag", body.tag || "latest", "--out", body.out || "images"];
    if (body.asset) args.push("--asset", body.asset);
    sendJson(response, 202, startCapturedJob("download", args));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/flash") {
    const body = await readJson(request);
    requireBody(body, ["image", "disk"]);
    if (body.acknowledged !== true) {
      throw new Error("Flash requires overwrite acknowledgement.");
    }
    const args = ["flash", "--image", body.image, "--disk", body.disk, "--confirm", `FLASH ${body.disk}`];
    const job = createJob("flash", args);
    sendJson(response, 202, job);
    runFlashJob(job, args, body.sudoPassword);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/jobs/configure") {
    const body = await readJson(request);
    requireBody(body, ["host"]);
    const args = ["configure", "--host", body.host];
    if (body.hostname) args.push("--hostname", body.hostname);
    if (body.authorizedKey) args.push("--authorized-key", body.authorizedKey);
    if (body.timezone) args.push("--timezone", body.timezone);
    if (body.wifiSsid) args.push("--wifi-ssid", body.wifiSsid, "--wifi-password-env", "LEECHE_WIFI_PASSWORD");
    const env = { ...process.env };
    if (body.wifiPassword) env.LEECHE_WIFI_PASSWORD = body.wifiPassword;
    sendJson(response, 202, startTerminalJob("configure", args, env));
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function startCapturedJob(type, cliArgs, env = process.env) {
  const job = createJob(type, cliArgs);
  runCapturedJob(job, cliArgs, env);
  return job;
}

async function runFlashJob(job, cliArgs, sudoPassword) {
  try {
    if (sudoPassword) {
      appendLog(job, "Validating sudo credentials from the GUI.");
      await validateSudo(job, sudoPassword);
      appendLog(job, "Sudo credentials accepted.");
    } else {
      appendLog(job, "No admin password provided. Using cached sudo credentials if available.");
    }

    runCapturedJob(job, cliArgs, {
      ...process.env,
      LEECHE_SKIP_SUDO_VALIDATE: "1",
      LEECHE_SUDO_PASSWORD: sudoPassword || ""
    });
  } catch (error) {
    finishJob(job, "failed", error.message);
  }
}

function runCapturedJob(job, cliArgs, env = process.env) {
  const child = spawn(process.execPath, ["src/cli.js", ...cliArgs], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => appendLog(job, chunk));
  child.stderr.on("data", (chunk) => appendLog(job, chunk));
  child.on("error", (error) => finishJob(job, "failed", error.message));
  child.on("close", (code) => finishJob(job, code === 0 ? "completed" : "failed", `exit code ${code}`));
}

function startTerminalJob(type, cliArgs, env = process.env) {
  const job = createJob(type, cliArgs);
  job.logs.push("This job is attached to the terminal running npm run gui for sudo/ssh prompts and progress output.");
  const child = spawn(process.execPath, ["src/cli.js", ...cliArgs], {
    cwd: rootDir,
    env,
    stdio: "inherit"
  });

  child.on("error", (error) => finishJob(job, "failed", error.message));
  child.on("close", (code) => finishJob(job, code === 0 ? "completed" : "failed", `exit code ${code}`));

  return job;
}

function createJob(type, cliArgs) {
  const id = String(nextJobId);
  nextJobId += 1;
  const job = {
    id,
    type,
    status: "running",
    command: ["node", "src/cli.js", ...cliArgs].join(" "),
    logs: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null
  };
  jobs.set(id, job);
  return job;
}

function appendLog(job, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) job.logs.push(line);
  }
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

function validateSudo(job, sudoPassword) {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-S", "-p", "", "-v"], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => appendLog(job, chunk));
    child.stderr.on("data", (chunk) => appendLog(job, chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("Sudo credential validation failed."));
      }
    });

    child.stdin.end(`${sudoPassword}\n`);
  });
}

function finishJob(job, status, result) {
  job.status = status;
  job.result = result;
  job.finishedAt = new Date().toISOString();
}

function listLocalImages() {
  const imagesDir = join(rootDir, "images");
  if (!existsSync(imagesDir)) return [];

  return readdirSync(imagesDir)
    .filter((name) => /\.(img|img\.xz|img\.lz4)$/i.test(name))
    .map((name) => {
      const path = join(imagesDir, name);
      const stats = statSync(path);
      return {
        name,
        path,
        size: stats.size,
        sizeLabel: formatBytes(stats.size),
        modifiedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(publicDir, relativePath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  response.writeHead(200, { "Content-Type": contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function contentType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[extname(path)] || "application/octet-stream";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function readJson(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return data ? JSON.parse(data) : {};
}

function requireBody(body, keys) {
  for (const key of keys) {
    if (!body[key]) throw new Error(`Missing ${key}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 5174);
  const host = process.env.HOST || "127.0.0.1";
  createAppServer().listen(port, host, () => {
    console.log(`Leeche RV Nano Tool GUI: http://${host}:${port}`);
    console.log("Leave this terminal open while running flash or configure jobs.");
  });
}
