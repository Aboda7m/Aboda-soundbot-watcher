// "My entrance sound": pick one of the available sounds as your own entrance sound.
// Whose sound it is comes from the Discord sign-in session on the server; this page never sends a user id.
const $ = (id) => document.getElementById(id);

const state = { names: [], current: null, exists: false, busy: false };
let audio = null;
let audioUrl = null;
let playing = null;
let previewSeq = 0;

function banner(message) {
  $("banner").textContent = message || "";
  $("banner").hidden = !message;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = res.status === 401 ? "Your session has expired. Reload the page to sign in again." : data?.error || `Server returned ${res.status}.`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}
const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

// ---------- preview (fetched as a blob so it works in every browser, Safari included) ----------

function stopPreview() {
  previewSeq++;
  if (audio) { audio.pause(); audio = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  playing = null;
  renderPreviewButtons();
}

async function preview(name) {
  if (playing === name) return stopPreview();
  stopPreview();
  const seq = previewSeq;
  playing = name;
  renderPreviewButtons();
  try {
    const res = await fetch(`/api/entrance/preview?sound=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error("Could not load that sound.");
    const blob = await res.blob();
    if (seq !== previewSeq) return;
    audioUrl = URL.createObjectURL(blob);
    audio = new Audio(audioUrl);
    audio.addEventListener("ended", () => { if (seq === previewSeq) stopPreview(); });
    await audio.play();
  } catch (err) {
    if (seq !== previewSeq) return;
    banner(err.name === "NotSupportedError" ? "This browser cannot play that file." : err.message);
    stopPreview();
  }
}

function renderPreviewButtons() {
  for (const btn of document.querySelectorAll("[data-preview]")) {
    btn.textContent = btn.dataset.preview === playing ? "Stop" : "Preview";
  }
}

// ---------- rendering ----------

function renderCurrent() {
  const text = $("current-text");
  text.replaceChildren();
  if (!state.current) {
    text.textContent = "You have no entrance sound. Pick one below.";
  } else if (!state.exists) {
    const strong = document.createElement("strong");
    strong.textContent = state.current;
    text.append(strong, " (this sound no longer exists, so nothing will play).");
  } else {
    const strong = document.createElement("strong");
    strong.textContent = state.current;
    text.append("It plays when you join a voice channel: ", strong);
  }
  const play = $("current-play");
  play.hidden = !(state.current && state.exists);
  play.dataset.preview = state.current ?? "";
  $("clear").hidden = !state.current;
  renderPreviewButtons();
}

function buildRows() {
  const list = $("list");
  list.replaceChildren();
  for (const name of state.names) {
    const li = document.createElement("li");
    li.className = "row";
    li.dataset.name = name;

    const label = document.createElement("span");
    label.className = "row-name";
    label.textContent = name;

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "Current";
    tag.hidden = true;

    const play = document.createElement("button");
    play.type = "button";
    play.className = "btn";
    play.dataset.preview = name;
    play.textContent = "Preview";
    play.setAttribute("aria-label", `Preview ${name}`);
    play.addEventListener("click", () => preview(name));

    const set = document.createElement("button");
    set.type = "button";
    set.className = "btn primary";
    set.dataset.set = name;
    set.textContent = "Set";
    set.setAttribute("aria-label", `Set ${name} as my entrance sound`);
    set.addEventListener("click", () => choose(name));

    li.append(label, tag, play, set);
    list.append(li);
  }
  markCurrent();
  filter();
}

function markCurrent() {
  for (const li of $("list").children) {
    const isCurrent = li.dataset.name === state.current;
    li.dataset.current = String(isCurrent);
    li.querySelector(".tag").hidden = !isCurrent;
    const set = li.querySelector("[data-set]");
    set.disabled = isCurrent;
    set.textContent = isCurrent ? "Selected" : "Set";
  }
}

function filter() {
  const q = $("search").value.trim().toLowerCase();
  let shown = 0;
  for (const li of $("list").children) {
    const match = !q || li.dataset.name.toLowerCase().includes(q);
    li.hidden = !match;
    if (match) shown++;
  }
  const total = state.names.length;
  $("results").textContent = !total ? "No sounds available." : q ? `${shown} of ${total} sounds` : `${total} sounds`;
}

// ---------- actions ----------

async function choose(name) {
  if (state.busy) return;
  state.busy = true;
  banner("");
  try {
    await postJson("/api/entrance", { sound: name });
    state.current = name;
    state.exists = true;
    renderCurrent();
    markCurrent();
  } catch (err) {
    banner(err.message);
  } finally {
    state.busy = false;
  }
}

async function clearEntrance() {
  if (state.busy) return;
  state.busy = true;
  banner("");
  try {
    await postJson("/api/entrance/clear");
    state.current = null;
    state.exists = false;
    renderCurrent();
    markCurrent();
  } catch (err) {
    banner(err.message);
  } finally {
    state.busy = false;
  }
}

async function renderGuildPreferences(guilds) {
  const root = $("guild-preferences"); root.replaceChildren();
  if (!guilds.length) { root.textContent = "No accessible servers are available."; return; }
  for (const guild of guilds) {
    const row = document.createElement("div"); row.className = "row";
    const label = document.createElement("strong"); label.textContent = guild.name;
    const detail = document.createElement("small");
    const mode = document.createElement("select"); mode.setAttribute("aria-label", `Entrance preference for ${guild.name}`);
    for (const [value, text] of [["inherit", "Inherit global"], ["sound", "Custom sound"], ["disabled", "Disabled"]]) mode.add(new Option(text, value));
    
    const sound = document.createElement("select"); sound.setAttribute("aria-label", `Custom sound for ${guild.name}`);
    sound.add(new Option("Choose a sound…", "")); for (const name of state.names) sound.add(new Option(name, name)); sound.hidden = true;

    const duration = document.createElement("input");
    duration.type = "number";
    duration.min = "1";
    duration.max = "30";
    duration.step = "1";
    duration.placeholder = "Use global";
    duration.setAttribute("aria-label", `Personal duration override for ${guild.name}`);

    try {
      const pref = await api(`/api/entrance/settings?guildId=${encodeURIComponent(guild.id)}`);
      mode.value = pref.mode;
      sound.value = pref.guildSound || "";
      sound.hidden = mode.value !== "sound";

      const fmt = (v) => v == null ? "No cap" : `${v}s`;
      duration.value = pref.guildPersonalDurationSec ?? "";

      detail.textContent = `Preferred: ${fmt(pref.personalDurationSec)} · Server cap: ${fmt(pref.guildDurationSec)} · Bot-admin cap: ${fmt(pref.botAdminDurationSec)} · Effective: ${fmt(pref.effectiveDurationSec)}`;
    } catch (err) {
      mode.disabled = true;
      sound.disabled = true;
      detail.textContent = `Could not load settings: ${err.message}`;
    }

    mode.addEventListener("change", () => {
      sound.hidden = mode.value !== "sound";
    });

    const save = document.createElement("button"); save.type = "button"; save.className = "btn"; save.textContent = "Save";
    save.addEventListener("click", async () => {
      try { if (mode.value === "sound" && !sound.value) throw new Error("Choose a sound first.");
        const rawDuration = duration.value.trim(); const durationSec = rawDuration === "" ? null : Number(rawDuration);
        if (durationSec !== null && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 30)) throw new Error("Server-specific personal duration must be 1–30 seconds, or blank to inherit the global preference.");
        await postJson("/api/entrance/preferences", { guildId: guild.id, mode: mode.value, ...(mode.value === "sound" ? { sound: sound.value } : {}) });
        await postJson("/api/entrance/duration", { guildId: guild.id, durationSec });
        banner(`${guild.name}: preference saved.`);
      } catch (err) { banner(err.message); }
    });
    row.append(label, mode, sound, duration, save, detail); root.append(row);
  }
}

async function init() {
  try {
    const [me, sounds, guildData] = await Promise.all([api("/api/entrance"), api("/api/sounds"), api("/api/entrance/guilds")]);
    $("who").textContent = `Signed in as ${me.user.username}`;
    state.current = me.sound;
    state.exists = me.exists;
    state.names = sounds.sounds.map((s) => s.name);
    $("duration").value = me.durationSec ?? "";
    await renderGuildPreferences(guildData.guilds || []);
    renderCurrent();
    buildRows();
    $("search").disabled = false;
  } catch (err) {
    $("current-text").textContent = "";
    banner(err.message);
  }
}

$("search").addEventListener("input", filter);
$("clear").addEventListener("click", clearEntrance);
$("current-play").addEventListener("click", () => preview($("current-play").dataset.preview));
init();

$("save-duration").addEventListener("click", async () => {
  const raw = $("duration").value.trim(); const durationSec = raw === "" ? null : Number(raw);
  if (durationSec !== null && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 30)) { banner("Duration must be 1–30 seconds, or blank for no personal cap."); return; }
  try { await postJson("/api/entrance/duration", { durationSec }); banner("Preferred duration saved."); }
  catch (err) { banner(err.message); }
});