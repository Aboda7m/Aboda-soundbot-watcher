const root = document.getElementById("root");
const statusEl = document.getElementById("status");
let botReady = false;

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
      head.append(el("span", "channel-name", c.name), el("span", "count", String(c.members.length)));
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
