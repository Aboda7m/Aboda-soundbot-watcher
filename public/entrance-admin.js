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
    const system = await api("/api/entrance/system/status");
    $("system-admin").hidden = !system.allowed;
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
  if (!guildId) { $("status").textContent = "Select a server."; $("member-search").disabled = true; return; }
  $("status").textContent = "Loading members…";
  $("guild").disabled = true;
  $("member-search").disabled = true;
  try {
    const [data, policyData] = await Promise.all([
      api(`/api/entrance/admin/members?guildId=${encodeURIComponent(guildId)}`),
      api(`/api/entrance/admin/policy?guildId=${encodeURIComponent(guildId)}`)
    ]);
    $("guild-policy").hidden = false;
    $("policy-enabled").checked = policyData.policy.enabled !== false;
    $("policy-duration").value = policyData.policy.maxDurationSec ?? "";
    state.members = data.members || [];
    $("status").textContent = `${state.members.length} members loaded from ${data.guild.name}.`;
    $("member-search").disabled = false;
    renderMembers();
  } catch (err) {
    $("status").textContent = "Could not load members.";
    showError(err.message);
  } finally {
    $("guild").disabled = false;
  }
}

function hasActiveAssignment(m) {
  return Boolean(m.adminMode === "suppressed" || m.adminMode === "assigned" || m.sound);
}

function renderMembers() {
  const root = $("members");
  root.replaceChildren();
  
  const query = $("member-search").value.trim().toLowerCase();

  // Filter by search query if present
  let filtered = state.members.filter(m => {
    if (!query) return true;
    const name = (m.displayName || "").toLowerCase();
    const uname = (m.username || "").toLowerCase();
    const id = (m.id || "").toLowerCase();
    return name.includes(query) || uname.includes(query) || id.includes(query);
  });

  // Sort: Assigned/active items first, then A-Z by display name / username
  filtered.sort((a, b) => {
    const aActive = hasActiveAssignment(a);
    const bActive = hasActiveAssignment(b);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    const nameA = (a.displayName || a.username || "").toLowerCase();
    const nameB = (b.displayName || b.username || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "No members match your search." : "No members were returned for this server.";
    root.append(empty);
    return;
  }

  for (const member of filtered) {
    const row = document.createElement("article"); row.className = "member";
    const info = document.createElement("div"); info.className = "name";
    
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    
    const title = document.createElement("strong"); 
    title.textContent = member.displayName || member.username;
    
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-id-btn";
    copyBtn.textContent = "Copy ID";
    copyBtn.setAttribute("aria-label", `Copy user ID for ${member.username}`);
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(member.id);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy ID"; }, 1500);
      } catch {
        showError("Failed to copy user ID.");
      }
    });

    titleRow.append(title, copyBtn);

    const detail = document.createElement("div"); detail.className = "assignment";
    detail.textContent = member.adminMode === "suppressed"
      ? "Administrator-suppressed in this server"
      : member.adminMode === "assigned"
        ? `Administrator-assigned: ${member.sound}${member.exists ? "" : " (file missing)"}`
        : member.userMode === "disabled"
          ? "Member disabled their entrance in this server"
          : member.sound ? `${member.userMode === "sound" ? "Member's custom server sound" : "Member's global sound"}: ${member.sound}${member.exists ? "" : " (file missing)"}`
            : "No entrance sound assigned";
    info.append(titleRow, detail);

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
    const suppress = document.createElement("button"); suppress.textContent = "Suppress";
    suppress.disabled = member.guildOverride && member.sound === null;
    suppress.addEventListener("click", async () => {
      suppress.disabled = true; showError("");
      try { await post("/api/entrance/admin/clear", { guildId: state.guildId, userId: member.id }); await loadMembers(state.guildId); }
      catch (err) { showError(err.message); suppress.disabled = false; }
    });
    const release = document.createElement("button"); release.textContent = "Release override";
    release.disabled = !member.guildOverride;
    release.addEventListener("click", async () => {
      release.disabled = true; showError("");
      try { await post("/api/entrance/admin/release", { guildId: state.guildId, userId: member.id }); await loadMembers(state.guildId); }
      catch (err) { showError(err.message); release.disabled = false; }
    });
    actions.append(assign, suppress, release);
    row.append(info, select, actions);
    root.append(row);
  }
}

$("guild").addEventListener("change", () => loadMembers($("guild").value));
$("member-search").addEventListener("input", renderMembers);
init();

$("save-policy").addEventListener("click", async () => {
  const raw = $("policy-duration").value.trim();
  const duration = raw === "" ? null : Number(raw);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 30)) { showError("Duration must be 1–30 seconds, or blank for no cap."); return; }
  try { await post("/api/entrance/admin/policy", { guildId: state.guildId, enabled: $("policy-enabled").checked, maxDurationSec: duration }); showError(""); }
  catch (err) { showError(err.message); }
});
$("save-system").addEventListener("click", async () => {
  const userId = $("system-user").value.trim(); const raw = $("system-duration").value.trim();
  const durationSec = raw === "" ? null : Number(raw);
  if (!/^\d{15,25}$/.test(userId)) { showError("Enter a valid Discord user ID."); return; }
  if (durationSec !== null && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 30)) { showError("Duration must be 1–30 seconds, or blank to remove."); return; }
  try { await post("/api/entrance/system/user-duration", { userId, durationSec }); showError(""); }
  catch (err) { showError(err.message); }
});

$("load-system").addEventListener("click", async () => {
  const userId = $("system-user").value.trim();
  if (!/^\d{15,25}$/.test(userId)) { showError("Enter a valid Discord user ID."); return; }
  try { const data = await api(`/api/entrance/system/user-duration?userId=${encodeURIComponent(userId)}`); $("system-duration").value = data.durationSec ?? ""; showError(""); }
  catch (err) { showError(err.message); }
});