"use strict";

/* ===================================================================
   Soundboard + voice watcher dashboard
   Plain JS, no build step. CSP-safe: no inline script/style, no
   external resources. Uses only the existing backend endpoints:
     GET  /events                 (SSE snapshot: ready, total, guilds, playback)
     GET  /api/status             ({ playback })
     GET  /api/sounds             ({ sounds: [{ name, count, tags }] })
     POST /api/play               ({ sound, guildId, channelId })
     POST /api/queue/skip         ({ guildId })
     POST /api/queue/remove       ({ guildId, id })
     POST /api/queue/clear-pending({ guildId })
   =================================================================== */

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";

const TABS = ["sounds", "favorites", "recent", "queue", "voice"];
const SOUND_TABS = new Set(["sounds", "favorites", "recent"]);
const TAB_ALIASES = { voices: "voice", sound: "sounds", favorite: "favorites", queues: "queue" };

// Turns "#voice", "#Voices", "#/voices" or "voices" into a real tab name, or "" if it is not one.
function normalizeTab(raw) {
  let t = String(raw ?? "");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep the raw text */
  }
  t = t.replace(/^[#/\s]+/, "").replace(/[/\s]+$/, "").toLowerCase();
  t = TAB_ALIASES[t] ?? t;
  return TABS.includes(t) ? t : "";
}

// Tab requested by the link: #voice first, then ?tab=voice.
const tabFromUrl = () => normalizeTab(location.hash) || normalizeTab(new URLSearchParams(location.search).get("tab"));
const MAX_RECENT = 30;
const TAG_LIMIT = 12;

// Authentication is the session cookie, sent by the browser itself. No key is put in the page or a header.
// A ?key=... in the address bar is deliberately left alone, so a refresh or a webview reload still has it.
const authHeaders = {};

/* ---------- localStorage (falls back to memory if unavailable) ---------- */

const K = {
  fav: "soundbot.favorites.v1",
  recent: "soundbot.recent.v1",
  target: "soundbot.target.v1",
  sort: "soundbot.sort.v1",
  scale: "soundbot.uiscale.v1",
};

const mem = new Map();
const store = {
  read(k, fallback) {
    try {
      const raw = localStorage.getItem(k);
      if (raw !== null) return JSON.parse(raw);
    } catch {
      /* storage blocked or corrupt: use memory */
    }
    return mem.has(k) ? mem.get(k) : fallback;
  },
  write(k, value) {
    mem.set(k, value);
    try {
      localStorage.setItem(k, JSON.stringify(value));
    } catch {
      /* quota or blocked: memory copy still works this session */
    }
  },
};

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function validTarget(v) {
  return v && typeof v.guildId === "string" && typeof v.channelId === "string"
    ? {
        guildId: v.guildId,
        channelId: v.channelId,
        guildName: typeof v.guildName === "string" ? v.guildName : "",
        channelName: typeof v.channelName === "string" ? v.channelName : "",
      }
    : null;
}

/* ---------- state ---------- */

const state = {
  conn: "connecting", // connecting | open | down
  gotSnapshot: false,
  ready: false,
  guilds: [],
  total: null,
  playback: [],

  sounds: [],
  tags: [],
  soundsState: "loading", // loading | ok | error
  soundsError: "",
  soundsSig: "",
  soundsLoadedAt: 0,

  favorites: new Set(strings(store.read(K.fav, []))),
  recent: strings(store.read(K.recent, [])),
  preferred: validTarget(store.read(K.target, null)),

  tab: "sounds",
  query: "",
  tag: "",
  tagsExpanded: false,
  sort: store.read(K.sort, "name") === "count" ? "count" : "name",

  inflight: new Set(),
  focusAfter: null,
};

// id -> display name, learned from snapshots (the queue API only returns ids)
const names = { guilds: new Map(), channels: new Map() };

/* ---------- small DOM helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, dataset = {}) {
  const node = el("button", className, text);
  node.type = "button";
  for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  return node;
}

function icon(d) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const STAR = "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z";

function bars() {
  const b = el("span", "bars");
  b.setAttribute("aria-hidden", "true");
  b.append(el("i"), el("i"), el("i"));
  return b;
}

function empty(title, detail, action) {
  const box = el("div", "empty");
  box.append(el("strong", "", title));
  if (detail) box.append(el("span", "", detail));
  if (action) box.append(button("btn", action.label, { act: action.act }));
  return box;
}

const fold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

function hueOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function findKey(container, k) {
  for (const n of container.querySelectorAll("[data-focus-key]")) {
    if (n.dataset.focusKey === k) return n;
  }
  return null;
}

/** Re-render a container without dropping keyboard focus. */
function withFocus(container, render, fallback) {
  const a = document.activeElement;
  const had = Boolean(a && a !== document.body && container.contains(a));
  const k = had ? a.dataset.focusKey || "" : "";

  render();

  let node = null;
  if (state.focusAfter) {
    node = findKey(container, state.focusAfter);
    if (node) state.focusAfter = null;
  }
  if (!node && k) node = findKey(container, k);

  if (node) node.focus({ preventScroll: true });
  else if (had && fallback) fallback.focus({ preventScroll: true });
}

/* ---------- toasts + screen-reader announcements ---------- */

const announcer = el("div", "visually-hidden");
announcer.setAttribute("role", "status");
announcer.setAttribute("aria-live", "polite");
document.body.append(announcer);

function announce(text) {
  announcer.textContent = "";
  setTimeout(() => { announcer.textContent = text; }, 30);
}

function toast(message, isError = false) {
  const host = $(isError ? "toasts-error" : "toasts");

  for (const t of host.children) {
    if (t.textContent === message) t.remove();
  }
  while (host.children.length >= 3) host.firstElementChild.remove();

  const node = el("div", isError ? "toast error" : "toast", message);
  host.append(node);
  setTimeout(() => node.remove(), isError ? 6500 : 3200);
}

/* ---------- API ---------- */

const REASONS = {
  "queue-full": "Queue is full",
  duplicate: "Already queued in this channel",
  "unknown-sound": "That sound no longer exists",
  "shutting-down": "The bot is shutting down",
};

async function postJson(path, payload) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the server");
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      body.error ||
        REASONS[body.reason] ||
        (res.status === 401
          ? "Your session has expired. Reload the page to sign in again."
          : `Request failed (${res.status})`),
    );
  }

  return body;
}

