// Log viewer: shows sound-play-logs.json and voice-activity-logs.json through /api/logs.
// Newest entries are at the top and the oldest at the bottom; each log opens scrolled to the top (the newest).
// The logs store UTC timestamps; every time shown here is converted to the browser's own time zone.
// Independent of the dashboard scripts.
const $ = (id) => document.getElementById(id);

// Page key (?key=...) is forwarded to the API as a header, same as the other pages.
const key = new URLSearchParams(location.search).get("key");
const authHeaders = key ? { "X-Access-Key": key } : {};
$("back").href = "/" + location.search;

const PAGE = 200; // entries per "Load older" and for the first load
const ALL_CHUNK = 5000; // largest chunk the server returns (used by "Load all" and by polling)
const POLL_MS = 5000;
const NEAR_TOP_PX = 48;
const NONE = "—";

const nf = new Intl.NumberFormat();
const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const zoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zoneShort = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
  .formatToParts(new Date())
  .find((p) => p.type === "timeZoneName")?.value;
$("tz").textContent =
  `Times are in your local time zone (${[zoneId, zoneShort].filter(Boolean).join(", ")}). Hover a time for the original UTC value.`;

// ---------- cells ----------

function parseTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function setText(node, value) {
  if (value == null || value === "") {
    node.textContent = NONE;
    node.classList.add("none");
  } else {
    node.textContent = value;
  }
}

function renderTime(td, e) {
  const d = parseTime(e.timestamp);
  if (!d) return setText(td, e.timestamp);
  const t = document.createElement("time");
  t.dateTime = e.timestamp;
  t.title = `UTC: ${e.timestamp}`;
  t.textContent = timeFmt.format(d);
  td.append(t);
}

function renderUser(td, e) {
  setText(td, e.username || e.userId);
  if (e.username && e.userId) td.title = `User ID ${e.userId}`;
}

function actionKind(action) {
  const a = String(action).toUpperCase();
  if (/DISCONNECT|LEAVE/.test(a)) return "leave"; // checked first: "DISCONNECT" contains "CONNECT"
  if (/CONNECT|JOIN/.test(a)) return "join";
  if (/MOVE|SWITCH/.test(a)) return "move";
  return "other";
}

function renderAction(td, e) {
  if (!e.action) return setText(td, null);
  const b = document.createElement("span");
  b.className = "badge";
  b.dataset.kind = actionKind(e.action);
  b.textContent = e.action;
  td.append(b);
}

// To show a new log field: add its name to FIELDS in src/http/logRoutes.ts and a column here.
const VIEWS = {
  sound: {
    label: "Sound plays",
    empty: "No sounds have been played yet.",
    columns: [
      { key: "timestamp", label: "Time", cls: "time", render: renderTime },
      { key: "sound", label: "Sound", cls: "strong" },
      { key: "username", label: "User", render: renderUser },
      { key: "source", label: "Source" },
      { key: "trigger", label: "Trigger" },
      { key: "guildId", label: "Guild ID", cls: "id" },
      { key: "channelId", label: "Channel ID", cls: "id" },
    ],
  },
  voice: {
    label: "Voice activity",
    empty: "No voice activity has been logged yet.",
    columns: [
      { key: "timestamp", label: "Time", cls: "time", render: renderTime },
      { key: "action", label: "Action", render: renderAction },
      { key: "username", label: "User", render: renderUser },
      { key: "guildName", label: "Server" },
      { key: "channelName", label: "Channel" },
      { key: "previousChannelName", label: "Previous channel" },
    ],
  },
};

// ---------- state ----------

const freshView = () => ({
  items: [], // { i, data, hay } oldest first (the table shows them in reverse)
  start: 0, // index of items[0] in the file
  end: 0, // index after the last loaded entry
  total: 0,
  skipped: 0,
  loaded: false,
  pinned: true, // scrolled to the top, where the newest entries are
  scrollTop: 0,
});
const state = { name: "sound", pending: 0, views: { sound: freshView(), voice: freshView() } };
const view = () => state.views[state.name];
let filterText = "";

const scroller = $("scroller");
const tbody = $("tbody");

