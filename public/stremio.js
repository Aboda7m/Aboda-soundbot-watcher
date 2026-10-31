"use strict";
const $ = (id) => document.getElementById(id);
let current = null;          // { meta }
let rooms = [];
let pickedVideo = null;

async function api(url, options = {}) {
  let r;
  try {
    r = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(45000), ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  } catch (e) { throw new Error(e && e.name === "TimeoutError" ? "The server took too long to answer." : (e && e.message) || "Network error"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function say(text, cls = "") { const m = $("msg"); m.textContent = text; m.className = `msg ${cls}`; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

async function loadRooms() {
  try {
    const d = await api("/api/watch/me");
    rooms = d.rooms || [];
    const sel = $("room"); sel.replaceChildren();
    for (const r of rooms) { const o = el("option", "", `${r.guildName} / ${r.channelName}`); o.value = `${r.guildId}:${r.channelId}`; sel.append(o); }
    $("room-note").textContent = rooms.length ? "" : "Join a Discord voice channel (the bot must see you) to send streams to its watch room.";
    sel.disabled = !rooms.length;
  } catch (e) { $("room-note").textContent = e.message; }
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim(); if (q.length < 2) return;
  say("Searching…"); $("results").replaceChildren(); $("detail").hidden = true;
  try {
    const { results } = await api(`/api/stremio/search?q=${encodeURIComponent(q)}`);
    if (!results.length) return say("No results. Try another spelling or the English / romaji title.");
    say(`${results.length} result${results.length === 1 ? "" : "s"}`);
    for (const m of results) {
      const card = el("button", "card"); card.type = "button";
      if (m.poster) { const img = el("img"); img.src = m.poster; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; card.append(img); }
      else card.append(el("div", "noimg", "No poster"));
      const meta = el("div", "meta"); meta.append(el("div", "name", m.name), el("div", "sub", [m.type, m.year].filter(Boolean).join(" · ")));
      card.append(meta); card.addEventListener("click", () => openTitle(m)); $("results").append(card);
    }
  } catch (err) { say(err.message, "err"); }
});

async function openTitle(m) {
  say("Loading details…"); pickedVideo = null; $("streams-box").hidden = true;
  try {
    const { meta } = await api(`/api/stremio/meta?type=${encodeURIComponent(m.type)}&id=${encodeURIComponent(m.id)}`);
    current = { meta }; say("");
    $("d-title").textContent = meta.name;
    $("d-sub").textContent = [meta.type, meta.year, (meta.genres || []).join(", ")].filter(Boolean).join(" · ");
    $("d-desc").textContent = meta.description || "";
    const p = $("d-poster"); if (meta.poster) { p.src = meta.poster; p.referrerPolicy = "no-referrer"; p.hidden = false; } else p.hidden = true;
    const seasons = [...new Set(meta.videos.map((v) => v.season))];
    const sel = $("season"); sel.replaceChildren();
    for (const s of seasons) { const o = el("option", "", s === 0 ? "Specials" : `Season ${s}`); o.value = String(s); sel.append(o); }
    sel.hidden = seasons.length < 2; sel.value = String(seasons.find((s) => s > 0) ?? seasons[0]);
    renderEpisodes(); $("detail").hidden = false; await loadRooms();
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
    if (meta.videos.length === 1) pickEpisode(meta.videos[0], null);   // movies: go straight to streams
  } catch (err) { say(err.message, "err"); }
}

function renderEpisodes() {
  const season = Number($("season").value);
  const list = current.meta.videos.filter((v) => seasonsCount() < 2 || v.season === season);
  const box = $("eps"); box.replaceChildren();
  for (const v of list) {
    const b = el("button", "ep"); b.type = "button";
    const n = el("b", "", v.episode ? `E${v.episode}` : "▶"); b.append(n, v.title.length > 40 ? v.title.slice(0, 40) + "…" : v.title);
    if (v.released) b.append(el("span", "", v.released.slice(0, 10)));
    b.addEventListener("click", () => pickEpisode(v, b)); box.append(b);
  }
}
const seasonsCount = () => new Set(current.meta.videos.map((v) => v.season)).size;
$("season").addEventListener("change", renderEpisodes);
$("d-close").addEventListener("click", () => { $("detail").hidden = true; });

async function pickEpisode(v, btn) {
  pickedVideo = v;
  for (const e of document.querySelectorAll(".ep.sel")) e.classList.remove("sel");
  if (btn) btn.classList.add("sel");
  $("streams-box").hidden = false; $("streams-title").textContent = `Streams · ${v.episode ? `E${v.episode} ` : ""}${v.title}`;
  const box = $("streams"); box.replaceChildren(el("p", "muted", "Asking the stream addons… (can take up to 15 s)"));
  try {
    const { streams } = await api(`/api/stremio/streams?type=${encodeURIComponent(current.meta.type)}&id=${encodeURIComponent(v.id)}`);
    box.replaceChildren();
    if (!streams.length) return box.append(el("p", "muted", "No streams found for this episode."));
    for (const s of streams) {
      const row = el("div", "stream");
      const info = el("div", "info"); info.append(el("div", "t", s.title));
      info.append(el("div", "m", [s.addon, s.name, s.quality, s.size, s.seeders != null ? `${s.seeders} seeders` : ""].filter(Boolean).join(" · ")));
      const badge = el("span", `badge ${s.kind}`, s.kind === "url" ? "DIRECT" : "TORRENT");
      const btn2 = el("button", "primary", "Send to room"); btn2.type = "button";
      btn2.addEventListener("click", () => send(s, btn2));
      row.append(badge, info, btn2); box.append(row);
    }
  } catch (err) { box.replaceChildren(el("p", "msg err", err.message)); }
}

async function send(stream, btn) {
  const room = rooms.find((r) => `${r.guildId}:${r.channelId}` === $("room").value);
  if (!room) return say("Join a Discord voice channel first so there is a room to send to.", "err");
  btn.disabled = true; const old = btn.textContent; btn.textContent = stream.kind === "torrent" ? "Starting torrent…" : "Sending…";
  try {
    const r = await api("/api/stremio/play", { method: "POST", body: JSON.stringify({ ref: stream.ref, guildId: room.guildId, channelId: room.channelId, transcode: $("transcode").checked && stream.kind === "torrent" }) });
    say(`Sent to ${room.channelName}: ${r.title}. Open Watch Together to play (it starts paused).`, "ok");
  } catch (err) { say(err.message, "err"); }
  finally { btn.disabled = false; btn.textContent = old; }
}
