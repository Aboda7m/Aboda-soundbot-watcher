
const root = document.getElementById("root");
const statusEl = document.getElementById("status");
const soundSelect = document.getElementById("sound");
const nowEl = document.getElementById("now");

let botReady = false;
let playbackState = { playing: [] };

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

function button(className, text, dataset = {}) {
  const node = el("button", className, text);
  node.type = "button";

  for (const [key, value] of Object.entries(dataset)) {
    node.dataset[key] = value;
  }

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
    li.append(
      el("span", "avatar initial", (m.name || "?").slice(0, 1).toUpperCase()),
    );
  }

  li.append(el("span", "name", m.name || "Unknown member"));

  const tags = el("span", "tags");

  if (m.bot) tags.append(el("span", "tag", "bot"));
  if (m.streaming) tags.append(el("span", "tag live", "streaming"));
  if (m.camera) tags.append(el("span", "tag live", "camera"));
  if (m.deafened) tags.append(el("span", "tag", "deafened"));
  else if (m.muted) tags.append(el("span", "tag", "muted"));

  if (tags.children.length) li.append(tags);

  return li;
}

function getPlaying(pb = playbackState) {
  return Array.isArray(pb?.playing) ? pb.playing : [];
}

function getGuildId(entry) {
  return entry?.guildId ?? entry?.guild?.id ?? entry?.id ?? "";
}

function showPlayback(pb) {
  if (pb) playbackState = pb;

  const playing = getPlaying();
  const now = playing
    .filter((p) => p.current)
    .map((p) => p.current.sound);

  const queued = playing.reduce(
    (total, p) => total + (Number(p.queued) || 0),
    0,
  );

  nowEl.className = "now";
  nowEl.textContent = now.length
    ? `Playing: ${now.join(", ")}${queued ? ` (+${queued} queued)` : ""}`
    : queued
      ? `${queued} sound${queued === 1 ? "" : "s"} queued`
      : "";
}

function renderQueue() {
  const panel = el("section", "queue-panel");
  panel.append(el("h2", "", "Sound queue"));

  const entries = getPlaying();

  if (!entries.length) {
    panel.append(el("p", "empty", "Nothing is playing or queued."));
    return panel;
  }

  let hasItems = false;

  for (const entry of entries) {
    const guildId = getGuildId(entry);
    const current = entry.current || null;
    const items = Array.isArray(entry.items) ? entry.items : [];
    const queuedCount = Number(entry.queued) || items.length;

    if (!current && items.length === 0 && queuedCount === 0) continue;

    hasItems = true;

    const group = el("div", "queue-guild");
    group.append(el("h3", "", entry.guildName || entry.name || `Server ${guildId || ""}`));

    if (current) {
      const currentRow = el("div", "queue-current");
      currentRow.append(
        el("span", "queue-label", "Now playing"),
        el("span", "queue-sound", current.sound || "Unknown sound"),
      );

      const skip = button("queue-action", "Skip current", {
        action: "skip",
        guild: guildId,
      });

      skip.disabled = !guildId;
      currentRow.append(skip);
      group.append(currentRow);
    }

    if (items.length) {
      const list = el("ol", "queue-list");

      for (const item of items) {
        const row = el("li", "queue-item");
        row.append(el("span", "queue-sound", item.sound || "Unknown sound"));

        const remove = button("queue-action danger", "Remove", {
          action: "remove",
          guild: guildId,
          queueId: item.id || "",
        });

        remove.disabled = !guildId || !item.id;
        remove.title = item.id ? "Remove this queued sound" : "Queue item has no ID";
        row.append(remove);
        list.append(row);
      }

      group.append(list);
    } else if (queuedCount > 0) {
      group.append(
        el("p", "empty", `${queuedCount} queued sound(s), but item details are unavailable.`),
      );
    }

    if (queuedCount > 0) {
      const clear = button("queue-action danger", "Clear pending", {
        action: "clear-pending",
        guild: guildId,
      });

      clear.disabled = !guildId;
      group.append(clear);
    }

    panel.append(group);
  }

  if (!hasItems) {
    panel.append(el("p", "empty", "Nothing is playing or queued."));
  }

  return panel;
}