function normalizePlayback(pb) {
  if (Array.isArray(pb)) return pb;
  if (Array.isArray(pb?.playing)) return pb.playing;
  return [];
}

const guildIdOf = (entry) => entry?.guildId ?? entry?.guild?.id ?? entry?.id ?? "";

async function refreshPlayback() {
  const res = await fetch("/api/status", {
    headers: authHeaders,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Could not refresh queue (${res.status})`);

  const data = await res.json();
  state.playback = normalizePlayback(data.playback);
  renderPlayback();
}

/* ---------- target (server + voice channel) ---------- */

const memberCount = (c) => (Array.isArray(c.members) ? c.members.length : 0);
const guildMembers = (g) => g.channels.reduce((n, c) => n + memberCount(c), 0);
const liveGuilds = () => state.guilds.filter((g) => Array.isArray(g.channels) && g.channels.length);
const bestChannel = (g) => [...g.channels].sort((a, b) => memberCount(b) - memberCount(a))[0];

function activeTarget() {
  const guilds = liveGuilds();
  if (!guilds.length) return null;

  const p = state.preferred;
  let g = p ? guilds.find((x) => x.id === p.guildId) : null;
  let c = g ? g.channels.find((x) => x.id === p.channelId) : null;

  if (!c) {
    g = g || [...guilds].sort((a, b) => guildMembers(b) - guildMembers(a))[0];
    c = bestChannel(g);
  }

  return { guildId: g.id, guildName: g.name, channelId: c.id, channelName: c.name };
}

function setPreferred(guildId, channelId) {
  const g = state.guilds.find((x) => x.id === guildId);
  const c = g?.channels.find((x) => x.id === channelId);
  if (!g || !c) return;

  state.preferred = { guildId, channelId, guildName: g.name, channelName: c.name };
  store.write(K.target, state.preferred);
  renderTarget();
  renderVoice();
  updateCardStates();
  renderNow();
}

function syncSelect(select, items, value, placeholder) {
  if (!items.length) {
    select.replaceChildren(new Option(placeholder, ""));
    select.disabled = true;
    updateCustomSelect(select);
    return;
  }

  const same =
    select.options.length === items.length &&
    items.every((it, i) => select.options[i].value === it.value);

  if (same) {
    items.forEach((it, i) => {
      if (select.options[i].textContent !== it.label) select.options[i].textContent = it.label;
    });
  } else {
    select.replaceChildren(...items.map((it) => new Option(it.label, it.value)));
  }

  select.value = value;
  select.disabled = false;
  updateCustomSelect(select);
}

/* ---------- in-page custom dropdowns ---------- */

const customSelectState = new WeakMap();

function customSelectLabel(select) {
  const field = select.closest(".field, .sort");
  const label = field?.querySelector(".field-label");
  if (label) {
    if (!label.id) label.id = `${select.id}-label`;
    return label.id;
  }
  return "";
}

function installCustomSelect(select) {
  if (!select || customSelectState.has(select)) return;

  const oldLabel = select.closest("label");
  if (oldLabel) {
    const field = document.createElement("div");
    field.className = oldLabel.className;
    while (oldLabel.firstChild) field.append(oldLabel.firstChild);
    oldLabel.replaceWith(field);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";
  wrapper.dataset.customSelect = select.id;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const labelId = customSelectLabel(select);
  if (labelId) trigger.setAttribute("aria-labelledby", labelId);
  else trigger.setAttribute("aria-label", select.id.replaceAll("-", " "));

  const value = document.createElement("span");
  value.className = "custom-select-value";
  const chevron = document.createElement("span");
  chevron.className = "custom-select-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  trigger.append(value, chevron);

  const listbox = document.createElement("div");
  listbox.className = "custom-select-listbox";
  listbox.id = `${select.id}-options`;
  listbox.setAttribute("role", "listbox");
  listbox.hidden = true;
  trigger.setAttribute("aria-controls", listbox.id);

  select.classList.add("custom-select-source");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;
  select.replaceWith(wrapper);
  wrapper.append(select, trigger, listbox);

  const record = { wrapper, trigger, value, listbox, activeIndex: -1, signature: "" };
  customSelectState.set(select, record);

  function close({ restoreFocus = false } = {}) {
    wrapper.dataset.open = "false";
    listbox.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function setActive(index, focus = true) {
    const options = [...listbox.querySelectorAll('[role="option"]')];
    if (!options.length) return;
    record.activeIndex = Math.max(0, Math.min(index, options.length - 1));
    options.forEach((option, i) => {
      option.dataset.active = String(i === record.activeIndex);
      option.tabIndex = i === record.activeIndex ? 0 : -1;
    });
    if (focus) options[record.activeIndex].focus({ preventScroll: true });
    options[record.activeIndex].scrollIntoView({ block: "nearest" });
  }

  function open(preferLast = false) {
    if (select.disabled || !select.options.length) return;
    listbox.hidden = false;
    wrapper.dataset.open = "true";
    trigger.setAttribute("aria-expanded", "true");

    const rect = wrapper.getBoundingClientRect();
    const below = Math.max(0, window.innerHeight - rect.bottom - 12);
    const above = Math.max(0, rect.top - 12);
    const placeAbove = below < 150 && above > below;
    const available = placeAbove ? above : below;
    listbox.dataset.placement = placeAbove ? "top" : "bottom";
    listbox.style.maxHeight = `${Math.max(48, Math.min(240, available - 8))}px`;

    const options = [...listbox.querySelectorAll('[role="option"]')];
    const selected = options.findIndex((option) => option.dataset.value === select.value);
    setActive(preferLast ? options.length - 1 : Math.max(0, selected), true);
  }

  function choose(option) {
    if (!option || select.disabled) return;
    const nextValue = option.dataset.value;
    if (select.value !== nextValue) {
      select.value = nextValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      updateCustomSelect(select);
    }
    close({ restoreFocus: true });
  }

  trigger.addEventListener("click", () => {
    if (listbox.hidden) open();
    else close();
  });

  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      open(event.key === "ArrowUp");
    } else if (event.key === "Home") {
      event.preventDefault();
      open();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      open(true);
    }
  });

  listbox.addEventListener("click", (event) => {
    const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (option) choose(option);
  });

  listbox.addEventListener("keydown", (event) => {
    const options = [...listbox.querySelectorAll('[role="option"]')];
    const current = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    const index = Math.max(0, options.indexOf(current));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(options[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "Tab") {
      close();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!wrapper.contains(event.target)) close();
  });
  select.addEventListener("change", () => updateCustomSelect(select));
  updateCustomSelect(select);
}

function updateCustomSelect(select) {
  const record = customSelectState.get(select);
  if (!record) return;

  const options = [...select.options].map((option) => ({
    value: option.value,
    label: option.textContent || option.value,
    disabled: option.disabled,
  }));
  const signature = JSON.stringify(options);
  if (signature !== record.signature) {
    record.signature = signature;
    record.listbox.replaceChildren(...options.map((item) => {
      const option = document.createElement("div");
      option.className = "custom-select-option";
      option.setAttribute("role", "option");
      option.dataset.value = item.value;
      option.textContent = item.label;
      option.setAttribute("aria-selected", String(item.value === select.value));
      option.setAttribute("aria-disabled", String(item.disabled));
      option.tabIndex = -1;
      return option;
    }));
  }

  const selected = options.find((option) => option.value === select.value);
  record.value.textContent = selected?.label || options[0]?.label || "Select an option";
  record.trigger.disabled = select.disabled || options.length === 0;
  record.trigger.setAttribute("aria-disabled", String(record.trigger.disabled));
  for (const option of record.listbox.querySelectorAll('[role="option"]')) {
    option.setAttribute("aria-selected", String(option.dataset.value === select.value));
  }
  if (record.trigger.disabled) {
    record.listbox.hidden = true;
    record.wrapper.dataset.open = "false";
    record.trigger.setAttribute("aria-expanded", "false");
  }
}

function renderTarget() {
  const t = activeTarget();
  const guilds = liveGuilds();

  syncSelect(
    $("guild-select"),
    guilds.map((g) => ({ value: g.id, label: g.name })),
    t?.guildId ?? "",
    "No servers",
  );

  const g = t ? guilds.find((x) => x.id === t.guildId) : null;
  syncSelect(
    $("channel-select"),
    g ? g.channels.map((c) => ({ value: c.id, label: `${c.name} (${memberCount(c)})` })) : [],
    t?.channelId ?? "",
    "No channels",
  );

  const hint = $("target-hint");
  const p = state.preferred;

  if (!t) {
    hint.textContent = state.gotSnapshot
      ? "Nobody is in a voice channel, so there is nowhere to play. Sounds unlock when someone joins."
      : "";
    hint.className = "target-hint warn";
  } else if (p && p.channelId !== t.channelId) {
    const was = p.channelName ? `“${p.channelName}”` : "Your last channel";
    hint.textContent = `${was} is not in voice right now. Playing in “${t.channelName}” instead.`;
    hint.className = "target-hint warn";
  } else {
    hint.textContent = "";
    hint.className = "target-hint";
  }
}

$("guild-select").addEventListener("change", (e) => {
  const g = liveGuilds().find((x) => x.id === e.target.value);
  if (g) setPreferred(g.id, bestChannel(g).id);
});

$("channel-select").addEventListener("change", (e) => {
  const t = activeTarget();
  if (t && e.target.value) setPreferred(t.guildId, e.target.value);
});

/* ---------- sounds: data, filtering, grid ---------- */

function prepareSounds(raw) {
  return raw
    .filter((s) => s && typeof s.name === "string" && s.name)
    .map((s) => {
      const seen = new Set();
      const tags = [];
      for (const t of Array.isArray(s.tags) ? s.tags : []) {
        if (typeof t !== "string") continue;
        const label = t.trim();
        const k = fold(label);
        if (!label || seen.has(k)) continue;
        seen.add(k);
        tags.push({ key: k, label });
      }
      return {
        name: s.name,
        count: Number(s.count) || 0,
        tags,
        hue: hueOf(s.name),
        haystack: fold(`${s.name} ${tags.map((t) => t.label).join(" ")}`),
      };
    });
}

function collectTags(sounds) {
  const map = new Map();
  for (const s of sounds) {
    for (const t of s.tags) {
      const cur = map.get(t.key);
      if (cur) cur.count++;
      else map.set(t.key, { key: t.key, label: t.label, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function baseList(kind) {
  if (kind === "favorites") return state.sounds.filter((s) => state.favorites.has(s.name));
  if (kind === "recent") {
    const index = new Map(state.sounds.map((s) => [s.name, s]));
    return state.recent.map((n) => index.get(n)).filter(Boolean);
  }
  return state.sounds;
}

function isFiltered() {
  return Boolean(state.query.trim() || state.tag);
}

function filterSort(kind, list) {
  const terms = fold(state.query).split(/\s+/).filter(Boolean);

  let out = list.filter(
    (s) =>
      (!state.tag || s.tags.some((t) => t.key === state.tag)) &&
      terms.every((term) => s.haystack.includes(term)),
  );

  if (kind !== "recent") {
    out = [...out].sort(
      state.sort === "count" ? (a, b) => b.count - a.count || byName(a, b) : byName,
    );
  }
  return out;
}

function makeCard(s) {
  const card = el("div", "card");
  card.dataset.sound = s.name;
  card.style.setProperty("--hue", String(s.hue));
  if (s.tags.length) card.title = s.tags.map((t) => t.label).join(", ");
  if (state.inflight.has(s.name)) card.setAttribute("aria-busy", "true");

  const play = button("card-play", "", { act: "play" });
  const name = el("span", "card-name", s.name);
  name.dir = "auto";

  const meta = el("span", "card-meta");
  if (s.tags[0]) meta.append(el("span", "card-tag", s.tags[0].label));
  if (s.count) meta.append(el("span", "card-count", `${s.count}×`));

  const status = el("span", "card-status");
  status.append(bars(), el("span", "st-text"));
  meta.append(status);

  play.append(name, meta);

  const fav = button("card-fav", "", { act: "fav" });
  fav.append(icon(STAR));
  const on = state.favorites.has(s.name);
  fav.setAttribute("aria-pressed", String(on));
  fav.setAttribute("aria-label", `Favorite ${s.name}`);
  fav.title = on ? "Remove from favorites" : "Add to favorites";

  card.append(play, fav);
  return card;
}

function captureGridFocus(grid) {
  const a = document.activeElement;
  const card = a instanceof Element ? a.closest(".card") : null;
  if (!card || !grid.contains(card)) return null;
  return {
    name: card.dataset.sound,
    act: a.dataset.act,
    index: [...grid.children].indexOf(card),
  };
}

function restoreGridFocus(grid, prev, panel) {
  if (!prev) return;
  const cards = [...grid.querySelectorAll(".card")];
  const card =
    cards.find((c) => c.dataset.sound === prev.name) ||
    cards[Math.min(prev.index, cards.length - 1)];
  const target = card?.querySelector(`[data-act="${prev.act}"]`) || panel;
  target.focus({ preventScroll: true });
}

function emptyFor(kind, baseCount) {
  if (state.soundsState === "ok" && !state.sounds.length) {
    return empty("No sounds found", "Add sound files to the library, then reload this page.");
  }
  if (isFiltered() && baseCount) {
    return empty("No sounds match", "Try a different search or tag.", {
      label: "Clear filters",
      act: "clear-filters",
    });
  }
  if (kind === "favorites") {
    return empty("No favorites yet", "Select the star on any sound to pin it here.");
  }
  return empty("Nothing played yet", "Sounds you play from this browser show up here.");
}

function renderSoundViews() {
  const kind = state.tab;
  if (!SOUND_TABS.has(kind)) return;

  const grid = $(`grid-${kind}`);
  const results = $(`results-${kind}`);
  const panel = $(`panel-${kind}`);
  const prev = captureGridFocus(grid);
  const frag = document.createDocumentFragment();

  grid.removeAttribute("aria-busy");

  if (state.soundsState === "loading") {
    grid.setAttribute("aria-busy", "true");
    results.textContent = "";
    frag.append(empty("Loading sounds…"));
  } else if (state.soundsState === "error") {
    results.textContent = "";
    frag.append(empty("Could not load sounds", state.soundsError, { label: "Try again", act: "retry" }));
  } else {
    const base = baseList(kind);
    const list = filterSort(kind, base);
    const word = (n) => `${n} sound${n === 1 ? "" : "s"}`;

    results.textContent = isFiltered()
      ? `${list.length} of ${word(base.length)}`
      : kind === "recent" && base.length
        ? `${word(base.length)}, most recent first`
        : word(base.length);

    if (!list.length) frag.append(emptyFor(kind, base.length));
    else for (const s of list) frag.append(makeCard(s));
  }

  grid.replaceChildren(frag);
  restoreGridFocus(grid, prev, panel);
  updateCardStates();
}

function updateCardStates() {
  const t = activeTarget();
  const entry = t ? state.playback.find((e) => guildIdOf(e) === t.guildId) : null;
  const playing = entry?.current?.sound ?? null;
  const queued = new Set(
    (Array.isArray(entry?.items) ? entry.items : [])
      .filter((i) => i.channelId === t.channelId)
      .map((i) => i.sound),
  );

  for (const card of document.querySelectorAll(".card[data-sound]")) {
    const name = card.dataset.sound;
    const st = name === playing ? "playing" : queued.has(name) ? "queued" : "";
    const play = card.querySelector(".card-play");

    if ((card.dataset.state || "") !== st) {
      if (st) card.dataset.state = st;
      else delete card.dataset.state;
      card.querySelector(".st-text").textContent =
        st === "playing" ? "Playing" : st === "queued" ? "Queued" : "";
    }

    const label =
      `Play ${name}` +
      (st === "playing" ? ", playing now" : st === "queued" ? ", already queued" : "") +
      (t ? "" : ", no voice channel available");

    if (play.getAttribute("aria-label") !== label) play.setAttribute("aria-label", label);
    play.setAttribute("aria-disabled", String(!t));
  }
}

function renderTagChips() {
  const box = $("tag-filters");

  if (!state.tags.length) {
    box.hidden = true;
    return;
  }

  box.hidden = false;

  withFocus(box, () => {
    let shown = state.tagsExpanded ? state.tags : state.tags.slice(0, TAG_LIMIT);
    const selected = state.tags.find((t) => t.key === state.tag);
    if (selected && !shown.includes(selected)) shown = [...shown, selected];

    const chip = (label, dataset, pressed, k) => {
      const b = button("chip", label, { act: "tag", ...dataset, focusKey: k });
      b.setAttribute("aria-pressed", String(pressed));
      return b;
    };

    const nodes = [chip("All", { tag: "" }, !state.tag, "tag:")];
    for (const t of shown) nodes.push(chip(t.label, { tag: t.key }, state.tag === t.key, `tag:${t.key}`));

    if (state.tags.length > TAG_LIMIT) {
      const more = button(
        "chip chip-more",
        state.tagsExpanded ? "Fewer tags" : `All ${state.tags.length} tags`,
        { act: "more-tags", focusKey: "more-tags" },
      );
      more.setAttribute("aria-expanded", String(state.tagsExpanded));
      nodes.push(more);
    }

    box.replaceChildren(...nodes);
  });
}

async function loadSounds(quiet = false) {
  if (!quiet) {
    state.soundsState = "loading";
    renderSoundViews();
  }

  try {
    const res = await fetch("/api/sounds", {
      headers: authHeaders,
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(
        res.status === 401 ? "Your session has expired. Reload the page to sign in again." : `Server returned ${res.status}.`,
      );
    }

    const data = await res.json();
    const sounds = prepareSounds(Array.isArray(data.sounds) ? data.sounds : []);
    const sig = JSON.stringify(sounds.map((s) => [s.name, s.count, s.tags.map((t) => t.label)]));

    state.soundsLoadedAt = Date.now();
    if (quiet && state.soundsState === "ok" && sig === state.soundsSig) return;

    state.sounds = sounds;
    state.soundsSig = sig;
    state.tags = collectTags(sounds);
    if (state.tag && !state.tags.some((t) => t.key === state.tag)) state.tag = "";
    state.soundsState = "ok";
  } catch (err) {
    console.error("Failed to load sounds:", err);
    if (quiet && state.soundsState === "ok") return;
    state.soundsState = "error";
    state.soundsError = err.message || "Network error.";
  }

  renderTagChips();
  renderSoundViews();
  renderBadges();
}

function toggleFavorite(name) {
  const added = !state.favorites.has(name);
  if (added) state.favorites.add(name);
  else state.favorites.delete(name);

  store.write(K.fav, [...state.favorites]);
  announce(`${name} ${added ? "added to" : "removed from"} favorites`);
  afterFavoritesChanged();
}

function afterFavoritesChanged() {
  if (state.tab === "favorites") {
    renderSoundViews();
  } else {
    for (const card of document.querySelectorAll(".card[data-sound]")) {
      const on = state.favorites.has(card.dataset.sound);
      const fav = card.querySelector(".card-fav");
      fav.setAttribute("aria-pressed", String(on));
      fav.title = on ? "Remove from favorites" : "Add to favorites";
    }
  }
  renderBadges();
}

function rememberRecent(name) {
  state.recent = [name, ...state.recent.filter((n) => n !== name)].slice(0, MAX_RECENT);
  store.write(K.recent, state.recent);
  if (state.tab === "recent") renderSoundViews();
  renderBadges();
}

$("clear-recent").addEventListener("click", () => {
  state.recent = [];
  store.write(K.recent, []);
  renderSoundViews();
  renderBadges();
  announce("Recently played cleared");
});

function setBusy(name, on) {
  for (const card of document.querySelectorAll(".card[data-sound]")) {
    if (card.dataset.sound !== name) continue;
    if (on) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
  }
}

async function playSound(name) {
  const t = activeTarget();

  if (!t) {
    toast("Nobody is in a voice channel, so there is nowhere to play.", true);
    return;
  }

  if (state.inflight.has(name)) return;
  state.inflight.add(name);
  setBusy(name, true);

  try {
    const r = await postJson("/api/play", {
      sound: name,
      guildId: t.guildId,
      channelId: t.channelId,
    });

    rememberRecent(name);

    const pos = Number(r.position) || 1;
    toast(
      pos <= 1
        ? `Playing “${name}” in ${t.channelName}`
        : `Queued “${name}” (#${pos}) for ${t.channelName}`,
    );

    refreshPlayback().catch((err) => console.warn(err));
  } catch (err) {
    toast(`${name}: ${err.message}`, true);
  } finally {
    state.inflight.delete(name);
    setBusy(name, false);
  }
}

const guildLabel = (id) => names.guilds.get(id) || `Server …${String(id).slice(-4)}`;
const channelLabel = (id) => names.channels.get(id) || "voice channel";
const pendingOf = (e) => (Array.isArray(e.items) ? e.items : []);
const queuedOf = (e) => Number(e.queued) || pendingOf(e).length;
const hasWork = (e) => Boolean(e.current) || queuedOf(e) > 0;

function renderQueue() {
  const root = $("queue-root");

  withFocus(
    root,
    () => {
      root.replaceChildren();
      const entries = state.playback.filter(hasWork);

      if (!entries.length) {
        root.append(empty("Nothing is playing or queued", "Select a sound to add it here."));
        return;
      }

      for (const entry of entries) {
        const guildId = guildIdOf(entry);
        const current = entry.current || null;
        const items = pendingOf(entry);
        const queued = queuedOf(entry);
        const gname = entry.guildName || entry.name || guildLabel(guildId);

        const group = el("section", "q-guild");
        group.setAttribute("aria-label", gname);
        group.append(el("h3", "", gname));

        if (current) {
          const row = el("div", "q-current");
          row.append(bars(), el("span", "q-label", "Now playing"));

          const info = el("span", "q-sound");
          info.append(el("span", "", current.sound || "Unknown sound"));
          if (current.channelId) info.append(el("span", "q-sub", `in ${channelLabel(current.channelId)}`));
          row.append(info);

          const skip = button("btn small", "Skip current", {
            act: "skip",
            guild: guildId,
            focusKey: `skip:${guildId}`,
          });
          skip.setAttribute("aria-label", `Skip ${current.sound || "current sound"}`);
          skip.disabled = !guildId;
          row.append(skip);
          group.append(row);
        }

        if (items.length) {
          const list = el("ol", "q-list");
          list.setAttribute("aria-label", `Pending sounds in ${gname}`);

          for (const item of items) {
            const row = el("li", "q-item");
            const info = el("span", "q-sound");
            info.append(el("span", "", item.sound || "Unknown sound"));
            if (item.channelId) info.append(el("span", "q-sub", `in ${channelLabel(item.channelId)}`));
            row.append(info);

            const remove = button("btn small danger", "Remove", {
              act: "remove",
              guild: guildId,
              queueId: item.id || "",
              focusKey: `remove:${guildId}:${item.id || ""}`,
            });
            remove.setAttribute("aria-label", `Remove ${item.sound || "sound"} from the queue`);
            remove.disabled = !guildId || !item.id;
            remove.title = item.id ? "Remove this queued sound" : "Queue item has no ID";
            row.append(remove);
            list.append(row);
          }

          group.append(list);
        } else if (queued > 0) {
          group.append(el("p", "results", `${queued} queued sound(s), but item details are unavailable.`));
        }

        if (queued > 0) {
          const actions = el("div", "q-actions");
          const clear = button("btn small danger", `Clear pending (${queued})`, {
            act: "clear-pending",
            guild: guildId,
            focusKey: `clear:${guildId}`,
          });
          clear.disabled = !guildId;
          actions.append(clear);
          group.append(actions);
        }

        root.append(group);
      }
    },
    $("panel-queue"),
  );
}

async function runQueueAction(action, guildId, id, btn) {
  if (!guildId) {
    toast("Could not identify the server.", true);
    return;
  }

  const original = btn?.textContent;
  if (btn) {
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = "Working…";
  }

  if (action === "remove" && btn) {
    const item = btn.closest(".q-item");
    const sibling = item?.nextElementSibling || item?.previousElementSibling;
    state.focusAfter = sibling?.querySelector("button")?.dataset.focusKey || `clear:${guildId}`;
  }

  try {
    if (action === "remove") await postJson("/api/queue/remove", { guildId, id });
    else if (action === "skip") await postJson("/api/queue/skip", { guildId });
    else if (action === "clear-pending") await postJson("/api/queue/clear-pending", { guildId });
    else throw new Error("Unknown queue action.");

    const msg =
      action === "remove"
        ? "Queued sound removed."
        : action === "skip"
          ? "Skipped current sound."
          : "Pending queue cleared.";
    toast(msg);
    announce(msg);

    await refreshPlayback();
  } catch (err) {
    state.focusAfter = null;
    toast(err.message, true);

    if (btn) {
      btn.removeAttribute("aria-disabled");
      btn.textContent = original;
    }
  }
}

$("now-skip").addEventListener("click", (e) => {
  const b = e.currentTarget;
  if (b.getAttribute("aria-disabled") === "true") return;
  runQueueAction("skip", b.dataset.guild, null, b);
});

function renderNow() {
  const bar = $("now");
  const playing = state.playback.filter((e) => e.current);
  const queued = state.playback.reduce((n, e) => n + queuedOf(e), 0);

  if (!playing.length && !queued) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;

  const sounds = playing.map((e) => e.current.sound);
  $("now-text").textContent = sounds.length
    ? `Playing: ${sounds.join(", ")}${queued ? ` (+${queued} queued)` : ""}`
    : `${queued} sound${queued === 1 ? "" : "s"} queued`;

  const t = activeTarget();
  const entry = playing.find((e) => guildIdOf(e) === t?.guildId) || playing[0];
  const skip = $("now-skip");

  skip.hidden = !entry;
  if (entry) skip.dataset.guild = guildIdOf(entry);
  skip.removeAttribute("aria-disabled");
  skip.textContent = "Skip";
}

function memberRow(m) {
  const li = el("li");

  if (m.avatar) {
    const img = el("img", "avatar");
    img.src = m.avatar;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(el("span", "avatar initial", (m.name || "?").slice(0, 1).toUpperCase()));
    });
    li.append(img);
  } else {
    li.append(el("span", "avatar initial", (m.name || "?").slice(0, 1).toUpperCase()));
  }

  const name = el("span", "m-name", m.name || "Unknown member");
  name.dir = "auto";
  li.append(name);

  const tags = el("span", "m-tags");
  if (m.bot) tags.append(el("span", "tag", "bot"));
  if (m.streaming) tags.append(el("span", "tag live", "streaming"));
  if (m.camera) tags.append(el("span", "tag live", "camera"));
  if (m.deafened) tags.append(el("span", "tag", "deafened"));
  else if (m.muted) tags.append(el("span", "tag", "muted"));
  if (tags.children.length) li.append(tags);

  return li;
}

