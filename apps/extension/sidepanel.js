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
const micBtn = document.querySelector("#mic");

let ws = null;
let checkoutTotal = null;
let busy = false;
let chatting = false;
// "clarifying" is Visy waiting for the user's answer, so it is not working.
const WORKING = new Set(["searching", "shortlisting", "carting"]);
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
let micOn = true; // A-STT: hands-free by default; the mic button mutes
let capturingMic = false; // streaming a turn to the server right now
let micStream = null;
let micCtx = null;
let micNode = null;
let micLevel = 0;
let preroll = []; // the last second of mic audio while Visy is quiet, so the start of a turn isn't cut off
let prerollSamples = 0;
const PREROLL_SAMPLES = 16000; // 1 s at MIC_RATE
let listenTimer = 0;
let listenBackoffUntil = 0;
let toneCtx = null;
let dictating = false; // the input box is showing live words, not something the user typed
let owesChime = true; // play the listen tone once each time it becomes the user's turn
let chimeTimer = 0;
let lastFinal = { text: "", at: 0 };
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
  stopListening();
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
      void micCtx?.resume?.();
      void toneCtx?.resume?.();
      maybeListen();
    },
    true,
  );
  micBtn.addEventListener("click", () => setMicOn(!micOn));
  text.addEventListener("input", () => {
    dictating = false;
    text.classList.remove("dictating");
  });
  paintMic();
  requestAnimationFrame(paintLevel);
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
  playingCount = 0; // a closed context never fires onended
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
  let raf = 0;
  const tick = () => {
    revealTimers.delete(raf); // finished frames must not keep isPlaying() true
    if (paused) {
      raf = requestAnimationFrame(tick);
      revealTimers.add(raf);
      return;
    }
    if (ctx.state === "closed") return;
    const elapsed = Math.max(0, ctx.currentTime - start);
    revealChars(chars, shown, Math.ceil((elapsed / Math.max(duration, 0.05)) * chars.length));
    log.scrollTop = log.scrollHeight;
    if (shown.value >= chars.length || elapsed >= duration) {
      revealChars(chars, shown, chars.length);
      paintGo();
      maybeListen();
      return;
    }
    raf = requestAnimationFrame(tick);
    revealTimers.add(raf);
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
  item.done = true;
  pendingSay.delete(item.id);
  if (!item.el) item.el = addTurn("Visy");
  // TTS failed: show the words anyway, and don't leave the mic waiting on audio that never comes.
  if (!played) {
    sparkOnly(item.el, item.text);
    maybeListen();
    return;
  }
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
  return Boolean(busy || pendingSay.size || revealTimers.size || playingCount);
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
  stopListening();
  void audioCtx?.suspend?.();
  window.visyHold?.(true);
  paintGo();
}

function resumeAll() {
  if (!paused) return;
  paused = false;
  void audioCtx?.resume?.();
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
    maybeListen();
  };
  ws.onclose = () => {
    capturingMic = false;
    paintMic();
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
    if (!msg.final) showHeard(msg.text);
    else if (capturingMic) turnHeard(msg.text);
    else line("You", msg.text);
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
    stopTalk(); // barge-in: Visy goes quiet the moment the server cancels its turn
    maybeListen();
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
    // Shown, not queued as speech: a pending say with no audio would keep the mic closed.
    if (capturingMic) {
      capturingMic = false;
      listenBackoffUntil = Date.now() + 3000;
      showHeard("");
      paintMic();
    }
    sparkOnly(addTurn("Visy"), msg.error.message);
    maybeListen();
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
  if (busy) send({ type: "user.interrupt" });
  startChat();
  lastFinal = { text: value, at: Date.now() };
  owesChime = true;
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

let askingMic = false;
let micOpening = null;

/** Opens the mic once and keeps it open while unmuted. Frames go to the server only while capturingMic. */
function ensureMic() {
  if (micStream && micCtx) return Promise.resolve(true);
  micOpening ??= openMic().finally(() => {
    micOpening = null;
  });
  return micOpening;
}

async function openMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    void askMicTab();
    return false;
  }
  if (!micOn) {
    for (const t of stream.getTracks()) t.stop();
    return false;
  }
  let ctx;
  let src;
  try {
    ctx = new AudioContext({ sampleRate: MIC_RATE });
    src = ctx.createMediaStreamSource(stream);
  } catch {
    void ctx?.close();
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(stream);
  }
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(proc);
  proc.connect(sink);
  sink.connect(ctx.destination);
  const inRate = ctx.sampleRate;
  proc.onaudioprocess = (ev) => {
    const input = downsample(ev.inputBuffer.getChannelData(0), inRate, MIC_RATE);
    micLevel = Math.max(rmsOf(input), micLevel * 0.85);
    const pcm = floatToS16(input);
    if (capturingMic) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
    } else if (playingCount === 0 && !paused) {
      preroll.push(pcm);
      prerollSamples += pcm.length;
      while (prerollSamples > PREROLL_SAMPLES) prerollSamples -= preroll.shift().length;
    } else {
      clearPreroll(); // never send Visy's own voice
    }
  };
  micStream = stream;
  micCtx = ctx;
  micNode = proc;
  void ctx.resume();
  return true;
}

