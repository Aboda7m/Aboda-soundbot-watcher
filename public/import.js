// Media import page (Phase 1: local audio files). Independent of the dashboard scripts.
const $ = (id) => document.getElementById(id);

// Page key (?key=...) is forwarded to the API as a header; the preview <audio> can't send headers, so it uses the query.
const key = new URLSearchParams(location.search).get("key");
const authHeaders = key ? { "X-Access-Key": key } : {};
const keyQuery = key ? `?key=${encodeURIComponent(key)}` : "";

const steps = ["pick", "progress", "review", "done"];
const state = { limits: null, staged: null };

for (const a of [$("back"), $("back2")]) a.href = "/" + location.search;

function show(step, focusId) {
  for (const s of steps) $(`step-${s}`).hidden = s !== step;
  if (focusId) $(focusId).focus();
}

function banner(message) {
  $("banner").textContent = message || "";
  $("banner").hidden = !message;
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function fmtDuration(s) {
  return s < 10 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders, ...(options.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = res.status === 401 ? "Access key missing or wrong. Open this page with ?key=..." : data?.error || `Server returned ${res.status}.`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}
const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------- start-up ----------

async function init() {
  try {
    const cfg = await api("/api/import/config");
    state.limits = cfg;
    const names = cfg.extensions.map((e) => e.slice(1).toUpperCase()).join(", ");
    $("limits").textContent = `${names} · up to ${fmtBytes(cfg.maxUploadBytes)} · up to ${cfg.maxDurationSec} s`;
    $("file").accept = cfg.extensions.join(",");
    if (!cfg.ready) {
      banner(cfg.problem || "Importing is not available right now.");
      $("drop").setAttribute("aria-disabled", "true");
      return;
    }
    $("file").disabled = false;
  } catch (err) {
    banner(err.message);
    $("limits").textContent = "Unavailable";
    $("drop").setAttribute("aria-disabled", "true");
  }
}

// ---------- upload ----------

function checkFile(file) {
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  if (!state.limits.extensions.includes(ext)) return `Unsupported file type. Supported: ${state.limits.extensions.join(", ")}.`;
  if (file.size === 0) return "The file is empty.";
  if (file.size > state.limits.maxUploadBytes) return `File is too large (${fmtBytes(file.size)}). The limit is ${fmtBytes(state.limits.maxUploadBytes)}.`;
  return "";
}

function setProgress(text, percent) {
  $("progress-text").textContent = text;
  if (percent === null) $("bar").removeAttribute("value");
  else $("bar").value = percent;
}

function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import/upload");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    for (const [k, v] of Object.entries(authHeaders)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`, (e.loaded / e.total) * 100);
    };
    xhr.upload.onload = () => setProgress("Checking and processing the audio…", null);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error(xhr.status === 401 ? "Access key missing or wrong. Open this page with ?key=..." : data?.error || `Server returned ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error("Could not reach the server, or it closed the connection. Check the file size and try again."));
    xhr.send(file);
  });
}

async function handleFile(file) {
  banner("");
  const problem = checkFile(file);
  if (problem) return banner(problem);
  show("progress");
  setProgress("Uploading… 0%", 0);
  try {
    const staged = await upload(file);
    state.staged = staged;
    showReview(staged);
  } catch (err) {
    banner(err.message);
    reset();
  }
}

// ---------- review & save ----------

function row(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  $("meta").append(dt, dd);
}

function showReview(s) {
  $("meta").replaceChildren();
  const r = s.result;
  row("File", s.original.fileName);
  row("Length", fmtDuration(r.durationSec));
  row("Original", `${s.original.format.toUpperCase() || "?"}${s.original.codec ? ` (${s.original.codec})` : ""}, ${fmtBytes(s.original.sizeBytes)}`);
  row("Will be saved as", `${r.extension.slice(1).toUpperCase()}, ${fmtBytes(r.sizeBytes)}${r.sampleRate ? `, ${Math.round(r.sampleRate / 1000 * 10) / 10} kHz` : ""}${r.channels ? `, ${r.channels === 1 ? "mono" : r.channels === 2 ? "stereo" : r.channels + " channels"}` : ""}`);
  $("note").textContent = r.note;
  $("player").src = `/api/import/preview/${s.id}${keyQuery}`;
  $("name").value = s.suggestedName;
  nameError(s.nameTaken ? `A sound named "${s.suggestedName}" already exists. Choose another name.` : "");
  $("save").disabled = false;
  show("review", "review-title");
}

function nameError(message) {
  $("name-error").textContent = message;
  $("name-error").hidden = !message;
  $("name").setAttribute("aria-invalid", message ? "true" : "false");
}

$("name").addEventListener("input", () => nameError(""));

$("save-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  if (!name) return nameError("Enter a name for the sound.");
  $("save").disabled = true;
  try {
    const res = await postJson("/api/import/save", { id: state.staged.id, name });
    $("player").pause();
    $("player").removeAttribute("src");
    state.staged = null;
    $("done-text").textContent = `Saved as "${res.name}". It is in the sound library now. Reload the soundboard page to see it.`;
    show("done", "done-title");
  } catch (err) {
    $("save").disabled = false;
    if (err.status === 400 || err.status === 409) {
      nameError(err.message);
      $("name").focus();
    } else {
      banner(err.message);
      if (err.status === 404) reset(); // expired
    }
  }
});

$("discard").addEventListener("click", async () => {
  const id = state.staged?.id;
  reset();
  if (id) await postJson("/api/import/discard", { id }).catch(() => {});
});

$("again").addEventListener("click", () => { banner(""); reset(); });

function reset() {
  state.staged = null;
  $("player").pause();
  $("player").removeAttribute("src");
  $("file").value = "";
  show("pick", "pick-title");
}

// ---------- picking files ----------

$("file").addEventListener("change", () => {
  const f = $("file").files[0];
  if (f) handleFile(f);
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); if (!$("file").disabled) drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if ($("file").disabled) return;
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

init();
