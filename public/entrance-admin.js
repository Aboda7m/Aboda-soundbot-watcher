"use strict";
const $ = (id) => document.getElementById(id);
const state = { guilds: [], sounds: [], members: [], guildId: "", busy: false };

function showError(message) { $("banner").textContent = message || ""; $("banner").hidden = !message; }
async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const post = (path, body) => api(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });

async function init() {
  try {
    const [guildData, soundData] = await Promise.all([
      api("/api/entrance/admin/guilds"),
      api("/api/sounds")
    ]);
    state.guilds = guildData.guilds || [];
    state.sounds = (soundData.sounds || []).map(s => s.name);
    const select = $("guild");
    select.replaceChildren(new Option(state.guilds.length ? "Choose a server…" : "No servers you can administer", ""));
    for (const guild of state.guilds) select.add(new Option(guild.name, guild.id));
    select.disabled = !state.guilds.length;
    $("status").textContent = state.guilds.length ? "Select a server to load its members." : "You do not administer any server where the bot is present.";
    if (state.guilds.length === 1) { select.value = state.guilds[0].id; await loadMembers(select.value); }
  } catch (err) {
    $("status").textContent = "Could not load administration access.";
    showError(err.message);
  }
}

async function loadMembers(guildId) {
  state.guildId = guildId;
  state.members = [];
  $("members").replaceChildren();
  showError("");
  if (!guildId) { $("status").textContent = "Select a server."; return; }
  $("status").textContent = "Loading members…";
  $("guild").disabled = true;
  try {
    const data = await api(`/api/entrance/admin/members?guildId=${encodeURIComponent(guildId)}`);
    state.members = data.members || [];
    $("status").textContent = `${state.members.length} members loaded from ${data.guild.name}.`;
    renderMembers();
  } catch (err) {
    $("status").textContent = "Could not load members.";
    showError(err.message);
  } finally {
    $("guild").disabled = false;
  }
}

function renderMembers() {
  const root = $("members");
  root.replaceChildren();
  if (!state.members.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No members were returned for this server.";
    root.append(empty);
    return;
  }
  for (const member of state.members) {
    const row = document.createElement("article"); row.className = "member";
    const info = document.createElement("div"); info.className = "name";
    const title = document.createElement("strong"); title.textContent = member.displayName || member.username;
    const detail = document.createElement("div"); detail.className = "assignment";
    detail.textContent = member.sound
      ? `${member.guildOverride ? "Server override" : "Personal sound"}: ${member.sound}${member.exists ? "" : " (file missing)"}`
      : member.guildOverride ? "No sound in this server (personal sound suppressed)" : "No entrance sound assigned";
    info.append(title, detail);

    const select = document.createElement("select"); select.setAttribute("aria-label", `Entrance sound for ${member.username}`);
    select.add(new Option("Choose a sound…", ""));
    for (const name of state.sounds) select.add(new Option(name, name));
    select.value = state.sounds.includes(member.sound) ? member.sound : "";

    const actions = document.createElement("div"); actions.className = "actions";
    const assign = document.createElement("button"); assign.className = "primary"; assign.textContent = "Assign";
    assign.disabled = !select.value || (member.guildOverride && select.value === member.sound);
    select.addEventListener("change", () => { assign.disabled = !select.value || (member.guildOverride && select.value === member.sound); });
    assign.addEventListener("click", async () => {
      assign.disabled = true; showError("");
      try {
        await post("/api/entrance/admin/assign", { guildId: state.guildId, userId: member.id, sound: select.value });
        await loadMembers(state.guildId);
      } catch (err) { showError(err.message); assign.disabled = false; }
    });
    const clear = document.createElement("button"); clear.textContent = "Remove";
    clear.disabled = !member.sound;
    clear.addEventListener("click", async () => {
      clear.disabled = true; showError("");
      try {
        await post("/api/entrance/admin/clear", { guildId: state.guildId, userId: member.id });
        await loadMembers(state.guildId);
      } catch (err) { showError(err.message); clear.disabled = false; }
    });
    actions.append(assign, clear);
    row.append(info, select, actions);
    root.append(row);
  }
}

$("guild").addEventListener("change", () => loadMembers($("guild").value));
init();
