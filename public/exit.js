"use strict";
const $ = (id) => document.getElementById(id);
let current = null;
let sounds = [];
let audio = null;

function say(text) { const m = $("msg"); m.textContent = text || ""; m.hidden = !text; }

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function play(name) {
  try {
    const res = await fetch(`/api/exit/preview?sound=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error("Could not load that sound");
    const url = URL.createObjectURL(await res.blob());
    if (audio) audio.pause();
    audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch (e) { say(e.message); }
}

function renderCurrent(data) {
  current = data.sound;
  $("current").textContent = data.sound
    ? data.sound + (data.exists ? "" : " (no longer exists, so nothing will play)")
    : "No exit sound set.";
  $("preview").disabled = !data.sound || !data.exists;
  $("clear").disabled = !data.sound;
  renderList();
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const ul = $("list");
  ul.textContent = "";
  for (const name of sounds.filter((n) => n.toLowerCase().includes(q))) {
    const li = document.createElement("li");
    if (name === current) li.setAttribute("aria-current", "true");
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    const play_ = document.createElement("button");
    play_.type = "button"; play_.className = "btn small"; play_.textContent = "Play";
    play_.addEventListener("click", () => play(name));
    const set = document.createElement("button");
    set.type = "button"; set.className = "btn small"; set.textContent = name === current ? "Selected" : "Set";
    set.disabled = name === current;
    set.addEventListener("click", async () => {
      say("");
      try { await api("/api/exit", { sound: name }); renderCurrent(await api("/api/exit")); }
      catch (e) { say(e.message); }
    });
    const actions = document.createElement("span");
    actions.append(play_, " ", set);
    li.append(label, actions);
    ul.append(li);
  }
}

$("preview").addEventListener("click", () => current && play(current));
$("clear").addEventListener("click", async () => {
  say("");
  try { await api("/api/exit/clear", {}); renderCurrent(await api("/api/exit")); }
  catch (e) { say(e.message); }
});
$("search").addEventListener("input", renderList);

(async () => {
  try {
    const [mine, list] = await Promise.all([api("/api/exit"), fetch("/api/sounds", { cache: "no-store" }).then((r) => r.json())]);
    // /api/sounds shape is assumed: an array of names or of { name } objects (also accepts { sounds: [...] }).
    const arr = Array.isArray(list) ? list : list.sounds ?? [];
    sounds = arr.map((s) => (typeof s === "string" ? s : s.name)).filter(Boolean).sort((a, b) => a.localeCompare(b));
    renderCurrent(mine);
  } catch (e) { say(e.message); $("current").textContent = ""; }
})();
