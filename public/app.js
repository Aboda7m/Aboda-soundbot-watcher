const root = document.getElementById("root");
const statusEl = document.getElementById("status");
const soundSelect = document.getElementById("sound");
const nowEl = document.getElementById("now");
let botReady = false;

// Page key (?key=...) is forwarded to the API as a header.
const key = new URLSearchParams(location.search).get("key");
const authHeaders = key ? { "X-Access-Key": key } : {};

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function memberRow(m) {
  const li = el("li");
  if (m.avatar) {
    const img = el("img", "avatar");
    img.src = m.avatar;
    img.alt = "";
    img.loading = "lazy";
    li.append(img);
  } else {
    li.append(el("span", "avatar initial", m.name.slice(0, 1).toUpperCase()));
  }
  li.append(el("span", "name", m.name));

  const tags = el("span", "tags");
  if (m.bot) tags.append(el("span", "tag", "bot"));
  if (m.streaming) tags.append(el("span", "tag live", "streaming"));
  if (m.camera) tags.append(el("span", "tag live", "camera"));
  if (m.deafened) tags.append(el("span", "tag", "deafened"));
  else if (m.muted) tags.append(el("span", "tag", "muted"));
  if (tags.children.length) li.append(tags);
  return li;
}

function render(snap) {
  botReady = snap.ready;
  setStatus(snap.ready ? "live" : "connecting", snap.ready ? "Live" : "Bot reconnecting");
  showPlayback(snap.playback);
  document.title = snap.total ? `(${snap.total}) Voice` : "Voice";

  root.replaceChildren();
  if (!snap.guilds.length) {
    root.append(el("p", "empty", "No one is in a voice channel."));
    return;
  }
  for (const g of snap.guilds) {
    const section = el("section", "guild");
    section.append(el("h2", "", g.name));
    for (const c of g.channels) {
      const box = el("div", "channel");
      const head = el("div", "channel-head");
      const play = el("button", "play", "Play here");
      play.type = "button";
      play.dataset.guild = g.id;
      play.dataset.channel = c.id;
      play.disabled = !soundSelect.value;
      head.append(el("span", "channel-name", c.name), el("span", "count", String(c.members.length)), play);
      const list = el("ul");
      for (const m of c.members) list.append(memberRow(m));
      box.append(head, list);
      section.append(box);
    }
    root.append(section);
  }
}

// Pass ?key=... through so the page works when an ACCESS_KEY is set.
const es = new EventSource("/events" + location.search);
es.onmessage = (e) => render(JSON.parse(e.data));
es.onopen = () => setStatus(botReady ? "live" : "connecting", botReady ? "Live" : "Connecting");
es.onerror = () => setStatus("down", "Disconnected, retrying");

function showPlayback(pb) {
  const playing = (pb && pb.playing) || [];
  const now = playing.filter((p) => p.current).map((p) => p.current.sound);
  const queued = playing.reduce((n, p) => n + p.queued, 0);
  nowEl.className = "now";
  nowEl.textContent = now.length ? `Playing: ${now.join(", ")}${queued ? ` (+${queued} queued)` : ""}` : "";
}

async function loadSounds() {
  try {
    const res = await fetch("/api/sounds" + location.search, { headers: authHeaders });
    if (!res.ok) throw new Error(String(res.status));
    const { sounds } = await res.json();
    soundSelect.replaceChildren(...sounds.map((s) => new Option(s.name, s.name)));
    soundSelect.disabled = sounds.length === 0;
    if (!sounds.length) soundSelect.replaceChildren(new Option("No sounds found", ""));
    for (const b of root.querySelectorAll("button.play")) b.disabled = !soundSelect.value;
  } catch {
    soundSelect.replaceChildren(new Option("Sounds unavailable", ""));
  }
}

root.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.play");
  if (!btn || !soundSelect.value) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/play", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ sound: soundSelect.value, guildId: btn.dataset.guild, channelId: btn.dataset.channel }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reasons = { "queue-full": "Queue is full", duplicate: "Already queued" };
      throw new Error(body.error || reasons[body.reason] || `Request failed (${res.status})`);
    }
  } catch (err) {
    nowEl.className = "now error";
    nowEl.textContent = err.message;
  } finally {
    btn.disabled = !soundSelect.value;
  }
});

loadSounds();
