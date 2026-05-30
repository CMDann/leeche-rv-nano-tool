const state = {
  sources: [],
  releases: [],
  disks: [],
  localImages: [],
  selectedDisk: "",
  jobs: new Map(),
  pollers: new Map()
};

const elements = {
  hostStatus: document.querySelector("#hostStatus"),
  sourceSelect: document.querySelector("#sourceSelect"),
  assetSelect: document.querySelector("#assetSelect"),
  localImageSelect: document.querySelector("#localImageSelect"),
  imagePathInput: document.querySelector("#imagePathInput"),
  diskList: document.querySelector("#diskList"),
  confirmToggle: document.querySelector("#confirmToggle"),
  confirmToggleText: document.querySelector("#confirmToggleText"),
  flashButton: document.querySelector("#flashButton"),
  downloadButton: document.querySelector("#downloadButton"),
  refreshImagesButton: document.querySelector("#refreshImagesButton"),
  refreshDisksButton: document.querySelector("#refreshDisksButton"),
  jobsList: document.querySelector("#jobsList"),
  hostInput: document.querySelector("#hostInput"),
  hostnameInput: document.querySelector("#hostnameInput"),
  timezoneInput: document.querySelector("#timezoneInput"),
  authorizedKeyInput: document.querySelector("#authorizedKeyInput"),
  wifiSsidInput: document.querySelector("#wifiSsidInput"),
  wifiPasswordInput: document.querySelector("#wifiPasswordInput"),
  configureButton: document.querySelector("#configureButton"),
  toast: document.querySelector("#toast")
};

await safeRun(boot);

async function boot() {
  bindEvents();
  await Promise.all([loadHealth(), loadSources(), loadLocalImages(), loadDisks()]);
  await loadImages();
  renderAll();
}

function bindEvents() {
  elements.sourceSelect.addEventListener("change", async () => {
    await safeRun(async () => {
      await loadImages();
      renderImages();
    });
  });
  elements.refreshImagesButton.addEventListener("click", async () => {
    await safeRun(async () => {
      await loadImages();
      await loadLocalImages();
      renderImages();
      showToast("Image list refreshed.");
    });
  });
  elements.refreshDisksButton.addEventListener("click", async () => {
    await safeRun(async () => {
      await loadDisks();
      renderDisks();
      showToast("Disk list refreshed.");
    });
  });
  elements.downloadButton.addEventListener("click", () => safeRun(startDownload));
  elements.confirmToggle.addEventListener("change", updateFlashButton);
  elements.localImageSelect.addEventListener("change", updateFlashButton);
  elements.imagePathInput.addEventListener("input", updateFlashButton);
  elements.flashButton.addEventListener("click", () => safeRun(startFlash));
  elements.configureButton.addEventListener("click", () => safeRun(startConfigure));
}

async function loadHealth() {
  const health = await apiGet("/api/health");
  elements.hostStatus.textContent = `${health.platform} ${health.node} - ${health.cwd}`;
}

async function loadSources() {
  const data = await apiGet("/api/sources");
  state.sources = data.sources;
}

async function loadImages() {
  const source = elements.sourceSelect.value || state.sources[0]?.name || "official";
  const data = await apiGet(`/api/images?source=${encodeURIComponent(source)}&limit=10`);
  state.releases = data.releases;
}

async function loadLocalImages() {
  const data = await apiGet("/api/local-images");
  state.localImages = data.images;
}

async function loadDisks() {
  const data = await apiGet("/api/disks");
  state.disks = data.disks;
  if (!state.disks.some((disk) => disk.path === state.selectedDisk)) {
    state.selectedDisk = state.disks[0]?.path || "";
  }
}

function renderAll() {
  renderSources();
  renderImages();
  renderDisks();
  renderJobs();
}

function renderSources() {
  elements.sourceSelect.innerHTML = state.sources.map((source) => {
    return `<option value="${escapeHtml(source.name)}">${escapeHtml(source.name)} - ${escapeHtml(source.label)}</option>`;
  }).join("");
}

function renderImages() {
  const assetOptions = [];
  for (const release of state.releases) {
    for (const asset of release.assets) {
      assetOptions.push({
        value: JSON.stringify({ tag: release.tag, asset: asset.name }),
        label: `${release.tag} - ${asset.name} (${asset.sizeLabel})`
      });
    }
  }

  elements.assetSelect.innerHTML = assetOptions.length
    ? assetOptions.map((asset) => `<option value="${escapeHtml(asset.value)}">${escapeHtml(asset.label)}</option>`).join("")
    : `<option value="">No matching image assets found</option>`;

  elements.localImageSelect.innerHTML = state.localImages.length
    ? [
      `<option value="">Select a downloaded image</option>`,
      ...state.localImages.map((image) => `<option value="${escapeHtml(image.path)}">${escapeHtml(image.name)} (${escapeHtml(image.sizeLabel)})</option>`)
    ].join("")
    : `<option value="">No downloaded images yet</option>`;

  updateFlashButton();
}

