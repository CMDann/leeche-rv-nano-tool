#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline as pipelineCallback, PassThrough } from "node:stream";
import { promisify } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getSource, imageSources, sourceNames } from "./sources.js";

const pipeline = promisify(pipelineCallback);
const userAgent = "leeche-rv-nano-tool/0.1";

if (isMain()) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;
    case "doctor":
      await doctor();
      return;
    case "sources":
      listSources();
      return;
    case "images":
      await listImages(parseArgs(argv));
      return;
    case "download":
      await downloadImage(parseArgs(argv));
      return;
    case "prepare":
      await prepareCard(parseArgs(argv));
      return;
    case "disks":
      await listDisks();
      return;
    case "flash":
      await flashImage(parseArgs(argv));
      return;
    case "configure":
      await configureDevice(parseArgs(argv));
      return;
    default:
      throw new Error(`Unknown command "${command}". Run "leeche-rv-nano help".`);
  }
}

function printHelp() {
  console.log(`leeche-rv-nano

Usage:
  leeche-rv-nano doctor
  leeche-rv-nano sources
  leeche-rv-nano images [--source official]
  leeche-rv-nano download [--source official] [--tag latest] [--asset NAME] [--out images]
  leeche-rv-nano disks
  leeche-rv-nano prepare --disk /dev/diskN [--source official] [--tag latest]
  leeche-rv-nano flash --image PATH --disk /dev/diskN
  leeche-rv-nano configure --host root@IP [--hostname NAME] [--authorized-key PATH]

Safety:
  flash refuses internal disks when the OS can identify them and asks you to type
  FLASH <disk> before it writes anything.
`);
}

export function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return args;
}

export async function doctor() {
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);

  const required = ["dd"];
  const optional = ["xz", "lz4", "ssh", "diskutil", "lsblk"];
  for (const command of [...required, ...optional]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    const status = result.status === 0 ? result.stdout.trim() : "missing";
    console.log(`${command}: ${status}`);
  }

  if (!["darwin", "linux"].includes(process.platform)) {
    console.log("flash support: this CLI currently flashes on macOS and Linux. Use Etcher/Rufus on other hosts.");
  }
}

export function listSources() {
  for (const [name, source] of Object.entries(imageSources)) {
    console.log(`${name.padEnd(10)} ${source.label}`);
    console.log(`           github.com/${source.owner}/${source.repo}`);
    console.log(`           ${source.docs}`);
  }
}

export async function listImages(args) {
  const sourceName = args.source || "official";
  const source = getSource(sourceName);
  const releases = await fetchReleases(source);

  console.log(`${source.label} (${sourceName})`);
  for (const release of releases.slice(0, Number(args.limit || 10))) {
    const assets = matchingAssets(source, release);
    if (assets.length === 0) continue;

    console.log(`\n${release.tag_name}  ${release.name || ""}`.trim());
    console.log(`published: ${release.published_at || "unknown"}`);
    for (const asset of assets) {
      console.log(`  - ${asset.name} (${formatBytes(asset.size)})`);
    }
  }
}