function renderVoice() {
  const root = $("voice-root");
  const t = activeTarget();

  withFocus(
    root,
    () => {
      root.replaceChildren();
      const guilds = liveGuilds();

      if (!guilds.length) {
        root.append(empty("Nobody is in a voice channel", "Members appear here as soon as someone joins."));
        return;
      }

      for (const g of guilds) {
        const section = el("section", "v-guild");
        section.setAttribute("aria-label", g.name);
        section.append(el("h3", "", g.name));

        const wrap = el("div", "v-channels");

        for (const c of g.channels) {
          const members = Array.isArray(c.members) ? c.members : [];
          const isTarget = t?.channelId === c.id;

          const box = el("div", "v-channel");
          if (isTarget) box.dataset.target = "true";

          const head = el("div", "v-head");
          head.append(el("span", "v-name", c.name), el("span", "v-count", `${members.length} in channel`));

          const use = button("btn small", "Play here", {
            act: "target",
            guild: g.id,
            channel: c.id,
            focusKey: `target:${c.id}`,
          });
          use.setAttribute("aria-pressed", String(isTarget));
          use.setAttribute("aria-label", `Play sounds in ${c.name}`);
          head.append(use);

          const list = el("ul", "v-members");
          for (const m of members) list.append(memberRow(m));

          box.append(head, list);
          wrap.append(box);
        }

        section.append(wrap);
        root.append(section);
      }
    },
    $("panel-voice"),
  );
}

