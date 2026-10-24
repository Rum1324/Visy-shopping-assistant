const allow = document.querySelector("#allow");
const err = document.querySelector("#err");

allow.addEventListener("click", async () => {
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
});
