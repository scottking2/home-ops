const params = new URLSearchParams(window.location.search);
const callId = params.get("callId") || "";
const scheduleId = params.get("scheduleId") || "";
const token = params.get("token") || "";

const els = {
  stage: document.querySelector("#callStage"),
  personaLabel: document.querySelector("#personaLabel"),
  statusTitle: document.querySelector("#statusTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  topicHint: document.querySelector("#topicHint"),
  errorBox: document.querySelector("#errorBox"),
  startBtn: document.querySelector("#startBtn"),
  answerBtn: document.querySelector("#answerBtn"),
  declineBtn: document.querySelector("#declineBtn"),
  hangupBtn: document.querySelector("#hangupBtn"),
  remoteAudio: document.querySelector("#remoteAudio"),
  avatarRing: document.querySelector("#avatarRing")
};

const session = {
  pc: null,
  localStream: null,
  dc: null,
  call: null,
  persona: null,
  clientSecret: null,
  ringTimer: null,
  ringAudio: null,
  connected: false
};

if (!token || (!callId && !scheduleId)) {
  setError("Missing call link. Open this page from Cruise Caller.");
  els.startBtn.disabled = true;
}

els.startBtn.addEventListener("click", startRinging);
els.answerBtn.addEventListener("click", answerCall);
els.declineBtn.addEventListener("click", () => endCall("declined"));
els.hangupBtn.addEventListener("click", () => endCall("completed"));

window.addEventListener("beforeunload", () => {
  stopRingTone();
  cleanupMedia();
});

function setPhase(phase) {
  els.stage.dataset.phase = phase;
  els.startBtn.classList.toggle("hidden", phase !== "idle");
  els.answerBtn.classList.toggle("hidden", phase !== "ringing");
  els.declineBtn.classList.toggle("hidden", phase !== "ringing");
  els.hangupBtn.classList.toggle("hidden", phase !== "live");
}

function setStatus(title, detail) {
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
}

function setError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.toggle("hidden", !message);
}

async function startRinging() {
  setError("");
  setPhase("ringing");
  setStatus("Incoming cruise call…", "Ringing. Tap Answer when you’re ready.");
  els.avatarRing.classList.add("ringing");
  playRingTone();

  // Auto-answer after a few rings if nobody taps — still feels like a call.
  const ringMs = 4500;
  session.ringTimer = window.setTimeout(() => {
    // Keep ringing until they answer or decline; do not force-connect.
  }, ringMs);
}

async function answerCall() {
  try {
    stopRingTone();
    if (session.ringTimer) window.clearTimeout(session.ringTimer);
    setPhase("connecting");
    setStatus("Connecting…", "Getting mic and starting the voice session.");
    els.avatarRing.classList.remove("ringing");
    els.avatarRing.classList.add("live");

    const mint = await mintSession();
    session.call = mint.call;
    session.persona = mint.persona;
    session.clientSecret = mint.clientSecret;
    els.personaLabel.textContent = mint.persona?.name || "Cruise Caller";
    els.topicHint.textContent = mint.call?.topic || "";

    if (!session.clientSecret) {
      throw new Error("No realtime client secret returned from server");
    }

    await connectWebRtc(session.clientSecret, mint.greetingHint);
    session.connected = true;
    setPhase("live");
    setStatus("You’re on the call", "Talk normally. Tap Hang up when finished.");
  } catch (error) {
    console.error(error);
    setError(error.message || "Could not connect call");
    setPhase("idle");
    setStatus("Call failed", "Check mic permissions and try again.");
    els.avatarRing.classList.remove("ringing", "live");
    cleanupMedia();
  }
}

async function mintSession() {
  const body = callId ? { callId, token } : { scheduleId, token };
  const response = await fetch("/api/browser-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Session mint failed (${response.status})`);
  }
  return data;
}

async function connectWebRtc(clientSecret, greetingHint) {
  const pc = new RTCPeerConnection();
  session.pc = pc;

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    els.remoteAudio.srcObject = stream || new MediaStream([event.track]);
  };

  session.localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  for (const track of session.localStream.getAudioTracks()) {
    pc.addTrack(track, session.localStream);
  }

  const dc = pc.createDataChannel("oai-events");
  session.dc = dc;
  dc.addEventListener("open", () => {
    // Ask the model to greet once the data channel is ready.
    dc.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            greetingHint ||
            "The browser call just connected after a ring. Greet the family briefly, say you are an AI cruise countdown caller, and ask which kid wants to talk first."
        }
      })
    );
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait briefly for ICE gathering so the SDP is more complete.
  await waitForIceGathering(pc, 1500);

  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    body: pc.localDescription.sdp,
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    }
  });

  if (!sdpResponse.ok) {
    const text = await sdpResponse.text();
    throw new Error(`Realtime WebRTC failed (${sdpResponse.status}): ${text.slice(0, 240)}`);
  }

  const answer = {
    type: "answer",
    sdp: await sdpResponse.text()
  };
  await pc.setRemoteDescription(answer);
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function endCall(status) {
  stopRingTone();
  if (session.ringTimer) window.clearTimeout(session.ringTimer);
  cleanupMedia();
  els.avatarRing.classList.remove("ringing", "live");

  if (session.call?.id && session.call?.token) {
    try {
      await fetch(`/api/calls/${encodeURIComponent(session.call.id)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.call.token, status })
      });
    } catch {
      // ignore hangup reporting failures
    }
  }

  setPhase("idle");
  setStatus(status === "declined" ? "Call declined" : "Call ended", "Tap Call to try again.");
  session.connected = false;
}

function cleanupMedia() {
  if (session.dc) {
    try {
      session.dc.close();
    } catch {
      // ignore
    }
  }
  if (session.pc) {
    try {
      session.pc.close();
    } catch {
      // ignore
    }
  }
  if (session.localStream) {
    for (const track of session.localStream.getTracks()) track.stop();
  }
  session.pc = null;
  session.dc = null;
  session.localStream = null;
  els.remoteAudio.srcObject = null;
}

function playRingTone() {
  stopRingTone();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  session.ringAudio = { ctx, timers: [] };

  const ringOnce = (startAt) => {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = "sine";
    osc2.type = "sine";
    osc1.frequency.value = 440;
    osc2.frequency.value = 480;
    gain.gain.value = 0.0001;
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime + startAt;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.03);
    gain.gain.setValueAtTime(0.08, t0 + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    osc1.start(t0);
    osc2.start(t0);
    osc1.stop(t0 + 1.15);
    osc2.stop(t0 + 1.15);
  };

  // Classic double-ring pattern.
  let offset = 0;
  for (let i = 0; i < 12; i += 1) {
    ringOnce(offset);
    ringOnce(offset + 0.35);
    offset += 2.2;
  }
}

function stopRingTone() {
  if (session.ringAudio?.ctx) {
    try {
      session.ringAudio.ctx.close();
    } catch {
      // ignore
    }
  }
  session.ringAudio = null;
}
