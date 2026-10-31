"use strict";
const $ = (id) => document.getElementById(id);
const video = $("video");
let user = null, rooms = [], active = null, sourceKey = "", applying = false, ytPlayer = null, ytReady = false, eventSource = null, lastState = null;
let lastYtPosition = null, lastYtAt = 0, ytSeekSuppressUntil = 0;
let pollTimer = null, hls = null;
// ---- subtitle / audio tracks (found inside the file by the bot; choices are per viewer, not shared) ----
const altAudio = $("alt-audio");
let tracksSig = "", altActive = false, audioReq = 0, mutedByUs = false, volWanted = 1;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stopAltAudio() {
  altActive = false; audioReq++;
  try { altAudio.pause(); altAudio.removeAttribute("src"); altAudio.load(); } catch {}
  if (mutedByUs) { video.muted = false; mutedByUs = false; }
  $("vol-label").hidden = true;
}
function clearTracks() {
  tracksSig = ""; for (const t of video.querySelectorAll("track")) t.remove();
  stopAltAudio(); $("tracks-row").hidden = true; $("track-note").textContent = "";
  $("sub-select").replaceChildren(new Option("Off", "off")); $("audio-select").replaceChildren(new Option("Original", "default"));
}
function applyTracks(media) {
  const t = media && media.tracks; const sig = t ? JSON.stringify(t) : "";
  if (sig === tracksSig) return;
  tracksSig = sig; if (!t) return;
  const subs = t.subs || [], audio = t.audio || [];
  const subSel = $("sub-select"); subSel.replaceChildren(new Option("Off", "off"));
  for (const s of subs) { const o = new Option(s.supported ? s.label : `${s.label} — not supported`, String(s.id)); o.disabled = !s.supported; subSel.append(o); }
  const audioSel = $("audio-select"); audioSel.replaceChildren();
  const def = audio.find((a) => a.default) || audio[0];
  for (const a of audio) audioSel.append(new Option(a === def ? `${a.label} · default` : a.label, a === def ? "default" : String(a.id)));
  $("audio-label").hidden = audio.length < 2;
  $("tracks-row").hidden = !subs.length && audio.length < 2;
  const pref = store.get("watch.sub");
  if (pref && pref !== "off") {
    const m = subs.find((s) => s.supported && s.lang === pref && !s.forced) || subs.find((s) => s.supported && s.lang === pref);
    if (m) { subSel.value = String(m.id); selectSub(); }
  }
}
function selectSub() {
  for (const t of video.querySelectorAll("track")) t.remove();
  const v = $("sub-select").value, note = $("track-note"); note.textContent = "";
  if (v === "off") { store.set("watch.sub", "off"); return; }
  const s = ((lastState && lastState.media && lastState.media.tracks && lastState.media.tracks.subs) || []).find((x) => String(x.id) === v);
  if (!s || !s.url) return;
  store.set("watch.sub", s.lang);
  const el = document.createElement("track"); el.kind = "subtitles"; el.label = s.label; el.default = true; el.src = s.url;
  note.textContent = "Loading subtitles (the first time the bot reads the whole file; this can take a minute)…";
  el.addEventListener("load", () => { note.textContent = ""; });
  el.addEventListener("error", () => { note.textContent = "Subtitles could not be loaded."; });
  video.append(el); el.track.mode = "showing";
}
async function selectAudio() {
  const v = $("audio-select").value; stopAltAudio(); const mine = audioReq;
  if (v === "default") return;
  const a = ((lastState && lastState.media && lastState.media.tracks && lastState.media.tracks.audio) || []).find((x) => String(x.id) === v);
  if (!a) return;
  const note = $("track-note"); let ready = false;
  for (let i = 0; i < 400 && !ready; i++) {
    if (mine !== audioReq) return;
    note.textContent = "Preparing this audio track (the bot reads the whole file once; everyone shares the result)…";
    let r; try { r = await fetch(a.url, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" }); } catch { await sleep(3000); continue; }
    if (r.status === 202) { await sleep(3000); continue; }
    if (r.status === 200 || r.status === 206) { ready = true; break; }
    note.textContent = "This audio track could not be prepared."; $("audio-select").value = "default"; return;
  }
  if (mine !== audioReq || !ready) return;
  note.textContent = "";
  altAudio.src = a.url; altAudio.volume = volWanted; altAudio.load();
  altActive = true; mutedByUs = !video.muted; video.muted = true; $("vol-label").hidden = false; syncAlt(true);
}
function syncAlt(force) {
  if (!altActive) return;
  try {
    if (video.paused || video.seeking || video.readyState < 3) { if (!altAudio.paused) altAudio.pause(); }
    else if (altAudio.paused) altAudio.play().catch(() => {});
    if (altAudio.playbackRate !== video.playbackRate) altAudio.playbackRate = video.playbackRate;
    if (force || Math.abs(altAudio.currentTime - video.currentTime) > 0.35) altAudio.currentTime = video.currentTime;
  } catch {}
}
$("sub-select").addEventListener("change", selectSub);
$("audio-select").addEventListener("change", selectAudio);
$("vol").addEventListener("input", () => { volWanted = Number($("vol").value); altAudio.volume = volWanted; });
for (const ev of ["play", "pause", "seeked", "seeking", "waiting", "playing", "ratechange"]) video.addEventListener(ev, () => syncAlt(ev === "seeked"));
video.addEventListener("volumechange", () => { if (altActive && !video.muted) video.muted = true; });   // the Volume slider controls the alternative audio
setInterval(() => syncAlt(false), 500);
function destroyHls() { if (hls) { try { hls.destroy(); } catch {} hls = null; } }
const fmt = (n) => { n = Math.max(0, Math.floor(Number(n) || 0)); return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`; };
async function api(url, options = {}) {
  let r; try { r = await fetch(url, { credentials:"same-origin", signal: AbortSignal.timeout(10000), ...options, headers:{ ...(options.body ? {"Content-Type":"application/json"}:{}), ...(options.headers||{}) } }); } catch (e) { throw new Error(e && e.name === "TimeoutError" ? "Server did not respond (timed out). Check the tunnel / Cloudflare rules for /api/watch/*." : (e && e.message) || "Network error"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function send(action, extra = {}) {
  if (!active) return Promise.resolve();
  return api("/api/watch/command", { method:"POST", body:JSON.stringify({ guildId:active.guildId, channelId:active.channelId, action, ...extra }) }).catch((e) => { $("source-error").textContent = e.message; });
}
function setConnected(ok, text) { $("connection").textContent = text; $("connection").style.color = ok ? "#4ade80" : "#fca5a5"; }
function stopEvents() { if (eventSource) eventSource.close(); eventSource = null; }
function chooseRoom(room) {
  if (active && active.guildId === room.guildId && active.channelId === room.channelId) return;
  stopEvents(); active = room; sourceKey = ""; lastState = null;
  $("room-title").textContent = `${room.channelName}`; $("room-subtitle").textContent = room.guildName;
  eventSource = new EventSource(`/api/watch/events?guildId=${encodeURIComponent(room.guildId)}&channelId=${encodeURIComponent(room.channelId)}`);
  eventSource.addEventListener("state", (e) => { try { const s = JSON.parse(e.data); active = { ...active, ...s }; render(s); setConnected(true,"Live · synchronized"); } catch {} });
  eventSource.onerror = () => setConnected(false,"Reconnecting…");
}
function renderParticipants(s) {
  $("member-count").textContent = String(s.participants.length);
  $("participants").replaceChildren();
  if (!s.participants.length) { $("participants").textContent = "No one is currently in this voice channel."; return; }
  for (const p of s.participants) {
    const row = document.createElement("div"); row.className = "participant";
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = (p.username || "?").slice(0,1).toUpperCase();
    const info = document.createElement("div"); const name = document.createElement("div"); name.className = "participant-name"; name.textContent = p.username;
    const state = document.createElement("div"); state.className = "participant-state"; state.textContent = "In voice";
    info.append(name,state); row.append(avatar,info); $("participants").append(row);
  }
}
function ensureYoutube() {
  if (window.YT && window.YT.Player) { ytReady = true; return Promise.resolve(); }
  if (window.__ytPromise) return window.__ytPromise;
  window.__ytPromise = new Promise((resolve) => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prior) prior(); ytReady = true; resolve(); };
    const script = document.createElement("script"); script.src = "https://www.youtube.com/iframe_api"; document.head.append(script);
  });
  return window.__ytPromise;
}
async function loadMedia(media) {
  const key = media ? `${media.kind}:${media.url}` : "";
  if (key === sourceKey) return;
  sourceKey = key; applying = true; clearTracks();
  $("empty-player").hidden = !!media; video.hidden = true; $("youtube-player").hidden = true;
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  destroyHls();
  if (!media) { video.removeAttribute("src"); video.load(); $("empty-player").hidden = false; applying = false; return; }
  if (media.kind === "youtube" && media.youtubeId) {
    $("youtube-player").hidden = false; await ensureYoutube();
    ytPlayer = new YT.Player("youtube-player", { videoId:media.youtubeId, width:"100%", height:"100%", playerVars:{playsinline:1,rel:0,enablejsapi:1,origin:window.location.origin}, events:{ onReady:() => { applying=false; if(lastState) applyPlayback(lastState.playback); }, onStateChange:(e) => { if(applying || !active) return; if(e.data === YT.PlayerState.PLAYING) send("play"); else if(e.data === YT.PlayerState.PAUSED) send("pause"); }, onPlaybackRateChange:(e) => { if(!applying && active) send("rate",{rate:Number(e.data)}); }, onAutoplayBlocked:() => { $("enable-playback").hidden=false; }, onError:(e) => { $("source-error").textContent = `YouTube could not play this video (error ${e.data}). It may block embedding, be private, or be age-restricted.`; applying=false; } } });
  } else {
    video.hidden = false; video.controls = true;
    video.onloadedmetadata = () => { applying=false; if(lastState) applyPlayback(lastState.playback); };
    video.onerror = () => { $("source-error").textContent = "This source could not be played by your browser (unsupported container/codec is common for MKV/HEVC anime). Try another stream, or send it again with \"Transcode\" on the Stremio page."; applying=false; };
    if (media.kind === "hls" && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: false });
      hls.on(window.Hls.Events.ERROR, (_e, data) => { if (data && data.fatal) { $("source-error").textContent = `Stream error (${data.details || "fatal"}). The stream may have expired; send it again.`; applying=false; } });
      hls.loadSource(media.url); hls.attachMedia(video);
    } else { video.src = media.url; video.load(); }
  }
}
function localPosition() { try { return ytPlayer ? ytPlayer.getCurrentTime() : video.currentTime || 0; } catch { return 0; } }
function localPaused() { try { return ytPlayer ? ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING : video.paused; } catch { return true; } }
function applyPlayback(p) {
  if (!p) return;
  const expected = p.position;
  const actual = localPosition();
  applying = true;
  try {
    if (ytPlayer && ytReady) {
      if (Math.abs(actual-expected) > 1.8) { ytPlayer.seekTo(expected, true); ytSeekSuppressUntil=Date.now()+1800; }
      lastYtPosition=expected; lastYtAt=Date.now();
      if (p.paused) { if (!localPaused()) ytPlayer.pauseVideo(); } else if (localPaused()) ytPlayer.playVideo();
      if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(p.playbackRate);
    } else if (video.src) {
      if (Number.isFinite(video.duration) && Math.abs(actual-expected) > 1.8) video.currentTime = expected;
      if (p.paused && !video.paused) video.pause(); else if (!p.paused && video.paused) video.play().then(()=>{ $("enable-playback").hidden=true; }).catch(() => { $("enable-playback").hidden=false; });
      if (video.playbackRate !== p.playbackRate) video.playbackRate = p.playbackRate;
    }
  } catch {} finally { setTimeout(() => { applying=false; }, 250); }
  $("seek").value = String(expected); $("time").textContent = `${fmt(expected)} / ${fmt(video.duration || 0)}`;
  $("play").disabled = $("pause").disabled = false; $("seek").disabled = false; $("rate").disabled = false; $("rate").value = String(p.playbackRate);
}
async function render(s) {
  lastState = s; renderParticipants(s);
  if (s.media) await loadMedia(s.media); else await loadMedia(null);
  if (s.playback) applyPlayback(s.playback);
  applyTracks(s.media);
  $("room-title").textContent = s.channelName; $("room-subtitle").textContent = `${s.guildName} · ${s.participants.length} participant${s.participants.length===1?"":"s"}`;
}
async function refreshRooms() {
  try {
    const data = await api("/api/watch/me"); user = data.user; $("admin-card").hidden = !data.admin; $("stremio-link").hidden = !data.stremio; rooms = data.rooms || [];
    if (!rooms.length) {
      stopEvents();
      if (active) { clearTracks(); applying=true; try { destroyHls(); video.pause(); video.removeAttribute("src"); video.load(); if(ytPlayer) ytPlayer.destroy(); } catch {} ytPlayer=null; sourceKey=""; applying=false; }
      active = null; $("video").hidden=true; $("youtube-player").hidden=true; $("empty-player").hidden=false;
      $("room-title").textContent = "Join a Discord voice channel"; $("room-subtitle").textContent = "Once you join, this page automatically opens that channel's watch session.";
      $("room-select").hidden = true; $("participants").textContent = "Waiting for you to join voice…"; $("member-count").textContent="0";
      setConnected(false, "Not in a voice channel"); return;
    }
    const select = $("room-select"); select.hidden = rooms.length < 2; select.replaceChildren();
    for (const r of rooms) { const o = document.createElement("option"); o.value = `${r.guildId}:${r.channelId}`; o.textContent = `${r.guildName} / ${r.channelName}`; select.append(o); }
    const current = rooms.find(r => active && r.guildId===active.guildId && r.channelId===active.channelId) || rooms[0];
    select.value = `${current.guildId}:${current.channelId}`; if (!eventSource) setConnected(true, "Connected"); chooseRoom(current);
  } catch(e) { setConnected(false,e.message); }
}
$("room-select").addEventListener("change", () => { const r=rooms.find(x=>`${x.guildId}:${x.channelId}`===$("room-select").value); if(r) chooseRoom(r); });
$("source-form").addEventListener("submit", async (e) => { e.preventDefault(); $("source-error").textContent=""; if(!active){ $("source-error").textContent="Join a Discord voice channel first (the bot must see you in voice), then try again."; return; } const url=$("video-url").value.trim(); if(/^http:\/\//i.test(url)){ $("source-error").textContent="Only HTTPS video URLs work (browsers block http on an https page)."; return; } await send("media",{url}); });
$("play").addEventListener("click",()=>send("play")); $("pause").addEventListener("click",()=>send("pause"));
$("enable-playback").addEventListener("click", async () => {
  try {
    applying=true;
    if (ytPlayer) { ytPlayer.playVideo(); setTimeout(() => { applying=false; if(lastState) applyPlayback(lastState.playback); },450); }
    else { await video.play(); video.pause(); applying=false; $("enable-playback").hidden=true; if(lastState) applyPlayback(lastState.playback); }
  } catch { applying=false; $("source-error").textContent="Your browser could not enable playback for this source."; }
});
$("seek").addEventListener("change",()=>send("seek",{position:Number($("seek").value)})); $("rate").addEventListener("change",()=>send("rate",{rate:Number($("rate").value)}));
video.addEventListener("play",()=>{if(!applying)send("play");}); video.addEventListener("pause",()=>{if(!applying && video.src)send("pause");}); video.addEventListener("seeking",()=>{if(!applying && Number.isFinite(video.currentTime))send("seek",{position:video.currentTime});}); video.addEventListener("timeupdate",()=>{if(video.duration){$("seek").max=String(video.duration);$("seek").value=String(video.currentTime);$("time").textContent=`${fmt(video.currentTime)} / ${fmt(video.duration)}`;}});
refreshRooms(); pollTimer=setInterval(refreshRooms,5000);
setInterval(() => {
  if (!ytPlayer || !ytReady || applying || Date.now() < ytSeekSuppressUntil) return;
  try {
    const now=Date.now(), pos=ytPlayer.getCurrentTime(), state=ytPlayer.getPlayerState();
    if (lastYtPosition !== null && lastYtAt) {
      const elapsed=(now-lastYtAt)/1000;
      const expectedDelta=state===YT.PlayerState.PLAYING ? elapsed*(ytPlayer.getPlaybackRate?.() || 1) : 0;
      if (Math.abs((pos-lastYtPosition)-expectedDelta)>2.2) send("seek",{position:pos});
    }
    lastYtPosition=pos; lastYtAt=now;
  } catch {}
},1000);
window.addEventListener("beforeunload",()=>{stopEvents();clearInterval(pollTimer);});
