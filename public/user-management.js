"use strict";
const $ = (id) => document.getElementById(id);
const state = { users: [], capabilities: [], adminCapabilities: [], owner: false, selected: null };
const LABELS = {
  dashboard: ["Dashboard access", "Sign in and use the soundboard."],
  import: ["Import sounds", "Add sounds to the shared sound library."],
  "entrance.manage": ["Manage other users' entrance sounds", "Assign or remove entrance sounds for other users."],
  "entrance.system": ["System-wide entrance restrictions", "Enforce per-user automatic entrance duration caps that users and server admins cannot bypass."],
  logs: ["View logs", "Read sound-play and voice-activity logs."],
  "access.manage": ["Manage bot user permissions", "Manage other users, but only delegate permissions you already have."],
};
function message(kind, text) { const node = $(kind); node.textContent = text || ""; node.hidden = !text; }
function fail(text) { message("error", text); message("notice", ""); }
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function post(path, body) { return api(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }); }
function roleName(role) { return ({owner:"Bot Owner",admin:"Bot Admin",user:"Normal user",custom:"Custom"})[role] || "Normal user"; }
async function load() {
  message("error", "");
  $("users").replaceChildren(Object.assign(document.createElement("p"), { className:"hint", textContent:"Loading users…" }));
  try {
    const data = await api("/api/access/users", { cache:"no-store" });
    state.users = data.users || []; state.capabilities = data.capabilities || []; state.adminCapabilities = data.adminCapabilities || []; state.owner = !!data.owner;
    renderUsers();
  } catch (err) { $("users").replaceChildren(); fail(err.message); }
}
function renderUsers() {
  const root = $("users"); root.replaceChildren();
  if (!state.users.length) { root.append(Object.assign(document.createElement("p"), { className:"hint", textContent:"No known users yet. Enter a Discord user ID above to configure someone." })); return; }
  for (const user of state.users) {
    const row = document.createElement("article"); row.className = "user-row";
    const info = document.createElement("div"); info.className = "user-info";
    const title = document.createElement("strong"); title.textContent = user.globalName ? `${user.globalName} (@${user.username})` : user.username;
    const detail = document.createElement("small"); detail.textContent = `${user.id}${user.blocked ? " · blocked by bot policy" : ""}`;
    info.append(title, detail);
    const role = document.createElement("span"); role.className = "role"; role.textContent = roleName(user.role);
    const button = document.createElement("button"); button.textContent = user.owner ? "Owner protected" : user.editable ? "Edit" : "Not editable"; button.disabled = !user.editable;
    button.addEventListener("click", () => openEditor(user));
    row.append(info, role, button); root.append(row);
  }
}
function openEditor(user) {
  state.selected = { id: user.id, capabilities: [...(user.capabilities || [])], role: user.role };
  $("editor").hidden = false; $("editor-title").textContent = `Edit ${user.username}`; $("editor-id").textContent = user.id; $("current-role").textContent = roleName(user.role);
  const role = ["user", "admin", "custom"].includes(user.role) ? user.role : "custom";
  document.querySelectorAll('input[name="role"]').forEach((radio) => { radio.checked = radio.value === role; });
  renderCapabilities(); updateCustomState();
  $("editor").scrollIntoView({ behavior:"smooth", block:"start" });
}
function renderCapabilities() {
  const root = $("permissions"); root.replaceChildren();
  for (const capability of state.capabilities) {
    const label = document.createElement("label"); label.className = "perm";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = "capability"; checkbox.value = capability;
    checkbox.checked = state.selected.capabilities.includes(capability);
    const text = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = LABELS[capability]?.[0] || capability;
    const small = document.createElement("small"); small.textContent = LABELS[capability]?.[1] || "Custom bot permission.";
    text.append(strong, small); label.append(checkbox, text); root.append(label);
  }
}
function selectedRole() { return document.querySelector('input[name="role"]:checked')?.value || "user"; }
function updateCustomState() {
  const custom = selectedRole() === "custom"; $("custom-fields").disabled = !custom;
  if (!custom) {
    const caps = selectedRole() === "admin" ? state.adminCapabilities : ["dashboard"];
    document.querySelectorAll('input[name="capability"]').forEach((checkbox) => { checkbox.checked = caps.includes(checkbox.value); });
  }
}
document.querySelectorAll('input[name="role"]').forEach((radio) => radio.addEventListener("change", updateCustomState));
$("lookup-form").addEventListener("submit", (event) => {
  event.preventDefault(); const id = $("user-id").value.trim();
  if (!/^\d{15,25}$/.test(id)) return fail("Enter a valid Discord user ID.");
  const known = state.users.find((u) => u.id === id);
  if (known) openEditor(known);
  else openEditor({ id, username:"New user", role:"user", capabilities:["dashboard"], editable:true });
  message("error", "");
});
$("save").addEventListener("click", async () => {
  if (!state.selected) return;
  const role = selectedRole();
  const capabilities = [...document.querySelectorAll('input[name="capability"]:checked')].map((node) => node.value);
  $("save").disabled = true; message("error", ""); message("notice", "");
  try {
    await post("/api/access/users/update", { userId:state.selected.id, role, capabilities });
    message("notice", "Permissions saved."); $("editor").hidden = true; state.selected = null; await load();
  } catch (err) { fail(err.message); }
  finally { $("save").disabled = false; }
});
$("cancel").addEventListener("click", () => { $("editor").hidden = true; state.selected = null; });
$("refresh").addEventListener("click", load);
load();