export async function downloadImage(args) {
  const sourceName = args.source || "official";
  const source = getSource(sourceName);
  const tag = args.tag || "latest";
  const outDir = resolve(String(args.out || "images"));
  mkdirSync(outDir, { recursive: true });

  const release = tag === "latest"
    ? await fetchLatestRelease(source)
    : await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${encodeURIComponent(tag)}`);

  const assets = matchingAssets(source, release);
  if (assets.length === 0) {
    throw new Error(`No image assets matched source "${sourceName}" in release ${release.tag_name}.`);
  }

  const asset = chooseAsset(assets, args.asset);
  const destination = join(outDir, asset.name);
  const digest = createHash("sha256");

  console.log(`Downloading ${asset.name}`);
  console.log(`From: ${asset.browser_download_url}`);
  console.log(`To:   ${destination}`);

  await downloadToFile(asset.browser_download_url, destination, digest);

  console.log(`Done: ${destination}`);
  console.log(`SHA256: ${digest.digest("hex")}`);
  return destination;
}

export async function prepareCard(args) {
  if (!args.disk) throw new Error("Missing --disk /dev/diskN.");
  const imagePath = args.image ? resolve(String(args.image)) : await downloadImage(args);
  await flashImage({ ...args, image: imagePath });
}

export async function listDisks() {
  const disks = await getDisks();
  if (disks.length === 0) {
    console.log("No removable/external whole disks found.");
    return;
  }

  for (const disk of disks) {
    const safety = disk.internal ? "INTERNAL" : "external";
    const mounted = disk.mountpoints.length ? disk.mountpoints.join(", ") : "not mounted";
    console.log(`${disk.path}  ${formatBytes(disk.size)}  ${safety}  ${disk.name || "unknown media"}`);
    console.log(`  protocol: ${disk.protocol || "unknown"}; mounted: ${mounted}`);
  }
}

export async function flashImage(args) {
  if (!args.image) throw new Error("Missing --image PATH.");
  if (!args.disk) throw new Error("Missing --disk /dev/diskN.");

  const imagePath = resolve(expandPath(String(args.image)));
  const diskPath = String(args.disk);
  if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  if (!diskPath.startsWith("/dev/")) throw new Error(`Refusing non-device path: ${diskPath}`);

  const disks = await getDisks({ includeInternal: true });
  const disk = disks.find((candidate) => candidate.path === diskPath || candidate.rawPath === diskPath);
  if (!disk) {
    throw new Error(`Could not identify ${diskPath}. Run "leeche-rv-nano disks" and use a listed whole disk.`);
  }
  if (disk.internal && !args.allow_internal) {
    throw new Error(`${diskPath} appears to be internal. Refusing to flash without --allow-internal.`);
  }

  console.log(`Image: ${imagePath} (${formatBytes(statSync(imagePath).size)})`);
  console.log(`Disk:  ${disk.path} (${formatBytes(disk.size)}, ${disk.name || "unknown media"})`);
  console.log("This will overwrite the entire target disk.");

  if (args.confirm !== `FLASH ${disk.path}`) {
    const rl = createInterface({ input, output });
    const answer = await rl.question(`Type "FLASH ${disk.path}" to continue: `);
    rl.close();
    if (answer !== `FLASH ${disk.path}`) {
      throw new Error("Confirmation did not match. Aborting.");
    }
  }

  await unmountDisk(disk.path);
  await writeImage(imagePath, disk);
  await ejectDisk(disk.path);
  console.log("Flash complete. The card was ejected if the platform supports it.");
}

export async function configureDevice(args) {
  if (!args.host) throw new Error("Missing --host root@IP.");

  const host = String(args.host);
  const commands = [];

  if (args.hostname) {
    const hostname = shellQuote(String(args.hostname));
    commands.push(`hostnamectl set-hostname ${hostname} 2>/dev/null || printf '%s\\n' ${hostname} > /etc/hostname`);
  }

  if (args.authorized_key) {
    const keyPath = resolve(expandPath(String(args.authorized_key)));
    if (!existsSync(keyPath)) throw new Error(`Authorized key file not found: ${keyPath}`);
    const key = shellQuote(readText(keyPath).trim());
    commands.push("mkdir -p /root/.ssh && chmod 700 /root/.ssh");
    commands.push(`grep -qxF ${key} /root/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${key} >> /root/.ssh/authorized_keys`);
    commands.push("chmod 600 /root/.ssh/authorized_keys");
  }

  if (args.timezone) {
    const timezone = shellQuote(String(args.timezone));
    commands.push(`timedatectl set-timezone ${timezone} 2>/dev/null || ln -sf /usr/share/zoneinfo/${String(args.timezone).replace(/^\/+/, "")} /etc/localtime`);
  }

  if (args.wifi_ssid) {
    const password = args.wifi_password_env ? process.env[String(args.wifi_password_env)] : process.env.LEECHE_WIFI_PASSWORD;
    if (!password) {
      throw new Error("Wi-Fi setup requires --wifi-password-env VAR or LEECHE_WIFI_PASSWORD in the environment.");
    }
    const ssid = wpaQuote(String(args.wifi_ssid));
    const psk = wpaQuote(password);
    commands.push(`cat > /etc/wpa_supplicant.conf <<'EOF'
ctrl_interface=/var/run/wpa_supplicant
update_config=1
network={
  ssid=${ssid}
  psk=${psk}
}
EOF`);
    commands.push("systemctl restart wpa_supplicant 2>/dev/null || /etc/init.d/S40network restart 2>/dev/null || true");
  }

  if (commands.length === 0) {
    throw new Error("Nothing to configure. Add --hostname, --authorized-key, --timezone, or --wifi-ssid.");
  }

  const remoteCommand = commands.join(" && ");
  if (args.dry_run) {
    console.log(`ssh ${host} ${shellQuote(remoteCommand)}`);
    return;
  }

  await run("ssh", [host, remoteCommand], { stdio: "inherit" });
}

export async function fetchReleases(source) {
  return fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases`);
}

