const statusEl = document.querySelector("#status");
const captions = document.querySelector("#captions");
const options = document.querySelector("#options");
const log = document.querySelector("#log");
const form = document.querySelector("#composer");
const text = document.querySelector("#text");
const mic = document.querySelector("#mic");
const stop = document.querySelector("#stop");
const checkout = document.querySelector("#checkout");
const checkoutText = document.querySelector("#checkout-text");
const confirmBtn = document.querySelector("#confirm");

let ws = null;
let checkoutTotal = null;
connect();

function connect() {
  ws = new WebSocket("ws://localhost:8787");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    statusEl.textContent = "Connected";
    send({ type: "hello", protocol: 1, userId: "demo-user", client: "extension" });
  };
  ws.onclose = () => {
    statusEl.textContent = "Reconnecting…";
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {
    statusEl.textContent = "Can't reach ws://localhost:8787";
  };
  ws.onmessage = onMessage;
}

let ttsChunks = [];
let ttsRate = 24000;
let ttsOn = false;
let audioCtx = null;
let nextTime = 0;
let micStream = null;
let micNode = null;
let micCtx = null;

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
    statusEl.textContent = msg.state.phase;
    options.replaceChildren();
    for (const item of msg.state.shortlist ?? []) {
      const li = document.createElement("li");
      const dollars = (item.product.price.cents / 100).toFixed(2);
      li.textContent = `${item.product.title} — $${dollars}`;
      options.append(li);
    }
  } else if (msg.type === "progress") {
    statusEl.textContent = msg.event.message;
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

stop.addEventListener("click", () => send({ type: "user.interrupt" }));
confirmBtn.addEventListener("click", () => {
  if (!checkoutTotal) return;
  send({ type: "checkout.confirm", total: checkoutTotal });
});

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = text.value.trim();
  if (!value) return;
  send({ type: "user.text", text: value });
  text.value = "";
});

mic.addEventListener("pointerdown", () => startMic());
mic.addEventListener("pointerup", () => stopMic());
mic.addEventListener("pointercancel", () => stopMic());

async function startMic() {
  if (mic.getAttribute("aria-pressed") === "true") return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micCtx = new AudioContext();
  const source = micCtx.createMediaStreamSource(micStream);
  micNode = micCtx.createScriptProcessor(4096, 1, 1);
  const gain = micCtx.createGain();
  gain.gain.value = 0;
  source.connect(micNode);
  micNode.connect(gain);
  gain.connect(micCtx.destination);
  send({ type: "audio.start", format: { encoding: "pcm_s16le", sampleRate: 16000 } });
  mic.setAttribute("aria-pressed", "true");
  micNode.onaudioprocess = (e) => {
    const pcm = downsample(e.inputBuffer.getChannelData(0), micCtx.sampleRate, 16000);
    if (pcm.byteLength && ws.readyState === WebSocket.OPEN) ws.send(pcm);
  };
}

function stopMic() {
  if (mic.getAttribute("aria-pressed") !== "true") return;
  mic.setAttribute("aria-pressed", "false");
  micNode?.disconnect();
  micStream?.getTracks().forEach((t) => t.stop());
  micCtx?.close();
  micNode = null;
  micStream = null;
  micCtx = null;
  send({ type: "audio.end" });
}

function downsample(input, inRate, outRate) {
  const ratio = inRate / outRate;
  const len = Math.floor(input.length / ratio);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

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
