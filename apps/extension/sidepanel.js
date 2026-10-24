const statusEl = document.querySelector("#status");
const welcomeLine = document.querySelector("#welcome-line");
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
const talk = { timer: 0, utter: null, shown: 0, chars: [], token: 0, raf: 0 };
const pendingSay = new Map();
const revealTimers = new Set();
let paused = false;
let userName = "You";
let lastUserLine = "";
let lastSpeaker = "";
let ttsChunks = [];
let ttsRate = 24000;
let ttsOn = false;
let ttsId = "";
let audioCtx = null;
let nextTime = 0;
let playingCount = 0;
let listening = false;
let capturingMic = false;
let micStream = null;
let micCtx = null;
let micNode = null;
const MIC_RATE = 16000;

boot();

function startChat() {
  chatting = true;
  document.body.classList.add("chatting");
  paused = false;
  window.visyHold?.(false);
  stopTalk();
  lastUserLine = "";
  lastSpeaker = "";
  audioCtx ??= new AudioContext({ sampleRate: 24000 });
  void audioCtx.resume?.();
}

function showWelcome() {
  chatting = false;
  paused = false;
  window.visyHold?.(false);
  stopListening({ flush: false });
  document.body.classList.remove("chatting");
  options.replaceChildren();
  log.replaceChildren();
  lastSpeaker = "";
  welcomeLine.replaceChildren();
  helloWithName();
}

async function boot() {
  userName = (await getDisplayName()) || "You";
  audioCtx ??= new AudioContext({ sampleRate: 24000 });
  document.addEventListener(
    "pointerdown",
    () => {
      void audioCtx?.resume?.();
      void ensureMic();
    },
    true,
  );
  text.addEventListener("focus", () => {
    void audioCtx?.resume?.();
  });
  connect();
}

function helloWithName() {
  send({
    type: "hello",
    protocol: 1,
    userId: "demo-user",
    client: "extension",
    displayName: userName !== "You" ? userName : undefined,
  });
}

function stopVoice() {
  nextTime = 0;
  try {
    audioCtx?.close();
  } catch {
    /* ignore */
  }
  audioCtx = null;
}

function stopTalk() {
  clearInterval(talk.timer);
  talk.timer = 0;
  if (talk.raf) cancelAnimationFrame(talk.raf);
  talk.raf = 0;
  talk.token += 1;
  talk.utter = null;
  for (const t of revealTimers) {
    clearTimeout(t);
    cancelAnimationFrame(t);
  }
  revealTimers.clear();
  for (const item of pendingSay.values()) clearTimeout(item.fallback);
  pendingSay.clear();
  stopVoice();
  paintGo();
}

function fillChars(el, phrase) {
  el.replaceChildren();
  return [...phrase].map((c) => {
    const span = document.createElement("span");
    span.className = c === " " ? "ch space" : "ch";
    span.textContent = c === " " ? "\u00a0" : c;
    el.append(span);
    return span;
  });
}

function revealChars(chars, shown, n) {
  const end = Math.min(n, chars.length);
  while (shown.value < end) {
    chars[shown.value].classList.add("on");
    shown.value += 1;
  }
}

function playWithAudio(el, phrase, played) {
  if (!played) return;
  const chars = fillChars(el, phrase);
  const shown = { value: 0 };
  const { ctx, start, duration } = played;
  const tick = () => {
    if (paused) {
      const id = requestAnimationFrame(tick);
      revealTimers.add(id);
      return;
    }
    if (ctx.state === "closed") return;
    const elapsed = Math.max(0, ctx.currentTime - start);
    revealChars(chars, shown, Math.ceil((elapsed / Math.max(duration, 0.05)) * chars.length));
    log.scrollTop = log.scrollHeight;
    if (shown.value >= chars.length || elapsed >= duration) {
      revealChars(chars, shown, chars.length);
      paintGo();
      return;
    }
    const id = requestAnimationFrame(tick);
    revealTimers.add(id);
  };
  const delay = Math.max(0, start - ctx.currentTime);
  const wait = setTimeout(() => {
    revealTimers.delete(wait);
    tick();
  }, delay * 1000);
  revealTimers.add(wait);
  paintGo();
}

function sparkOnly(el, phrase) {
  const chars = fillChars(el, phrase);
  let i = 0;
  const tick = () => {
    if (i >= chars.length) return;
    if (paused) {
      setTimeout(tick, 40);
      return;
    }
    chars[i].classList.add("on");
    i += 1;
    setTimeout(tick, 18);
  };
  tick();
}

function beginSay(id, phrase, onto) {
  pendingSay.set(id, {
    id,
    text: phrase,
    el: onto === "welcome" ? welcomeLine : null,
    done: false,
  });
}

