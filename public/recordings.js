"use strict";
// Recordings browser: lists voice recordings from /api/recordings, lets you search and filter them, and plays them.
// Authentication is the Discord sign-in session cookie, sent by the browser itself.
// Names come from Discord and are untrusted: everything is inserted with textContent, never as HTML.
const $ = (id) => document.getElementById(id);

const PAGE = 60; // recordings shown at first and per "Show more"
const LIST_POLL_MS = 30000;
const DETAIL_POLL_MS = 10000;
const MAX_PPS = 40; // most zoomed-in timeline: pixels per second
const NONE = "—";

// ---------- small helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === "hue") node.style.setProperty("--hue", String(v));
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const nf = new Intl.NumberFormat();
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const timeSecFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
const zoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad2 = (n) => String(n).padStart(2, "0");
const localDayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function fmtLen(sec) {
  if (sec == null) return NONE;
  if (sec < 10) return `${(Math.round(sec * 10) / 10).toFixed(1)} s`;
  return fmtClock(sec);
}
function fmtDur(sec) {
  if (sec == null) return "length unknown";
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${pad2(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${pad2(Math.floor((sec % 3600) / 60))} min`;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
// FNV-1a plus a final mix: user ids differ only in their last digits, and a plain hash would give them almost the same colour.
function hueOf(key) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) % 360;
}

const STATUS = {
  active: ["Recording now", "active"],
  interrupted: ["Interrupted", "interrupted"],
  incomplete: ["Incomplete", "incomplete"],
};
function statusBadge(status) {
  const s = STATUS[status];
  return s ? el("span", { class: "badge", "data-kind": s[1], text: s[0] }) : null;
}

const segLabel = (seg) => seg.username || seg.userId || "Unknown speaker";
const speakerKey = (sp) => sp.id || (sp.name ? `name:${sp.name}` : "unknown");
const speakerLabel = (sp) => sp.name || sp.id || "Unknown speaker";
const guildLabel = (s) => s.guildName || `Server ${s.guildId}`;
const channelLabel = (s) => s.channelName || (s.channelId ? `channel ${s.channelId}` : null);

// ---------- api / banner ----------

const banner = $("banner");
function showError(err) {
  banner.replaceChildren();
  if (!err) return void (banner.hidden = true);
  banner.append(err.message || String(err));
  if (err.status === 401) banner.append(" ", el("a", { href: "/login", text: "Sign in again" }));
  banner.hidden = false;
}

async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

const audioUrl = (session, seg, download) =>
  `/api/recordings/audio?guild=${encodeURIComponent(session.guildId)}&id=${encodeURIComponent(session.id)}&file=${encodeURIComponent(seg.file)}${download ? "&download=1" : ""}`;

// =====================================================================================
// LIST VIEW
// =====================================================================================

const state = { sessions: [], loaded: false, shown: PAGE, signature: "" };
const f = {
  q: $("q"), server: $("f-server"), person: $("f-person"), from: $("f-from"), to: $("f-to"),
  sort: $("f-sort"), empty: $("f-empty"),
};

function indexSession(s) {
  const started = new Date(s.startedAt);
  const parts = [
    s.guildName, s.guildId, s.channelName, s.channelId, s.id, s.status,
    s.initiatedBy && s.initiatedBy.name, s.initiatedBy && s.initiatedBy.id,
    localDayKey(started), s.startedAt.slice(0, 10), dayFmt.format(started), monthFmt.format(started), String(started.getFullYear()),
  ];
  for (const sp of s.speakers) parts.push(sp.name, sp.id);
  s._hay = parts.filter(Boolean).join("\n").toLowerCase();
  s._t = started.getTime();
  s._day = localDayKey(started);
}

function fillSelects() {
  const keepServer = f.server.value;
  const keepPerson = f.person.value;

  const servers = new Map();
  const people = new Map();
  for (const s of state.sessions) {
    const sv = servers.get(s.guildId) || { label: guildLabel(s), n: 0 };
    sv.n++;
    servers.set(s.guildId, sv);
    for (const sp of s.speakers) {
      const k = speakerKey(sp);
      const p = people.get(k) || { label: speakerLabel(sp), id: sp.id, n: 0 };
      p.n++;
      people.set(k, p);
    }
  }
  const byLabel = (a, b) => a[1].label.localeCompare(b[1].label, undefined, { sensitivity: "base" });
  f.server.replaceChildren(el("option", { value: "", text: "All servers" }));
  for (const [id, sv] of [...servers].sort(byLabel)) f.server.append(el("option", { value: id, text: `${sv.label} (${sv.n})` }));
  f.person.replaceChildren(el("option", { value: "", text: "Everyone" }));
  for (const [k, p] of [...people].sort(byLabel)) f.person.append(el("option", { value: k, text: `${p.label}${p.id && p.label !== p.id ? ` · ${p.id.slice(-4)}` : ""} (${p.n})` }));

  // keep the selection (it can come from the URL before the data arrives)
  if ([...f.server.options].some((o) => o.value === keepServer)) f.server.value = keepServer;
  if ([...f.person.options].some((o) => o.value === keepPerson)) f.person.value = keepPerson;
}

function filtered() {
  const terms = f.q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const fromMs = f.from.value ? new Date(`${f.from.value}T00:00:00`).getTime() : null;
  const toMs = f.to.value ? new Date(`${f.to.value}T23:59:59.999`).getTime() : null;
  const server = f.server.value;
  const person = f.person.value;
  const showEmpty = f.empty.checked;

  const out = state.sessions.filter((s) => {
    if (!showEmpty && s.segments === 0) return false;
    if (server && s.guildId !== server) return false;
    if (person && !s.speakers.some((sp) => speakerKey(sp) === person)) return false;
    if (fromMs !== null && s._t < fromMs) return false;
    if (toMs !== null && s._t > toMs) return false;
    return terms.every((t) => s._hay.includes(t));
  });

  const sort = f.sort.value;
  const cmp = {
    new: (a, b) => b._t - a._t,
    old: (a, b) => a._t - b._t,
    long: (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
    big: (a, b) => b.bytes - a.bytes,
  }[sort];
  return out.sort(cmp);
}

function dayLabel(key) {
  const now = new Date();
  if (key === localDayKey(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === localDayKey(y)) return "Yesterday";
  const [Y, M, D] = key.split("-").map(Number);
  return dayFmt.format(new Date(Y, M - 1, D));
}

function card(s) {
  const started = new Date(s._t);
  const chan = channelLabel(s);
  const title = el("p", { class: "c-title" }, el("span", { text: guildLabel(s) }));
  if (chan) title.append(el("span", { class: "chan", text: `  ·  ${s.channelName ? "#" : ""}${chan}` }));

  const people = el("div", { class: "c-people" });
  const MAXCHIPS = 6;
  for (const sp of s.speakers.slice(0, MAXCHIPS)) {
    people.append(el("span", { class: "chip", hue: hueOf(speakerKey(sp)), title: sp.id ? `User ID ${sp.id}` : null }, el("i"), el("span", { text: speakerLabel(sp) })));
  }
  if (s.speakers.length > MAXCHIPS) people.append(el("span", { class: "chip more", text: `+${s.speakers.length - MAXCHIPS} more` }));
  if (!s.speakers.length) people.append(el("span", { class: "hint", text: "No speech captured" }));

  const meta = el("div", { class: "c-meta" },
    el("b", { text: fmtDur(s.durationSec) }),
    el("span", { class: "dim", text: `${nf.format(s.segments)} ${s.segments === 1 ? "segment" : "segments"} · ${fmtBytes(s.bytes)}` }),
    statusBadge(s.status),
  );
  meta.firstChild.style.color = "var(--text)";

  const time = el("div", { class: "c-time" }, el("b", { text: timeFmt.format(started) }), el("span", { text: shortDayFmt.format(started) }));
  return el("li", {}, el("a", {
    class: `card${s.segments === 0 ? " empty-session" : ""}`,
    href: `#/r/${encodeURIComponent(s.guildId)}/${encodeURIComponent(s.id)}`,
    "aria-label": `${guildLabel(s)}, ${dayFmt.format(started)} ${timeFmt.format(started)}, ${fmtDur(s.durationSec)}`,
  }, time, el("div", { class: "c-main" }, title, people), meta));
}

