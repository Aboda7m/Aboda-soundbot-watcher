"use strict";
const $ = (id) => document.getElementById(id);
const video = $("video");
let user = null, rooms = [], active = null, sourceKey = "", applying = false, ytPlayer = null, ytReady = false, eventSource = null, lastState = null;
let lastYtPosition = null, lastYtAt = 0, ytSeekSuppressUntil = 0;
let pollTimer = null;
const fmt = (n) => { n = Math.max(0, Math.floor(Number(n) || 0)); return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`; };
async function api(url, options = {}) {
  const r = await fetch(url, { credentials:"same-origin", ...options, headers:{ ...(options.body ? {"Content-Type":"application/json"}:{}), ...(options.headers||{}) } });
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
  sourceKey = key; applying = true;
  $("empty-player").hidden = !!media; video.hidden = true; $("youtube-player").hidden = true;
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  if (!media) { video.removeAttribute("src"); video.load(); $("empty-player").hidden = false; applying = false; return; }
  if (media.kind === "youtube" && media.youtubeId) {
    $("youtube-player").hidden = false; await ensureYoutube();
    ytPlayer = new YT.Player("youtube-player", { videoId:media.youtubeId, width:"100%", height:"100%", playerVars:{playsinline:1,rel:0,enablejsapi:1,origin:window.location.origin}, events:{ onReady:() => { applying=false; if(lastState) applyPlayback(lastState.playback); }, onStateChange:(e) => { if(applying || !active) return; if(e.data === YT.PlayerState.PLAYING) send("play"); else if(e.data === YT.PlayerState.PAUSED) send("pause"); }, onPlaybackRateChange:(e) => { if(!applying && active) send("rate",{rate:Number(e.data)}); }, onAutoplayBlocked:() => { $("enable-playback").hidden=false; } } });
  } else {
    video.hidden = false; video.controls = true; video.src = media.url; video.load();
    video.onloadedmetadata = () => { applying=false; if(lastState) applyPlayback(lastState.playback); };
    video.onerror = () => { $("source-error").textContent = "This source could not be played by your browser. Try a direct MP4/WebM URL or a supported YouTube link."; applying=false; };
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
  $("room-title").textContent = s.channelName; $("room-subtitle").textContent = `${s.guildName} · ${s.participants.length} participant${s.participants.length===1?"":"s"}`;
}
async function refreshRooms() {
  try {
    const data = await api("/api/watch/me"); user = data.user; $("admin-card").hidden = !data.admin; rooms = data.rooms || [];
    if (!rooms.length) {
      stopEvents();
      if (active) { applying=true; try { video.pause(); video.removeAttribute("src"); video.load(); if(ytPlayer) ytPlayer.destroy(); } catch {} ytPlayer=null; sourceKey=""; applying=false; }
      active = null; $("video").hidden=true; $("youtube-player").hidden=true; $("empty-player").hidden=false;
      $("room-title").textContent = "Join a Discord voice channel"; $("room-subtitle").textContent = "Once you join, this page automatically opens that channel's watch session.";
      $("room-select").hidden = true; $("participants").textContent = "Waiting for you to join voice…"; $("member-count").textContent="0"; return;
    }
    const select = $("room-select"); select.hidden = rooms.length < 2; select.replaceChildren();
    for (const r of rooms) { const o = document.createElement("option"); o.value = `${r.guildId}:${r.channelId}`; o.textContent = `${r.guildName} / ${r.channelName}`; select.append(o); }
    const current = rooms.find(r => active && r.guildId===active.guildId && r.channelId===active.channelId) || rooms[0];
    select.value = `${current.guildId}:${current.channelId}`; chooseRoom(current);
  } catch(e) { setConnected(false,e.message); }
}
$("room-select").addEventListener("change", () => { const r=rooms.find(x=>`${x.guildId}:${x.channelId}`===$("room-select").value); if(r) chooseRoom(r); });
$("source-form").addEventListener("submit", async (e) => { e.preventDefault(); $("source-error").textContent=""; if(!active) return; const url=$("video-url").value.trim(); await send("media",{url}); });
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