function renderStatus() {
  const s = $("status");
  let pair;

  if (state.conn === "down") pair = ["down", "Disconnected, retrying"];
  else if (!state.gotSnapshot) pair = ["connecting", "Connecting"];
  else pair = state.ready ? ["live", "Live"] : ["connecting", "Bot reconnecting"];

  s.dataset.state = pair[0];
  s.textContent = pair[1];
}

function renderBadges() {
  const pending = state.playback.reduce((n, e) => n + queuedOf(e) + (e.current ? 1 : 0), 0);
  const voice =
    typeof state.total === "number"
      ? state.total
      : liveGuilds().reduce((n, g) => n + guildMembers(g), 0);

  const set = (id, n) => { $(id).textContent = n > 0 ? String(n) : ""; };

  set("count-sounds", state.sounds.length);
  set("count-favorites", state.sounds.filter((s) => state.favorites.has(s.name)).length);
  set("count-recent", baseList("recent").length);
  set("count-queue", pending);
  set("count-voice", voice);

  document.title = voice ? `(${voice}) Soundboard` : "Soundboard";
}

function renderPlayback() {
  renderQueue();
  renderNow();
  updateCardStates();
  renderBadges();
}

function onSnapshot(snap) {
  state.gotSnapshot = true;
  state.ready = Boolean(snap.ready);
  state.guilds = Array.isArray(snap.guilds) ? snap.guilds : [];
  state.total = typeof snap.total === "number" ? snap.total : null;
  state.playback = normalizePlayback(snap.playback);

  for (const g of state.guilds) {
    names.guilds.set(g.id, g.name);
    for (const c of g.channels || []) names.channels.set(c.id, c.name);
  }

  renderStatus();
  renderTarget();
  renderVoice();
  renderPlayback();
}