function renderDisks() {
  if (state.disks.length === 0) {
    elements.diskList.innerHTML = `<p class="disk-meta">No removable or external whole disks found.</p>`;
    elements.confirmToggle.checked = false;
    elements.confirmToggle.disabled = true;
    elements.confirmToggleText.textContent = "No disk selected.";
    updateFlashButton();
    return;
  }

  elements.diskList.innerHTML = state.disks.map((disk) => {
    const checked = disk.path === state.selectedDisk ? "checked" : "";
    const mountpoints = disk.mountpoints.length ? disk.mountpoints.join(", ") : "not mounted";
    return `
      <label class="disk-row">
        <input type="radio" name="disk" value="${escapeHtml(disk.path)}" ${checked}>
        <span>
          <span class="disk-title">
            ${escapeHtml(disk.path)}
            <span class="tag">${escapeHtml(disk.sizeLabel)}</span>
            <span class="tag">${escapeHtml(disk.protocol || "unknown")}</span>
          </span>
          <span class="disk-meta">${escapeHtml(disk.name || "unknown media")} - mounted: ${escapeHtml(mountpoints)}</span>
        </span>
      </label>
    `;
  }).join("");

  for (const input of elements.diskList.querySelectorAll("input[name='disk']")) {
    input.addEventListener("change", () => {
      state.selectedDisk = input.value;
      elements.confirmToggle.checked = false;
      updateFlashButton();
    });
  }

  elements.confirmToggle.disabled = false;
  elements.confirmToggleText.textContent = state.selectedDisk
    ? `I understand this will erase ${state.selectedDisk}.`
    : "Select a disk first.";
  updateFlashButton();
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => Number(b.id) - Number(a.id));
  if (jobs.length === 0) {
    elements.jobsList.innerHTML = `<p class="job-meta">No jobs started yet.</p>`;
    return;
  }

  elements.jobsList.innerHTML = jobs.map((job) => {
    const statusClass = job.status === "failed" ? "failed" : job.status === "running" ? "running" : "";
    const logs = job.logs?.length ? `<pre>${escapeHtml(job.logs.slice(-12).join("\n"))}</pre>` : "";
    return `
      <article class="job-row">
        <span class="tag ${statusClass}">${escapeHtml(job.status)}</span>
        <div>
          <p class="job-title">#${escapeHtml(job.id)} ${escapeHtml(job.type)}</p>
          <p class="job-meta">${escapeHtml(job.command)}</p>
          ${logs}
        </div>
      </article>
    `;
  }).join("");
}

async function startDownload() {
  if (!elements.assetSelect.value) return;
  const selected = JSON.parse(elements.assetSelect.value);
  const response = await apiPost("/api/jobs/download", {
    source: elements.sourceSelect.value,
    tag: selected.tag,
    asset: selected.asset,
    out: "images"
  });
  trackJob(response.id);
  showToast("Download started.");
}

async function startFlash() {
  const image = selectedImagePath();
  const disk = state.selectedDisk;
  if (!image || !disk || !elements.confirmToggle.checked) return;

  const response = await apiPost("/api/jobs/flash", { image, disk, acknowledged: true });
  trackJob(response.id);
  showToast("Flash started. Watch the terminal for sudo prompts.");
}

async function startConfigure() {
  const host = elements.hostInput.value.trim();
  if (!host) {
    showToast("Enter an SSH host first.");
    return;
  }

  const response = await apiPost("/api/jobs/configure", {
    host,
    hostname: elements.hostnameInput.value.trim(),
    authorizedKey: elements.authorizedKeyInput.value.trim(),
    timezone: elements.timezoneInput.value.trim(),
    wifiSsid: elements.wifiSsidInput.value.trim(),
    wifiPassword: elements.wifiPasswordInput.value
  });
  trackJob(response.id);
  showToast("Configure job started. Watch the terminal for SSH prompts.");
}

function trackJob(id) {
  pollJob(id);
  if (!state.pollers.has(id)) {
    const poller = setInterval(() => pollJob(id), 1500);
    state.pollers.set(id, poller);
  }
}

async function pollJob(id) {
  const job = await apiGet(`/api/jobs/${encodeURIComponent(id)}`);
  state.jobs.set(id, job);
  renderJobs();

  if (job.status !== "running") {
    clearInterval(state.pollers.get(id));
    state.pollers.delete(id);
    if (job.type === "download" && job.status === "completed") {
      await loadLocalImages();
      renderImages();
    }
  }
}

async function safeRun(task) {
  try {
    await task();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Something went wrong.");
  }
}

function updateFlashButton() {
  const ready = Boolean(selectedImagePath() && state.selectedDisk && elements.confirmToggle.checked);
  elements.flashButton.disabled = !ready;
}

function selectedImagePath() {
  return elements.imagePathInput.value.trim() || elements.localImageSelect.value;
}

async function apiGet(path) {
  const response = await fetch(path);
  return readApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return readApiResponse(response);
}

async function readApiResponse(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