function renderList() {
  const list = filtered();
  const results = $("results");
  results.replaceChildren();

  const totalSec = list.reduce((n, s) => n + (s.durationSec ?? 0), 0);
  const totalBytes = list.reduce((n, s) => n + s.bytes, 0);
  $("summary").textContent = state.loaded
    ? `${nf.format(list.length)} of ${nf.format(state.sessions.length)} recordings · ${fmtDur(totalSec)} · ${fmtBytes(totalBytes)} · times in your local time zone (${zoneId})`
    : "Loading…";

  const visible = list.slice(0, state.shown);
  const grouped = f.sort.value === "new" || f.sort.value === "old";
  let ul = null;
  let lastDay = null;
  for (const s of visible) {
    if (grouped && s._day !== lastDay) {
      lastDay = s._day;
      results.append(el("h2", { class: "day", text: dayLabel(s._day) }));
      ul = el("ul", { class: "cards" });
      results.append(ul);
    } else if (!grouped && !ul) {
      ul = el("ul", { class: "cards" });
      results.append(ul);
    }
    ul.append(card(s));
  }

  $("more-bar").hidden = list.length <= visible.length;
  $("more").textContent = `Show more (${nf.format(list.length - visible.length)} left)`;

  const empty = $("empty");
  if (state.loaded && !list.length) {
    empty.hidden = false;
    empty.textContent = state.sessions.length
      ? "No recordings match these filters."
      : "No recordings yet. Start one in a voice channel with !record start.";
  } else {
    empty.hidden = true;
  }
}