function makeItems(entries, start) {
  return entries.map((data, n) => ({
    i: start + n,
    data,
    hay: [...Object.values(data), parseTime(data.timestamp) ? timeFmt.format(parseTime(data.timestamp)) : ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }));
}

const matches = (item) => !filterText || item.hay.includes(filterText);

// ---------- rendering ----------

function renderHead() {
  const cfg = VIEWS[state.name];
  const tr = document.createElement("tr");
  tr.setAttribute("role", "row");
  for (const col of cfg.columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.setAttribute("role", "columnheader");
    th.textContent = col.label;
    tr.append(th);
  }
  $("thead").replaceChildren(tr);
  $("caption").textContent = `${cfg.label}, newest first`;
}

function rowFor(item) {
  const tr = document.createElement("tr");
  tr.setAttribute("role", "row");
  for (const col of VIEWS[state.name].columns) {
    const td = document.createElement("td");
    td.setAttribute("role", "cell");
    td.dataset.label = col.label;
    if (col.cls) td.className = col.cls;
    if (col.render) col.render(td, item.data);
    else setText(td, item.data[col.key]);
    tr.append(td);
  }
  return tr;
}

function updateCount(name) {
  const v = state.views[name];
  $(`count-${name}`).textContent = v.loaded ? nf.format(v.total) : "";
}

function updateChrome() {
  const v = view();
  const shown = tbody.childElementCount;
  const older = v.start;

  $("older-bar").hidden = !v.loaded || older === 0;
  $("start-note").hidden = !v.loaded || older !== 0 || v.total === 0;
  if (older > 0) {
    $("older").textContent = `Load ${nf.format(Math.min(PAGE, older))} older`;
    $("all").textContent = `Load all ${nf.format(older)} older`;
    $("all").hidden = older <= PAGE;
    $("older-note").textContent = `${nf.format(older)} older ${older === 1 ? "entry is" : "entries are"} not loaded.`;
  }

  $("empty").hidden = !v.loaded || shown > 0;
  $("empty").textContent = v.items.length ? "No loaded entries match the filter." : VIEWS[state.name].empty;

  let summary;
  if (!v.loaded) {
    summary = state.pending ? "Loading…" : "Nothing loaded yet. Use Refresh to try again.";
  } else {
    summary =
      v.items.length === v.total
        ? `All ${nf.format(v.total)} ${v.total === 1 ? "entry" : "entries"} loaded`
        : `Latest ${nf.format(v.items.length)} of ${nf.format(v.total)} entries loaded`;
    if (v.total > 0) summary += " · newest at the top";
    if (filterText) summary += ` · ${nf.format(shown)} match the filter`;
    if (v.skipped) summary += ` · ${nf.format(v.skipped)} unreadable ${v.skipped === 1 ? "entry" : "entries"} skipped`;
  }
  $("summary").textContent = summary;
}

function rebuild() {
  const frag = document.createDocumentFragment();
  const items = view().items;
  for (let n = items.length - 1; n >= 0; n--) if (matches(items[n])) frag.append(rowFor(items[n]));
  tbody.replaceChildren(frag);
  updateChrome();
}

// New entries go on top. If the reader is at the top they stay there; otherwise the view is
// shifted down by the height of the new rows so the rows being read do not move.
function prependRows(fresh) {
  const wasPinned = view().pinned;
  const heightBefore = scroller.scrollHeight;
  const frag = document.createDocumentFragment();
  for (let n = fresh.length - 1; n >= 0; n--) if (matches(fresh[n])) frag.append(rowFor(fresh[n]));
  tbody.prepend(frag);
  if (wasPinned) scrollToTop();
  else scroller.scrollTop += scroller.scrollHeight - heightBefore;
  updateChrome();
}

// ---------- scrolling ----------

const atTop = () => scroller.scrollTop < NEAR_TOP_PX;

function scrollToTop() {
  scroller.scrollTop = 0;
  view().pinned = true;
  $("latest").hidden = true;
}

scroller.addEventListener(
  "scroll",
  () => {
    const v = view();
    v.pinned = atTop();
    $("latest").hidden = v.pinned || !v.loaded;
  },
  { passive: true },
);
$("latest").addEventListener("click", scrollToTop);

// ---------- loading ----------

async function api(params) {
  const res = await fetch("/api/logs?" + new URLSearchParams(params), { headers: authHeaders });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Access key missing or wrong. Open this page with ?key=..."
        : data?.error || `Server returned ${res.status}.`,
    );
  }
  return data;
}

function setBusy() {
  const busy = state.pending > 0;
  for (const id of ["refresh", "older", "all"]) $(id).disabled = busy;
}

// Runs one network task at a time, in order, and reports failures in the banner.
let chain = Promise.resolve();
function run(task) {
  state.pending++;
  setBusy();
  const p = chain.then(async () => {
    try {
      await task();
      $("banner").hidden = true;
    } catch (err) {
      $("banner").textContent = err.message || String(err);
      $("banner").hidden = false;
    } finally {
      state.pending--;
      setBusy();
      updateChrome();
    }
  });
  chain = p;
  return p;
}

