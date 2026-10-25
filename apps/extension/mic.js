const allow = document.querySelector("#allow");
const err = document.querySelector("#err");

async function ask() {
  err.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    for (const track of stream.getTracks()) track.stop();
    chrome.runtime.sendMessage({ type: "visy.mic.granted" });
    window.close();
  } catch {
    err.textContent = "Allow the microphone in the Chrome prompt, then try again.";
  }
}

allow.addEventListener("click", ask);
// Ask on open, so the only click left is Chrome's own Allow (A-VOICE).
void ask();