// ---- filters <-> URL (so a filtered view can be bookmarked or shared)
const PARAMS = [["q", f.q], ["server", f.server], ["person", f.person], ["from", f.from], ["to", f.to], ["sort", f.sort]];

function filtersToHash() {
  const p = new URLSearchParams();
  for (const [name, input] of PARAMS) if (input.value && !(name === "sort" && input.value === "new")) p.set(name, input.value);
  if (f.empty.checked) p.set("empty", "1");
  const qs = p.toString();
  listHash = `#/${qs ? `?${qs}` : ""}`;
  history.replaceState(null, "", listHash);
}
function hashToFilters(qs) {
  const p = new URLSearchParams(qs);
  for (const [name, input] of PARAMS) input.value = p.get(name) || (name === "sort" ? "new" : "");
  f.empty.checked = p.get("empty") === "1";
}

let listHash = "#/"; // where "All recordings" returns to, with the filters the person had

let typing = 0;
function onFilterChange() {
  state.shown = PAGE;
  renderList();
  filtersToHash();
}
f.q.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(onFilterChange, 120);
});
for (const input of [f.server, f.person, f.from, f.to, f.sort, f.empty]) input.addEventListener("change", onFilterChange);
$("filters").addEventListener("submit", (e) => e.preventDefault());
$("clear").addEventListener("click", () => {
  for (const [name, input] of PARAMS) input.value = name === "sort" ? "new" : "";
  f.empty.checked = false;
  onFilterChange();
  f.q.focus();
});
$("more").addEventListener("click", () => {
  state.shown += PAGE;
  renderList();
});

async function loadList(initial) {
  try {
    const data = await api("/api/recordings");
    showError(null);
    const sig = `${data.total}|${data.sessions.map((s) => `${s.id}:${s.bytes}:${s.status}`).join(",")}`;
    if (!initial && sig === state.signature) return;
    state.signature = sig;
    state.sessions = data.sessions;
    for (const s of state.sessions) indexSession(s);
    state.loaded = true;
    fillSelects();
    renderList();
    if (data.truncated) showError(new Error(`Showing the newest ${nf.format(data.sessions.length)} of ${nf.format(data.total)} recordings. Use the filters to narrow down.`));
  } catch (err) {
    state.loaded = true;
    showError(err);
    renderList();
  }
}

// =====================================================================================
// DETAIL VIEW
// =====================================================================================

const audio = $("audio");
const D = { session: null, segs: [], hidden: new Set(), current: null, pps: 1, total: 1, pollTimer: 0, zoomFrame: 0 };

function visibleSegs() {
  return D.segs.filter((s) => !D.hidden.has(s.key));
}

