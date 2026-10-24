const statusEl = document.querySelector("#status");
const welcomeHi = document.querySelector("#welcome-hi");
const captions = document.querySelector("#captions");
const options = document.querySelector("#options");
const log = document.querySelector("#log");
const form = document.querySelector("#composer");
const text = document.querySelector("#text");
const go = document.querySelector("#go");
const checkout = document.querySelector("#checkout");
const checkoutText = document.querySelector("#checkout-text");
const confirmBtn = document.querySelector("#confirm");

let ws = null;
let checkoutTotal = null;
let busy = false;
let chatting = false;
const WORKING = new Set(["clarifying", "searching", "shortlisting"]);
paintWelcome();
connect();

function startChat() {
  chatting = true;
  document.body.classList.add("chatting");
}

function showWelcome() {
  chatting = false;
  document.body.classList.remove("chatting");
  captions.textContent = "";
  options.replaceChildren();
  log.replaceChildren();
}

async function paintWelcome() {
  const name = await getDisplayName();
  welcomeHi.textContent = name ? `Hi ${name}` : "Hi";
}

async function getDisplayName() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    const local = info?.email?.split("@")[0] ?? "";
    const token = local.split(/[._+-]/)[0]?.replace(/\d+$/, "") ?? "";
    if (!token) return "";
    return token.charAt(0).toUpperCase() + token.slice(1);
  } catch {
    return "";
  }
}

function setBusy(next) {
  busy = next;
  go.classList.toggle("busy", busy);
  go.setAttribute("aria-label", busy ? "Stop" : "Send");
  go.title = busy ? "Stop" : "Send";
}

function showLink(message) {
  statusEl.hidden = !message;
  statusEl.textContent = message ?? "";
}

function connect() {
  ws = new WebSocket("ws://localhost:8787");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    showLink(null);
    send({ type: "hello", protocol: 1, userId: "demo-user", client: "extension" });
  };
  ws.onclose = () => {
    showLink("Reconnecting…");
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {
    showLink("Reconnecting…");
  };
  ws.onmessage = onMessage;
}

let ttsChunks = [];
let ttsRate = 24000;
let ttsOn = false;
let audioCtx = null;
let nextTime = 0;

function line(who, message) {
  const p = document.createElement("p");
  p.textContent = `${who}: ${message}`;
  log.append(p);
  log.scrollTop = log.scrollHeight;
}

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function onMessage(ev) {
  if (typeof ev.data !== "string") {
    if (ttsOn) ttsChunks.push(new Uint8Array(ev.data));
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.type === "agent.say") {
    if (!chatting) return;
    captions.textContent = msg.text;
    line("Visy", msg.text);
  } else if (msg.type === "transcript") {
    line("You", msg.text);
  } else if (msg.type === "tts.start") {
    ttsOn = true;
    ttsChunks = [];
    ttsRate = msg.format.sampleRate;
  } else if (msg.type === "tts.end") {
    ttsOn = false;
    playPcm(concat(ttsChunks), ttsRate);
    ttsChunks = [];
  } else if (msg.type === "tts.stop") {
    ttsOn = false;
    ttsChunks = [];
    nextTime = 0;
    audioCtx?.close();
    audioCtx = null;
  } else if (msg.type === "session.snapshot") {
    setBusy(WORKING.has(msg.state.phase));
    options.replaceChildren();
    for (const item of msg.state.shortlist ?? []) {
      const li = document.createElement("li");
      const dollars = (item.product.price.cents / 100).toFixed(2);
      li.textContent = `${item.product.title} — $${dollars}`;
      options.append(li);
    }
  } else if (msg.type === "progress") {
    setBusy(true);
  } else if (msg.type === "driver.request") {
    const res = await chrome.runtime.sendMessage({ type: "visy.driver", req: msg.req });
    send({
      type: "driver.response",
      id: msg.id,
      ok: !!res?.ok,
      data: res?.data,
      error: res?.ok ? undefined : res?.error ?? { code: "internal", message: "Driver failed", retryable: true },
    });
  } else if (msg.type === "checkout.confirmRequired") {
    checkout.hidden = false;
    checkoutTotal = msg.review.total;
    checkoutText.textContent = msg.review.readBack;
  } else if (msg.type === "error") {
    line("Error", msg.error.message);
  }
  if (msg.type === "session.snapshot" && msg.state.phase !== "checkout_review") {
    checkout.hidden = true;
  }
}

confirmBtn.addEventListener("click", () => {
  if (!checkoutTotal) return;
  send({ type: "checkout.confirm", total: checkoutTotal });
});

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (busy) {
    send({ type: "user.interrupt" });
    setBusy(false);
    return;
  }
  const value = text.value.trim();
  if (value) {
    startChat();
    send({ type: "user.text", text: value });
    text.value = "";
    setBusy(true);
    return;
  }
  showWelcome();
  send({ type: "hello", protocol: 1, userId: "demo-user", client: "extension" });
});

function concat(chunks) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function playPcm(bytes, rate) {
  if (bytes.length < 2) return;
  audioCtx ??= new AudioContext({ sampleRate: rate });
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const buffer = audioCtx.createBuffer(1, samples.length, rate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = (samples[i] ?? 0) / 32768;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);
  const start = Math.max(audioCtx.currentTime, nextTime);
  src.start(start);
  nextTime = start + buffer.duration;
}