async function loadLatest(name) {
  const data = await api({ type: name, limit: PAGE });
  const v = state.views[name];
  v.items = makeItems(data.entries, data.start);
  v.start = data.start;
  v.end = data.start + data.entries.length;
  v.total = data.total;
  v.skipped = data.skipped;
  v.loaded = true;
  v.pinned = true;
  updateCount(name);
  if (name === state.name) {
    rebuild();
    scrollToTop();
  }
}

async function loadOlder(name, all) {
  const v = state.views[name];
  while (v.start > 0) {
    const data = await api({ type: name, before: v.start, limit: all ? ALL_CHUNK : PAGE });
    if (data.total < v.end) return loadLatest(name); // the file was cut down or rotated: start over
    if (!data.entries.length) break;
    v.items = makeItems(data.entries, data.start).concat(v.items);
    v.start = data.start;
    v.total = data.total;
    v.skipped = data.skipped;
    if (!all) break;
  }
  updateCount(name);
  if (name === state.name) {
    // Older rows are added below what the reader is looking at, so keep the scroll position as it is.
    const top = scroller.scrollTop;
    rebuild();
    scroller.scrollTop = top;
  }
}

// Fetches entries added to the file since the last load.
async function poll(name) {
  const v = state.views[name];
  if (!v.loaded) return loadLatest(name);

  for (let round = 0; round < 20; round++) {
    const data = await api({ type: name, from: v.end, limit: ALL_CHUNK });
    if (data.total < v.end) return loadLatest(name); // the file was cut down or rotated: start over
    v.total = data.total;
    v.skipped = data.skipped;
    if (data.entries.length) {
      const fresh = makeItems(data.entries, data.start);
      for (const item of fresh) v.items.push(item);
      v.end = data.start + data.entries.length;
      if (name === state.name) prependRows(fresh);
    }
    if (v.end >= data.total) break;
  }
  updateCount(name);
}

// ---------- tabs ----------

function selectTab(name, { focus = false, writeHash = true } = {}) {
  if (!VIEWS[name]) name = "sound";

  const prev = view();
  prev.scrollTop = scroller.scrollTop;
  prev.pinned = atTop();

  state.name = name;
  for (const btn of $("tablist").querySelectorAll("[role=tab]")) {
    const selected = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(selected));
    btn.tabIndex = selected ? 0 : -1;
  }
  $("panel").setAttribute("aria-labelledby", `tab-${name}`);
  if (focus) $(`tab-${name}`).focus();
  if (writeHash) history.replaceState(null, "", "#" + name);

  renderHead();
  const v = view();
  if (v.loaded) {
    const wantTop = v.pinned;
    rebuild();
    if (wantTop) scrollToTop();
    else scroller.scrollTop = v.scrollTop;
    v.pinned = wantTop;
    $("latest").hidden = wantTop;
    if ($("live").checked) run(() => poll(name)); // catch up on what happened while this tab was hidden
  } else {
    tbody.replaceChildren();
    $("latest").hidden = true;
    run(() => loadLatest(name));
  }
  updateChrome();
}

for (const btn of $("tablist").querySelectorAll("[role=tab]")) {
  btn.addEventListener("click", () => selectTab(btn.dataset.tab));
}

$("tablist").addEventListener("keydown", (e) => {
  const names = Object.keys(VIEWS);
  const i = names.indexOf(state.name);
  let next = -1;
  if (e.key === "ArrowRight") next = (i + 1) % names.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + names.length) % names.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = names.length - 1;
  if (next < 0) return;
  e.preventDefault();
  selectTab(names[next], { focus: true });
});

window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (VIEWS[name] && name !== state.name) selectTab(name, { writeHash: false });
});

// ---------- controls ----------

$("older").addEventListener("click", () => {
  const name = state.name;
  run(() => loadOlder(name, false));
});
$("all").addEventListener("click", () => {
  const name = state.name;
  run(() => loadOlder(name, true));
});
$("refresh").addEventListener("click", () => {
  const name = state.name;
  run(() => poll(name));
});

let filterTimer = 0;
$("filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterText = $("filter").value.trim().toLowerCase();
    rebuild();
    scrollToTop();
  }, 120);
});

function livePoll() {
  if (!$("live").checked || document.hidden || state.pending) return;
  const name = state.name;
  run(() => poll(name));
}
setInterval(livePoll, POLL_MS);
document.addEventListener("visibilitychange", livePoll);
$("live").addEventListener("change", livePoll);

// ---------- start ----------

const fromHash = location.hash.slice(1);
selectTab(VIEWS[fromHash] ? fromHash : "sound", { writeHash: false });