function setPlayerOffset() {
  const player = $("player");
  document.documentElement.style.setProperty("--player-h", player.hidden ? "0px" : `${player.offsetHeight}px`);
}

function markCurrent() {
  for (const node of document.querySelectorAll("[data-file]")) {
    if (D.current && node.dataset.file === D.current.file) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
}

function play(seg, startAt = 0) {
  D.current = seg;
  $("player").hidden = false;
  audio.src = audioUrl(D.session, seg);
  audio.defaultPlaybackRate = audio.playbackRate = Number($("p-speed").value);
  if (startAt > 0) audio.addEventListener("loadedmetadata", () => (audio.currentTime = startAt), { once: true });
  audio.play().catch(() => {});

  $("p-title").textContent = `${segLabel(seg)} · ${fmtClock(seg.offsetSec)}`;
  $("p-sub").textContent = `${guildLabel(D.session)}${channelLabel(D.session) ? ` · ${channelLabel(D.session)}` : ""} · ${timeSecFmt.format(new Date(seg.startedAt))} · ${fmtLen(seg.durationSec)}`;
  const dl = $("p-dl");
  dl.href = audioUrl(D.session, seg, true);
  dl.hidden = false;
  markCurrent();
  setPlayerOffset();
}

function step(dir) {
  const list = visibleSegs();
  if (!list.length) return;
  const i = D.current ? list.findIndex((s) => s.file === D.current.file) : -1;
  const next = list[i === -1 ? (dir > 0 ? 0 : list.length - 1) : i + dir];
  if (next) play(next);
}

// Play whatever is being said at second `t` of the recording (or the next speech after it).
function playAt(t) {
  const list = visibleSegs();
  const seg = list.find((s) => s.offsetSec + (s.durationSec ?? 1) > t);
  if (seg) play(seg, Math.max(0, t - seg.offsetSec));
}

audio.addEventListener("ended", () => {
  if ($("p-auto").checked) step(1);
});
audio.addEventListener("error", () => {
  if (D.current) $("p-sub").textContent = "This browser could not play the segment (Ogg Opus needs a current Chrome, Edge or Firefox). You can still download it.";
});
audio.addEventListener("timeupdate", () => {
  const head = $("timeline").querySelector(".tl-head");
  if (!head || !D.current) return;
  const x = (D.current.offsetSec + audio.currentTime) * D.pps;
  head.style.left = `${x}px`;
  head.style.display = "block";
  const tl = $("timeline");
  if (!audio.paused && (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40)) tl.scrollLeft = Math.max(0, x - tl.clientWidth / 3);
});
$("p-speed").addEventListener("change", () => (audio.defaultPlaybackRate = audio.playbackRate = Number($("p-speed").value)));
$("p-prev").addEventListener("click", () => step(-1));
$("p-next").addEventListener("click", () => step(1));
window.addEventListener("resize", () => {
  setPlayerOffset();
  if (!$("detail-view").hidden) renderTimeline();
});

function buildSegs(data) {
  const segs = data.tracks.map((t, i) => ({
    ...t,
    key: t.userId || (t.username ? `name:${t.username}` : "unknown"),
    no: i + 1,
  }));
  return segs;
}

function renderSpeakers() {
  const box = $("d-speakers");
  box.querySelectorAll(".spk").forEach((n) => n.remove());
  const counts = new Map();
  for (const s of D.segs) counts.set(s.key, (counts.get(s.key) || 0) + 1);
  const order = [];
  for (const sp of D.session.speakers) order.push({ key: speakerKey(sp), label: speakerLabel(sp), id: sp.id });
  for (const s of D.segs) if (!order.some((o) => o.key === s.key)) order.push({ key: s.key, label: s.username || s.userId || "Unknown speaker", id: s.userId });
  D.order = order;
  for (const o of order) {
    const btn = el("button", {
      class: "spk", type: "button", hue: hueOf(o.key), "aria-pressed": String(!D.hidden.has(o.key)),
      title: o.id ? `User ID ${o.id}` : null,
    }, el("i"), el("span", { text: o.label }), el("small", { text: String(counts.get(o.key) || 0) }));
    btn.addEventListener("click", () => {
      if (D.hidden.has(o.key)) D.hidden.delete(o.key);
      else D.hidden.add(o.key);
      btn.setAttribute("aria-pressed", String(!D.hidden.has(o.key)));
      renderTimeline();
      renderTable();
    });
    box.append(btn);
  }
}

function zoomToPps() {
  const tl = $("timeline");
  const fit = Math.max(0.02, (tl.clientWidth - 24) / D.total);
  const max = Math.max(fit, MAX_PPS);
  const v = Number($("zoom").value) / 100;
  return fit * Math.pow(max / fit, v);
}

function renderTimeline() {
  const tl = $("timeline");
  tl.replaceChildren();
  const lanes = (D.order || []).filter((o) => !D.hidden.has(o.key));
  D.pps = zoomToPps();
  const width = Math.ceil(D.total * D.pps) + 16;

  const inner = el("div", { class: "tl-inner" });
  inner.style.width = `${width}px`;

  const axis = el("div", { class: "tl-axis", title: "Click to play from this moment" });
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const stepSec = steps.find((s) => s * D.pps >= 72) || steps[steps.length - 1];
  for (let t = 0; t <= D.total; t += stepSec) {
    const tick = el("span", { class: "tl-tick", text: fmtClock(t) });
    tick.style.left = `${t * D.pps}px`;
    axis.append(tick);
  }
  axis.addEventListener("click", (e) => playAt((e.clientX - axis.getBoundingClientRect().left) / D.pps));
  inner.append(axis);

  for (const lane of lanes) {
    const row = el("div", { class: "tl-lane" }, el("span", { class: "tl-lane-label", text: lane.label }));
    for (const seg of D.segs.filter((s) => s.key === lane.key)) {
      const len = seg.durationSec ?? 0.5;
      const b = el("button", {
        class: "tl-seg", type: "button", hue: hueOf(seg.key), "data-file": seg.file,
        "aria-label": `${lane.label}, starts at ${fmtClock(seg.offsetSec)}, ${fmtLen(seg.durationSec)}. Play`,
        title: `${lane.label} · ${fmtClock(seg.offsetSec)} · ${fmtLen(seg.durationSec)}`,
        on: { click: () => play(seg) },
      });
      b.style.left = `${seg.offsetSec * D.pps}px`;
      b.style.width = `${Math.max(5, len * D.pps)}px`;
      row.append(b);
    }
    inner.append(row);
  }
  inner.append(el("div", { class: "tl-head" }));
  tl.append(inner);
  $("d-note").hidden = !!lanes.length;
  $("d-note").textContent = lanes.length ? "" : "All speakers are hidden. Click a speaker above to show them again.";
  markCurrent();
}

function renderTable() {
  const body = $("seg-body");
  body.replaceChildren();
  let shown = 0;
  for (const seg of D.segs) {
    if (D.hidden.has(seg.key)) continue;
    shown++;
    const who = el("td", { class: "who", hue: hueOf(seg.key) }, el("i"), segLabel(seg));
    if (seg.userId && seg.username) who.append(" ", el("span", { class: "id", text: seg.userId }));
    const act = el("td", { class: "act" },
      el("button", { class: "btn small", type: "button", text: "Play", "aria-label": `Play segment ${seg.no} by ${segLabel(seg)}`, on: { click: () => play(seg) } }),
      " ",
      el("a", { class: "btn small", href: audioUrl(D.session, seg, true), download: true, "aria-label": `Download segment ${seg.no}` }, el("span", { class: "full", text: "Download" }), el("span", { class: "short", "aria-hidden": "true", text: "↓" })),
    );
    body.append(el("tr", { "data-file": seg.file },
      el("td", { text: String(seg.no) }), who,
      el("td", { text: fmtClock(seg.offsetSec) }),
      el("td", { text: timeSecFmt.format(new Date(seg.startedAt)) }),
      el("td", { text: fmtLen(seg.durationSec) }),
      el("td", { text: fmtBytes(seg.bytes) }),
      act,
    ));
  }
  $("seg-empty").hidden = D.segs.length > 0;
  $("seg-empty").textContent = D.segs.length ? "" : "No speech was captured in this recording.";
  markCurrent();
}

function renderDetail(data) {
  const s = data.session;
  D.session = s;
  D.segs = buildSegs(data);
  D.total = Math.max(1, s.durationSec ?? 0, ...D.segs.map((g) => g.offsetSec + (g.durationSec ?? 1)));

  const started = new Date(s.startedAt);
  const ended = s.endedAt ? new Date(s.endedAt) : null;
  document.title = `${guildLabel(s)} · Recording`;
  $("d-title").textContent = guildLabel(s);
  $("d-sub").textContent = `${channelLabel(s) ? `${s.channelName ? "#" : ""}${channelLabel(s)} · ` : ""}${dayFmt.format(started)}, ${timeFmt.format(started)}${ended ? ` – ${timeFmt.format(ended)}` : ""}`;

  const meta = $("d-meta");
  meta.replaceChildren(
    `${fmtDur(s.durationSec)} · ${nf.format(s.segments)} ${s.segments === 1 ? "segment" : "segments"} · ${fmtBytes(s.bytes)}`,
  );
  const badge = statusBadge(s.status);
  if (badge) meta.append(" · ", badge);
  if (s.initiatedBy) meta.append(` · started by ${s.initiatedBy.name || s.initiatedBy.id}`);
  meta.append(el("br"), "Session ", el("code", { text: s.id }), " · Server ID ", el("code", { text: s.guildId }));
  if (s.channelId) meta.append(" · Channel ID ", el("code", { text: s.channelId }));

  renderSpeakers();
  renderTimeline();
  renderTable();

  clearTimeout(D.pollTimer);
  if (s.status === "active") D.pollTimer = setTimeout(refreshDetail, DETAIL_POLL_MS);
}

async function refreshDetail() {
  if (!D.session || $("detail-view").hidden) return;
  try {
    renderDetail(await api(`/api/recordings/session?guild=${encodeURIComponent(D.session.guildId)}&id=${encodeURIComponent(D.session.id)}`));
  } catch {
    D.pollTimer = setTimeout(refreshDetail, DETAIL_POLL_MS * 3);
  }
}

async function showDetail(guildId, id) {
  $("list-view").hidden = true;
  $("detail-view").hidden = false;
  $("d-title").textContent = "Loading…";
  for (const n of ["d-sub", "d-meta"]) $(n).textContent = "";
  $("seg-body").replaceChildren();
  $("timeline").replaceChildren();
  D.hidden = new Set();
  $("to-list").href = listHash;
  window.scrollTo(0, 0);
  try {
    const data = await api(`/api/recordings/session?guild=${encodeURIComponent(guildId)}&id=${encodeURIComponent(id)}`);
    showError(null);
    renderDetail(data);
    $("main").focus({ preventScroll: true });
  } catch (err) {
    $("d-title").textContent = err.status === 404 ? "Recording not found" : "Could not load this recording";
    showError(err);
  }
}

$("zoom").addEventListener("input", () => {
  cancelAnimationFrame(D.zoomFrame);
  D.zoomFrame = requestAnimationFrame(renderTimeline);
});

// =====================================================================================
// ROUTING
// =====================================================================================

let listScroll = 0;
function route() {
  const hash = location.hash || "#/";
  const m = /^#\/r\/(\d{15,25})\/([^/?]+)$/.exec(hash);
  clearTimeout(D.pollTimer);
  if (m) {
    if (!$("list-view").hidden) listScroll = window.scrollY;
    showDetail(m[1], decodeURIComponent(m[2]));
    return;
  }
  // list view
  $("detail-view").hidden = true;
  $("list-view").hidden = false;
  document.title = "Recordings";
  showError(null);
  listHash = hash;
  const qs = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  hashToFilters(qs);
  if (state.loaded) {
    renderList();
    window.scrollTo(0, listScroll);
  }
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("list-view").hidden) loadList(false);
});
setInterval(() => {
  if (document.visibilityState === "visible" && !$("list-view").hidden) loadList(false);
}, LIST_POLL_MS);

route();
loadList(true).then(() => {
  // a deep link to a filtered view applies once the selects have their options
  if (!$("list-view").hidden) {
    const qs = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?") + 1) : "";
    hashToFilters(qs);
    renderList();
  }
});