let source = null;
let retries = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  source = new EventSource("/events");

  source.onopen = () => {
    retries = 0;
    state.conn = "open";
    renderStatus();
  };

  source.onmessage = (e) => {
    try {
      onSnapshot(JSON.parse(e.data));
    } catch (err) {
      console.error("Invalid voice update:", err);
    }
  };

  source.onerror = () => {
    state.conn = "down";
    renderStatus();

    if (source.readyState === EventSource.CLOSED) {
      source.close();
      // A refused stream usually means the sign-in session ended: reloading sends the browser to Discord to sign in again.
      fetch("/api/status", { cache: "no-store" })
        .then((r) => {
          if (r.status === 401) location.reload();
        })
        .catch(() => {});
      retries = Math.min(retries + 1, 5);
      retryTimer = setTimeout(connect, Math.min(3000 * retries, 15000));
    }
  };
}

function setTab(tab, { focus = false, scroll = false, hash = true } = {}) {
  tab = normalizeTab(tab) || "sounds";
  state.tab = tab;

  for (const t of TABS) {
    const on = t === tab;
    const tabEl = $(`tab-${t}`);
    tabEl.setAttribute("aria-selected", String(on));
    tabEl.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (SOUND_TABS.has(t) && !on) $(`grid-${t}`).replaceChildren();
  }

  $("toolbar").hidden = !SOUND_TABS.has(tab);
  $("toolbar").toggleAttribute("data-nosort", tab === "recent");
  document.querySelector(".sort").hidden = tab === "recent";

  renderSoundViews();

  if (hash) history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`);
  if (focus) $(`tab-${tab}`).focus();
  if (scroll) window.scrollTo(0, 0);
}

$("tablist").addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-tab]") : null;
  if (b) setTab(b.dataset.tab, { scroll: true });
});

$("tablist").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(state.tab);
  let next = -1;

  if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = TABS.length - 1;
  else return;

  e.preventDefault();
  setTab(TABS[next], { focus: true });
});

window.addEventListener("hashchange", () => {
  const t = normalizeTab(location.hash);
  if (t && t !== state.tab) setTab(t, { hash: false });
});

$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderSoundViews();
});

$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) {
    e.target.value = "";
    state.query = "";
    renderSoundViews();
  }
});

$("sort").value = state.sort;
$("sort").addEventListener("change", (e) => {
  state.sort = e.target.value === "count" ? "count" : "name";
  store.write(K.sort, state.sort);
  renderSoundViews();
});

$("main").addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("button[data-act]") : null;
  if (!b || b.disabled) return;

  const busy = b.getAttribute("aria-disabled") === "true";
  const card = b.closest(".card");

  switch (b.dataset.act) {
    case "play":
      if (card) playSound(card.dataset.sound);
      break;
    case "fav":
      if (card) toggleFavorite(card.dataset.sound);
      break;
    case "tag":
      state.tag = state.tag === b.dataset.tag ? "" : b.dataset.tag;
      renderTagChips();
      renderSoundViews();
      break;
    case "more-tags":
      state.tagsExpanded = !state.tagsExpanded;
      renderTagChips();
      break;
    case "clear-filters":
      state.query = "";
      state.tag = "";
      $("search").value = "";
      renderTagChips();
      renderSoundViews();
      break;
    case "retry":
      loadSounds();
      break;
    case "target":
      setPreferred(b.dataset.guild, b.dataset.channel);
      break;
    case "skip":
    case "remove":
    case "clear-pending":
      if (!busy) runQueueAction(b.dataset.act, b.dataset.guild, b.dataset.queueId, b);
      break;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof Element && t.closest("input, select, textarea, [contenteditable]")) return;

  e.preventDefault();
  if (!SOUND_TABS.has(state.tab)) setTab("sounds");
  $("search").focus();
  $("search").select();
});

window.addEventListener("storage", (e) => {
  if (e.key === K.fav) {
    state.favorites = new Set(strings(store.read(K.fav, [])));
    afterFavoritesChanged();
  } else if (e.key === K.recent) {
    state.recent = strings(store.read(K.recent, []));
    if (state.tab === "recent") renderSoundViews();
    renderBadges();
  } else if (e.key === K.target) {
    state.preferred = validTarget(store.read(K.target, null));
    renderTarget();
    renderVoice();
    updateCardStates();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - state.soundsLoadedAt > 60_000) loadSounds(true);
  refreshPlayback().catch(() => {});
});

/* ---------- text size (works the same on desktop, mobile and touch panels; no CSS zoom/transform) ---------- */

const SCALE_MIN = 0.9;
const SCALE_MAX = 2.2;
const SCALE_STEP = 0.1;

function applyScale(v, save = true) {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  const scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) * 100) / 100;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  document.documentElement.toggleAttribute("data-bigtext", scale >= 1.4);
  if (save) store.write(K.scale, scale);
  $("textSmaller").disabled = scale <= SCALE_MIN;
  $("textLarger").disabled = scale >= SCALE_MAX;
}

const scaleFromUrl = new URLSearchParams(location.search).get("scale"); // e.g. ?key=...&scale=1.6 for a fixed panel
applyScale(scaleFromUrl ?? store.read(K.scale, 1.2), scaleFromUrl !== null);
for (const [id, dir] of [["textSmaller", -1], ["textLarger", 1]]) {
  $(id).addEventListener("click", () => {
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1.2;
    applyScale(cur + dir * SCALE_STEP);
  });
}

installCustomSelect($("guild-select"));
installCustomSelect($("channel-select"));
installCustomSelect($("sort"));

setTab(tabFromUrl(), { hash: false });
renderStatus();
renderTarget();
renderVoice();
renderQueue();
loadSounds();
refreshPlayback().catch((err) => console.warn("Initial queue refresh failed:", err));
connect();

/* ---------- hide the Import / Logs buttons from people the bot owner has not given those permissions ---------- */
fetch("/api/me", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((me) => {
    if (!me) return;
    for (const [id, allowed] of [["importSoundsButton", me.can?.import], ["logsButton", me.can?.logs]]) {
      const el = document.getElementById(id);
      if (el && allowed === false) el.hidden = true;
    }
  })
  .catch(() => {});