function clearPreroll() {
  preroll = [];
  prerollSamples = 0;
}

/** Muted means the track is stopped: the browser captures nothing and the mic light goes off. */
function closeMic() {
  if (micNode) {
    micNode.onaudioprocess = null;
    try {
      micNode.disconnect();
    } catch {
      /* ignore */
    }
  }
  for (const t of micStream?.getTracks() ?? []) t.stop();
  void micCtx?.close();
  micNode = null;
  micStream = null;
  micCtx = null;
  micLevel = 0;
  clearPreroll();
}

function setMicOn(next) {
  micOn = next;
  if (!micOn) {
    stopListening();
    closeMic();
    tone("mute");
  } else {
    listenBackoffUntil = 0;
    owesChime = true; // chimes as soon as the mic is open and Visy is quiet
    void ensureMic().then((ok) => ok && maybeListen());
  }
  paintMic();
}

async function askMicTab() {
  if (askingMic || !chrome.tabs?.create) return;
  askingMic = true;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html"), active: true });
  } catch {
    askingMic = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "visy.mic.granted") return;
  askingMic = false;
  if (micOn) void ensureMic().then((ok) => ok && maybeListen());
});

function canListen() {
  return micOn && !capturingMic && !paused && ws?.readyState === WebSocket.OPEN;
}

/**
 * Hands-free: while unmuted the mic streams the whole time, Visy's own speech included
 * (echo cancellation plus the server's echo check keep Visy from hearing itself). Cartesia
 * finds the turns, so the user can talk over Visy to interrupt it.
 */
function maybeListen() {
  clearTimeout(listenTimer);
  if (canListen()) listenTimer = setTimeout(() => void startListening(), Math.max(0, listenBackoffUntil - Date.now()));
  maybeChime();
}

async function startListening() {
  if (!canListen()) return;
  if (!(await ensureMic())) return;
  if (!canListen()) return;
  void micCtx?.resume?.();
  capturingMic = true;
  send({ type: "audio.start", format: { encoding: "pcm_s16le", sampleRate: MIC_RATE } });
  for (const b of preroll) ws.send(b.buffer);
  clearPreroll();
  paintMic();
  maybeChime();
}

function quietTurn() {
  return micOn && capturingMic && !paused && !busy && !ttsOn && !pendingSay.size && playingCount === 0 && !dictating;
}

/** Rising tone = your turn: Visy has finished talking and working. */
function maybeChime() {
  clearTimeout(chimeTimer);
  if (!owesChime || !quietTurn()) return;
  chimeTimer = setTimeout(() => {
    if (!owesChime || !quietTurn()) return;
    owesChime = false;
    tone("listen");
  }, 300);
}

/** Stop streaming (mute, pause, reset). The server drops anything unfinished. */
function stopListening() {
  clearTimeout(listenTimer);
  if (!capturingMic) return;
  capturingMic = false;
  send({ type: "audio.end" });
  showHeard("");
  paintMic();
}

/** Cartesia decided the user finished their turn. The mic keeps streaming for the next one. */
function turnHeard(said) {
  if (said === lastFinal.text && Date.now() - lastFinal.at < 8000) return; // the agent echoes it back
  lastFinal = { text: said, at: Date.now() };
  tone("done");
  showHeard("");
  if (!chatting) startChat();
  line(userName, said);
  owesChime = true;
  setBusy(true);
}

/** Live words go in the input box, like dictation. Never overwrites something the user typed. */
function showHeard(partial) {
  if (!dictating && text.value.trim()) return;
  dictating = Boolean(partial);
  text.value = partial;
  text.classList.toggle("dictating", dictating);
  if (partial) text.scrollLeft = text.scrollWidth;
}

function paintMic() {
  text.placeholder = !micOn ? "muted, type here" : capturingMic ? "listening…" : "type here";
  micBtn.classList.toggle("muted", !micOn);
  micBtn.classList.toggle("listening", micOn && capturingMic);
  micBtn.setAttribute("aria-pressed", String(!micOn));
  const label = !micOn ? "Microphone muted. Press to unmute." : capturingMic ? "Listening. Press to mute." : "Microphone on. Press to mute.";
  micBtn.setAttribute("aria-label", label);
  micBtn.title = !micOn ? "Unmute" : "Mute";
}

function paintLevel() {
  const v = capturingMic ? Math.min(1, micLevel * 9) : 0;
  micBtn.style.setProperty("--level", v.toFixed(3));
  micLevel *= 0.92;
  requestAnimationFrame(paintLevel);
}

/** Sound cues for users who can't see the screen: rising = listening, falling = got it, low = muted. */
function tone(kind) {
  try {
    toneCtx ??= new AudioContext();
    void toneCtx.resume();
    const notes = kind === "listen" ? [660, 990] : kind === "done" ? [880, 587] : [392];
    const t0 = toneCtx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const at = t0 + i * 0.09;
      const osc = toneCtx.createOscillator();
      const gain = toneCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.14, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(toneCtx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  } catch {
    /* no audio device */
  }
}

/** Box-filter downsample so a 48 kHz fallback context doesn't alias into the speech band. */
function downsample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j] ?? 0;
    out[i] = sum / Math.max(1, b - a);
  }
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