function finishSay(item, bytes) {
  if (!item || item.done) return;
  const played = bytes && bytes.length > 1 ? playPcm(bytes, ttsRate) : null;
  if (!played) return;
  item.done = true;
  pendingSay.delete(item.id);
  if (!item.el) item.el = addTurn("Visy");
  playWithAudio(item.el, item.text, played);
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

function isPlaying() {
  return Boolean(busy || pendingSay.size || revealTimers.size || listening || playingCount);
}

function paintGo() {
  const stop = isPlaying() && !paused;
  go.classList.toggle("busy", stop);
  const label = paused ? "Resume" : stop ? "Stop" : "Send";
  go.setAttribute("aria-label", label);
  go.title = label;
}

function pauseAll() {
  if (paused) return;
  paused = true;
  void audioCtx?.suspend?.();
  void micCtx?.suspend?.();
  window.visyHold?.(true);
  paintGo();
}

function resumeAll() {
  if (!paused) return;
  paused = false;
  void audioCtx?.resume?.();
  void micCtx?.resume?.();
  window.visyHold?.(false);
  paintGo();
  maybeListen();
}

function setBusy(next) {
  busy = next;
  paintGo();
  if (!next) maybeListen();
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
    helloWithName();
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

function addTurn(who) {
  const p = document.createElement("p");
  p.className = who === "Visy" ? "visy" : "you";
  if (who !== lastSpeaker) {
    const label = document.createElement("span");
    label.className = "who";
    label.textContent = `${who} :`;
    p.append(label);
    lastSpeaker = who;
  }
  const msg = document.createElement("span");
  msg.className = "said";
  p.append(msg);
  log.append(p);
  log.scrollTop = log.scrollHeight;
  return msg;
}

function line(who, message) {
  if (who !== "Visy") {
    if (message === lastUserLine) return;
    lastUserLine = message;
    who = userName;
  }
  sparkOnly(addTurn(who), message);
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
    beginSay(msg.id, msg.text, chatting ? "chat" : "welcome");
  } else if (msg.type === "transcript") {
    line("You", msg.text);
  } else if (msg.type === "tts.start") {
    ttsOn = true;
    ttsId = msg.id;
    ttsChunks = [];
    ttsRate = msg.format.sampleRate;
  } else if (msg.type === "tts.end") {
    ttsOn = false;
    const bytes = concat(ttsChunks);
    ttsChunks = [];
    finishSay(pendingSay.get(msg.id) ?? pendingSay.get(ttsId), bytes);
    ttsId = "";
  } else if (msg.type === "tts.stop") {
    ttsOn = false;
    ttsId = "";
    ttsChunks = [];
    if (chatting) stopTalk();
  } else if (msg.type === "session.snapshot") {
    setBusy(WORKING.has(msg.state.phase));
    if (!WORKING.has(msg.state.phase)) maybeListen();
    options.replaceChildren();
    for (const item of msg.state.shortlist ?? []) {
      const li = document.createElement("li");
      const dollars = (item.product.price.cents / 100).toFixed(2);
      sparkOnly(li, `${item.product.title} — $${dollars}`);
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
    sparkOnly(checkoutText, msg.review.readBack);
  } else if (msg.type === "error") {
    beginSay(`err-${Date.now()}`, msg.error.message);
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
  const value = text.value.trim();
  if (!value) {
    if (paused) {
      resumeAll();
      return;
    }
    if (isPlaying()) {
      pauseAll();
      return;
    }
    showWelcome();
    return;
  }
  if (paused) resumeAll();
  stopListening({ flush: false });
  if (busy) send({ type: "user.interrupt" });
  startChat();
  line(userName, value);
  send({ type: "user.text", text: value });
  text.value = "";
  setBusy(true);
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
  if (bytes.length < 2) return null;
  stopListening({ flush: false });
  audioCtx ??= new AudioContext({ sampleRate: rate });
  if (audioCtx.state === "suspended") void audioCtx.resume();
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
  playingCount += 1;
  src.onended = () => {
    playingCount = Math.max(0, playingCount - 1);
    maybeListen();
  };
  return { ctx: audioCtx, start, duration: buffer.duration };
}

async function ensureMic() {
  if (micStream) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    return true;
  } catch {
    return false;
  }
}

function maybeListen() {
  if (paused || busy || ttsOn || pendingSay.size || playingCount > 0) return;
  void startListening();
}

async function startListening() {
  if (listening || paused || busy || ttsOn || pendingSay.size || playingCount > 0) return;
  if (!(await ensureMic())) return;
  if (listening || paused || busy) return;
  listening = true;
  capturingMic = true;
  micCtx = new AudioContext({ sampleRate: MIC_RATE });
  const src = micCtx.createMediaStreamSource(micStream);
  const proc = micCtx.createScriptProcessor(4096, 1, 1);
  const mute = micCtx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(micCtx.destination);
  micNode = proc;
  const inRate = micCtx.sampleRate;
  send({ type: "audio.start", format: { encoding: "pcm_s16le", sampleRate: MIC_RATE } });
  let heard = false;
  let silence = 0;
  proc.onaudioprocess = (ev) => {
    if (!capturingMic || paused) return;
    const input = downsample(ev.inputBuffer.getChannelData(0), inRate, MIC_RATE);
    if (ws?.readyState === WebSocket.OPEN) ws.send(floatToS16(input).buffer);
    const rms = rmsOf(input);
    const dt = input.length / MIC_RATE;
    if (rms > 0.018) {
      heard = true;
      silence = 0;
    } else if (heard) {
      silence += dt;
      if (silence > 0.75) endUtterance();
    }
  };
  paintGo();
}

function endUtterance() {
  if (!capturingMic) return;
  stopListening({ flush: true });
  if (!chatting) startChat();
  setBusy(true);
}

function stopListening({ flush = false } = {}) {
  const was = capturingMic;
  capturingMic = false;
  listening = false;
  if (micNode) {
    try {
      micNode.disconnect();
    } catch {
      /* ignore */
    }
    micNode.onaudioprocess = null;
    micNode = null;
  }
  if (micCtx) {
    void micCtx.close();
    micCtx = null;
  }
  if (was && flush) send({ type: "audio.end" });
  paintGo();
}

function downsample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0;
  return out;
}

function floatToS16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function rmsOf(input) {
  let n = 0;
  for (let i = 0; i < input.length; i++) n += (input[i] ?? 0) ** 2;
  return Math.sqrt(n / Math.max(input.length, 1));
}