export async function fetchLatestRelease(source) {
  return fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`);
}

export function matchingAssets(source, release) {
  return (release.assets || []).filter((asset) => source.assetPattern.test(asset.name));
}

export function chooseAsset(assets, requested) {
  if (!requested) return assets[0];
  const exact = assets.find((asset) => asset.name === requested);
  if (exact) return exact;
  const partial = assets.find((asset) => asset.name.includes(requested));
  if (partial) return partial;
  throw new Error(`No asset matched "${requested}". Available: ${assets.map((asset) => asset.name).join(", ")}`);
}

async function fetchJson(url) {
  const body = await fetchText(url);
  return JSON.parse(body);
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function downloadToFile(url, destination, digest) {
  const response = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  const hashStream = new PassThrough();
  hashStream.on("data", (chunk) => digest.update(chunk));

  await pipeline(response.body, hashStream, createWriteStream(destination));
}

export async function getDisks(options = {}) {
  if (process.platform === "darwin") return getMacDisks(options);
  if (process.platform === "linux") return getLinuxDisks(options);
  return [];
}

async function getMacDisks(options = {}) {
  const list = spawnSync("diskutil", ["list"], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`diskutil list failed: ${list.stderr}`);
  const diskPaths = [...list.stdout.matchAll(/^\/dev\/(disk\d+)\b/gm)].map((match) => `/dev/${match[1]}`);
  const disks = [];

  for (const path of diskPaths) {
    const info = spawnSync("diskutil", ["info", path], { encoding: "utf8" });
    if (info.status !== 0) continue;
    const fields = parseDiskutilInfo(info.stdout);
    const wholeDisk = fields["Whole"] === "Yes" || fields["Part of Whole"] === basename(path);
    if (!wholeDisk) continue;

    const internal = fields["Device Location"] === "Internal";
    const removable = fields["Removable Media"] === "Yes" || fields["Removable Media"] === "Removable";
    const external = fields["Device Location"] === "External" || removable || fields["Protocol"] === "USB";
    if (!options.includeInternal && !external) continue;

    disks.push({
      path,
      rawPath: path.replace("/dev/disk", "/dev/rdisk"),
      size: Number(fields["Disk Size"]?.match(/\((\d+) Bytes\)/)?.[1] || 0),
      name: fields["Media Name"] || fields["Volume Name"] || fields["Device / Media Name"],
      protocol: fields["Protocol"],
      internal,
      mountpoints: fields["Mount Point"] && fields["Mount Point"] !== "Not Mounted" ? [fields["Mount Point"]] : []
    });
  }

  return disks;
}

function parseDiskutilInfo(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

async function getLinuxDisks(options = {}) {
  const result = spawnSync("lsblk", ["-J", "-b", "-o", "NAME,PATH,SIZE,MODEL,TRAN,RM,TYPE,MOUNTPOINTS"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`lsblk failed: ${result.stderr}`);
  const data = JSON.parse(result.stdout);

  return (data.blockdevices || [])
    .filter((disk) => disk.type === "disk")
    .filter((disk) => options.includeInternal || disk.rm || ["usb", "sdio"].includes(disk.tran))
    .map((disk) => ({
      path: disk.path,
      rawPath: disk.path,
      size: Number(disk.size || 0),
      name: disk.model,
      protocol: disk.tran,
      internal: !disk.rm && disk.tran !== "usb",
      mountpoints: collectMountpoints(disk)
    }));
}

function collectMountpoints(node) {
  const own = Array.isArray(node.mountpoints) ? node.mountpoints.filter(Boolean) : [];
  const children = (node.children || []).flatMap(collectMountpoints);
  return [...own, ...children];
}

async function unmountDisk(path) {
  if (process.platform === "darwin") {
    await run("diskutil", ["unmountDisk", path], { stdio: "inherit" });
    return;
  }

  const disks = await getLinuxDisks({ includeInternal: true });
  const disk = disks.find((candidate) => candidate.path === path);
  for (const mountpoint of disk?.mountpoints || []) {
    await run("sudo", ["umount", mountpoint], { stdio: "inherit" });
  }
}

async function writeImage(imagePath, disk) {
  const compression = compressionFor(imagePath);
  await run("sudo", ["-v"], { stdio: "inherit" });

  const ddArgs = process.platform === "darwin"
    ? [`of=${disk.rawPath}`, "bs=4m", "conv=sync", "status=progress"]
    : [`of=${disk.path}`, "bs=4M", "conv=fsync", "status=progress"];

  if (!compression) {
    ddArgs.unshift(`if=${imagePath}`);
    await run("sudo", ["dd", ...ddArgs], { stdio: "inherit" });
    return;
  }

  const decompressor = compression === "xz"
    ? spawn("xz", ["-dc", imagePath], { stdio: ["ignore", "pipe", "inherit"] })
    : spawn("lz4", ["-dc", imagePath], { stdio: ["ignore", "pipe", "inherit"] });
  const writer = spawn("sudo", ["dd", ...ddArgs], { stdio: ["pipe", "inherit", "inherit"] });
  decompressor.stdout.pipe(writer.stdin);

  const [decompressCode, writerCode] = await Promise.all([waitFor(decompressor), waitFor(writer)]);
  if (decompressCode !== 0) throw new Error(`${compression} decompression failed with exit code ${decompressCode}.`);
  if (writerCode !== 0) throw new Error(`dd failed with exit code ${writerCode}.`);
}

async function ejectDisk(path) {
  if (process.platform === "darwin") {
    await run("diskutil", ["eject", path], { stdio: "inherit" });
  } else {
    await run("sync", [], { stdio: "inherit" });
  }
}

function compressionFor(path) {
  if (path.endsWith(".xz")) return "xz";
  if (path.endsWith(".lz4")) return "lz4";
  return null;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: options.stdio || "pipe" });
  const code = await waitFor(child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}.`);
}

function waitFor(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function wpaQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function expandPath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function formatBytes(bytes) {
  if (!bytes) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
