// Media import page: upload audio/video, choose what to keep (default: first N seconds), preview, save.
// Independent of the dashboard scripts.
const $ = (id) => document.getElementById(id);

// Page key (?key=...) is forwarded to the API as a header; the preview <audio> can't send headers, so it uses the query.
const key = new URLSearchParams(location.search).get("key");
const authHeaders = key ? { "X-Access-Key": key } : {};
const keyQuery = key ? `&key=${encodeURIComponent(key)}` : "";

const steps = ["pick", "progress", "review", "done"];
const state = { limits: null, staged: null, dirty: false, rendering: false };

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
// 75.5 -> "1:15.5", 4 -> "0:04", 3725 -> "1:02:05"
function fmtTime(sec) {
  const r = Math.round(Math.max(0, sec) * 10) / 10;
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const s = Math.round((r - h * 3600 - m * 60) * 10) / 10;
  const secs = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${secs}` : `${m}:${secs}`;
}
// "12.5", "1:05", "1:02:03.5" -> seconds, or NaN
function parseTime(text) {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?(:\d{1,2}(\.\d+)?){0,2}$/.test(t)) return NaN;
  return t.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}
const round3 = (n) => Math.round(n * 1000) / 1000;
const FORMAT_LABELS = { mov: "MP4/MOV", matroska: "MKV/WebM", mp3: "MP3", wav: "WAV", ogg: "OGG/Opus", flac: "FLAC", aac: "AAC", avi: "AVI", asf: "WMA/WMV", aiff: "AIFF" };

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
    $("limits").textContent =
      `Audio or video: ${cfg.extensions.map((e) => e.slice(1).toUpperCase()).join(", ")} · up to ${fmtBytes(cfg.maxUploadBytes)} · ` +
      `keeps the first ${cfg.defaultTrimSec} s by default · saved sounds up to ${fmtTime(cfg.maxOutputSec)}`;
    $("file").accept = cfg.extensions.join(",");
    $("first-label").textContent = `First ${cfg.defaultTrimSec} seconds`;
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
    xhr.upload.onload = () => setProgress(`Checking the file and preparing the first ${state.limits.defaultTrimSec} seconds…`, null);
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

// ---------- review: what to keep ----------

function row(label, value, strong) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (strong) {
    const b = document.createElement("strong");
    b.textContent = value;
    dd.append(b);
  } else dd.textContent = value;
  $("meta").append(dt, dd);
}

function selectionText(r) {
  if (r.mode === "full") return "Entire audio";
  if (r.mode === "first") return `First ${Math.round(r.durationSec * 10) / 10} s`;
  return `${fmtTime(r.startSec)} to ${fmtTime(r.endSec)}`;
}

function renderMeta() {
  const s = state.staged;
  const r = s.result;
  const dur = s.original.durationSec;
  $("meta").replaceChildren();
  row("File", s.original.fileName);
  row("Original", `${FORMAT_LABELS[s.original.format] || s.original.format.toUpperCase() || "?"}${s.original.codec ? ` (${s.original.codec})` : ""}, ${fmtBytes(s.original.sizeBytes)}`);
  row("Original length", dur === null ? "Not stated in the file" : fmtTime(dur));
  row("Selected part", selectionText(r));
  row("Saved length", fmtTime(r.durationSec), true);
  row("Saved as", `${r.extension.slice(1).toUpperCase()}, ${fmtBytes(r.sizeBytes)}${r.sampleRate ? `, ${Math.round(r.sampleRate / 100) / 10} kHz` : ""}${r.channels ? `, ${r.channels === 1 ? "mono" : r.channels === 2 ? "stereo" : r.channels + " channels"}` : ""}`);
  $("note").textContent = r.note;
}

function loadPreview() {
  const p = $("player");
  p.pause();
  p.src = `/api/import/preview/${state.staged.id}?v=${state.staged.result.version}${keyQuery}`;
  p.load();
}

function showReview(s) {
  $("video-note").hidden = !s.original.hasVideo;
  // trim controls start at the default: first N seconds
  document.querySelector('input[name="mode"][value="first"]').checked = true;
  $("range-fields").hidden = true;
  const dur = s.original.durationSec;
  $("r-start").value = "0:00";
  const defLen = dur === null ? state.limits.defaultTrimSec : Math.min(state.limits.defaultTrimSec, dur);
  $("r-len").value = fmtTime(defLen);
  $("r-end").value = fmtTime(defLen);
  const tooLong = dur !== null && dur > state.limits.maxOutputSec;
  $("mode-full").disabled = tooLong;
  $("full-hint").textContent = tooLong
    ? `(not available: this is ${fmtTime(dur)} long, the limit is ${fmtTime(state.limits.maxOutputSec)})`
    : dur === null ? `(the whole file, up to ${fmtTime(state.limits.maxOutputSec)})` : `(the whole file, ${fmtTime(dur)})`;
  trimError("");
  setDirty(false);
  renderMeta();
  loadPreview();
  $("name").value = s.suggestedName;
  nameError(s.nameTaken ? `A sound named "${s.suggestedName}" already exists. Choose another name.` : "");
  show("review", "review-title");
}

function trimError(message) {
  $("trim-error").textContent = message;
  $("trim-error").hidden = !message;
}

// Save is only possible while the preview matches the chosen settings, so what is saved is what was heard.
function setDirty(dirty) {
  state.dirty = dirty;
  $("save").disabled = dirty || state.rendering;
  $("apply").disabled = state.rendering;
  $("trim-status").textContent = state.rendering ? "Rendering the preview…" : dirty ? "Settings changed. Update the preview to hear and save them." : "";
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function buildRequest() {
  const mode = currentMode();
  if (mode !== "range") return { mode };
  const start = parseTime($("r-start").value);
  const end = parseTime($("r-end").value);
  if (Number.isNaN(start)) throw new Error("Start time isn't a valid time. Use seconds (12.5) or m:ss (1:05).");
  if (Number.isNaN(end)) throw new Error("End time isn't a valid time. Use seconds (12.5) or m:ss (1:05).");
  if (end <= start) throw new Error("End time must be after the start time.");
  return { mode, start: round3(start), end: round3(end) };
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    $("range-fields").hidden = currentMode() !== "range";
    trimError("");
    setDirty(currentMode() !== state.staged.result.mode);
  });
}

// start / end / length stay consistent
function syncRange(changed) {
  const start = parseTime($("r-start").value);
  const end = parseTime($("r-end").value);
  const len = parseTime($("r-len").value);
  if (changed === "end" && !Number.isNaN(end) && !Number.isNaN(start)) $("r-len").value = end > start ? fmtTime(end - start) : "";
  if (changed === "len" && !Number.isNaN(len) && !Number.isNaN(start)) $("r-end").value = fmtTime(start + len);
  if (changed === "start" && !Number.isNaN(start) && !Number.isNaN(len)) $("r-end").value = fmtTime(start + len);
  trimError("");
  setDirty(true);
}
$("r-start").addEventListener("input", () => syncRange("start"));
$("r-end").addEventListener("input", () => syncRange("end"));
$("r-len").addEventListener("input", () => syncRange("len"));

$("apply").addEventListener("click", async () => {
  trimError("");
  let req;
  try { req = buildRequest(); } catch (err) { return trimError(err.message); }
  state.rendering = true;
  setDirty(state.dirty);
  try {
    const res = await postJson("/api/import/process", { id: state.staged.id, ...req });
    state.staged.result = res.result;
    state.rendering = false;
    renderMeta();
    loadPreview();
    setDirty(false);
    $("trim-status").textContent = `Preview updated: ${fmtTime(res.result.durationSec)} will be saved.`;
  } catch (err) {
    state.rendering = false;
    setDirty(true);
    if (err.status === 404) {
      banner(err.message);
      return reset();
    }
    trimError(err.message);
  }
});

// ---------- name & save ----------

function nameError(message) {
  $("name-error").textContent = message;
  $("name-error").hidden = !message;
  $("name").setAttribute("aria-invalid", message ? "true" : "false");
}

$("name").addEventListener("input", () => nameError(""));

$("save-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.dirty || state.rendering) return;
  const name = $("name").value.trim();
  if (!name) return nameError("Enter a name for the sound.");
  $("save").disabled = true;
  try {
    const res = await postJson("/api/import/save", { id: state.staged.id, name });
    $("player").pause();
    $("player").removeAttribute("src");
    const len = fmtTime(state.staged.result.durationSec);
    state.staged = null;
    $("done-text").textContent = `Saved as "${res.name}" (${len}). It is in the sound library now. Reload the soundboard page to see it.`;
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
  state.rendering = false;
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