function render(snap) {
  botReady = Boolean(snap.ready);

  setStatus(
    snap.ready ? "live" : "connecting",
    snap.ready ? "Live" : "Bot reconnecting",
  );

  showPlayback(snap.playback);
  document.title = snap.total ? `(${snap.total}) Voice` : "Voice";

  root.replaceChildren();

  if (!Array.isArray(snap.guilds) || !snap.guilds.length) {
    root.append(el("p", "empty", "No one is in a voice channel."));
  } else {
    for (const g of snap.guilds) {
      const section = el("section", "guild");
      section.append(el("h2", "", g.name));

      for (const c of g.channels) {
        const box = el("div", "channel");
        const head = el("div", "channel-head");

        const play = button("play", "Play here", {
          guild: g.id,
          channel: c.id,
        });

        play.disabled = !soundSelect.value;

        head.append(
          el("span", "channel-name", c.name),
          el("span", "count", String(c.members.length)),
          play,
        );

        const list = el("ul");

        for (const m of c.members) {
          list.append(memberRow(m));
        }

        box.append(head, list);
        section.append(box);
      }

      root.append(section);
    }
  }

  root.append(renderQueue());
}

// Fetch the authoritative queue status from the server.
async function refreshPlayback() {
  const res = await fetch("/api/status" + location.search, {
    headers: authHeaders,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Could not refresh queue (${res.status})`);
  }

  const data = await res.json();
  showPlayback(data.playback);

  // Update the queue controls without rebuilding the voice member list.
  const oldPanel = root.querySelector(".queue-panel");

  if (oldPanel) {
    oldPanel.replaceWith(renderQueue());
  } else {
    root.append(renderQueue());
  }
}

// Pass ?key=... through so the page works when an ACCESS_KEY is set.
const es = new EventSource("/events" + location.search);

es.onmessage = (e) => {
  try {
    render(JSON.parse(e.data));
  } catch (err) {
    console.error("Invalid voice update:", err);
  }
};

es.onopen = () => {
  setStatus(
    botReady ? "live" : "connecting",
    botReady ? "Live" : "Connecting",
  );
};

es.onerror = () => setStatus("down", "Disconnected, retrying");

async function loadSounds() {
  try {
    const res = await fetch("/api/sounds" + location.search, {
      headers: authHeaders,
    });

    if (!res.ok) throw new Error(String(res.status));

    const { sounds } = await res.json();

    soundSelect.replaceChildren(
      ...sounds.map((s) => new Option(s.name, s.name)),
    );

    if (!sounds.length) {
      soundSelect.replaceChildren(new Option("No sounds found", ""));
    }

    soundSelect.disabled = sounds.length === 0;

    for (const b of root.querySelectorAll("button.play")) {
      b.disabled = !soundSelect.value;
    }
  } catch (err) {
    console.error("Failed to load sounds:", err);
    soundSelect.replaceChildren(new Option("Sounds unavailable", ""));
    soundSelect.disabled = true;
  }
}

async function postJson(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reasons = {
      "queue-full": "Queue is full",
      duplicate: "Already queued",
    };

    throw new Error(
      body.error ||
        reasons[body.reason] ||
        `Request failed (${res.status})`,
    );
  }

  return body;
}

function showError(message) {
  nowEl.className = "now error";
  nowEl.textContent = message;
}

// Handle playback and queue actions through one delegated listener.
root.addEventListener("click", async (e) => {
  const target = e.target instanceof Element ? e.target : null;
  const btn = target?.closest("button");

  if (!btn || btn.disabled) return;

  if (btn.matches("button.play")) {
    if (!soundSelect.value) return;

    btn.disabled = true;

    try {
      await postJson("/api/play", {
        sound: soundSelect.value,
        guildId: btn.dataset.guild,
        channelId: btn.dataset.channel,
      });

      nowEl.className = "now";
      nowEl.textContent = "Sound added to the queue.";

      await refreshPlayback();
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = !soundSelect.value;
    }

    return;
  }

  const action = btn.dataset.action;
  if (!action) return;

  const guildId = btn.dataset.guild;
  if (!guildId) {
    showError("Could not identify the server.");
    return;
  }

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Working...";

  try {
    if (action === "remove") {
      await postJson("/api/queue/remove", {
        guildId,
        id: btn.dataset.queueId,
      });
    } else if (action === "skip") {
      await postJson("/api/queue/skip", { guildId });
    } else if (action === "clear-pending") {
      await postJson("/api/queue/clear-pending", { guildId });
    } else {
      throw new Error("Unknown queue action.");
    }

    nowEl.className = "now";
    nowEl.textContent =
      action === "remove"
        ? "Queued sound removed."
        : action === "skip"
          ? "Skipped current sound."
          : "Pending queue cleared.";

    await refreshPlayback();
  } catch (err) {
    showError(err.message);

    btn.disabled = false;
    btn.textContent = originalText;
  }
});

loadSounds();

refreshPlayback().catch((err) => {
  console.warn("Initial queue refresh failed:", err);
});
