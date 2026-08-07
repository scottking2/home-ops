import Fastify from "fastify";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_PATH = process.env.DATA_PATH || "/data/state.json";
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || "");
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
const OPENAI_WS_URL = process.env.OPENAI_REALTIME_WS_URL || "wss://api.openai.com/v1/realtime";
const DEFAULT_CALL_MINUTES = Number(process.env.DEFAULT_CALL_MINUTES || 6);
const MAX_CALL_MINUTES = Number(process.env.MAX_CALL_MINUTES || 12);

const personas = {
  clubhouse_captain: {
    id: "clubhouse_captain",
    name: "Clubhouse Captain",
    voice: "marin",
    color: "#1d7a8c",
    description: "Bright, upbeat, warm, and playful without copying any existing character.",
    style:
      "Use a bright, buoyant host voice with crisp diction, tiny laughs, and lots of wonder. Do not imitate or claim to be any Disney character."
  },
  storybook_mouse_host: {
    id: "storybook_mouse_host",
    name: "Storybook Mouse Host",
    voice: "shimmer",
    color: "#c73557",
    description: "Gentle, sweet, excited, and friendly for younger kids.",
    style:
      "Use a high-energy storybook-host vibe, sweet and encouraging. Keep it original and never imitate or name a protected character voice."
  },
  splashy_sailor: {
    id: "splashy_sailor",
    name: "Splashy Sailor",
    voice: "echo",
    color: "#2f66b3",
    description: "Silly nautical energy with quick jokes and sound effects.",
    style:
      "Use an animated sailor-adventure style with playful timing. Do not use a raspy duck impression or imitate any specific character."
  },
  goofy_navigator: {
    id: "goofy_navigator",
    name: "Goofy Navigator",
    voice: "verse",
    color: "#5f7d2d",
    description: "Big-hearted, clumsy, and enthusiastic.",
    style:
      "Use a warm, slightly bumbling navigator personality with gentle jokes. Keep the voice original and do not impersonate any named character."
  }
};

const defaultProfiles = [
  { id: "age_9", name: "9 year old", age: 9, notes: "Can handle trivia, ship facts, and countdown games." },
  { id: "age_6", name: "6 year old", age: 6, notes: "Likes short answers, silly choices, and simple questions." },
  { id: "age_1_5", name: "1.5 year old", age: 1.5, notes: "Use musical cadence, simple words, and parent-directed prompts." }
];

const state = {
  schedules: [],
  calls: [],
  settings: {
    defaultPhoneNumber: process.env.DEFAULT_TO_NUMBER || "",
    cruiseMonth: "November",
    cruiseShip: "Disney Treasure"
  }
};

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization", "req.headers.x-admin-token"]
  }
});

await fastify.register(websocket);
await fastify.register(staticFiles, {
  root: path.join(__dirname, "..", "public")
});

fastify.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  if (request.url === "/api/health") return;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return reply.code(503).send({ error: "ADMIN_TOKEN is not configured" });
  }
  const supplied = request.headers["x-admin-token"] || bearerToken(request.headers.authorization);
  if (supplied !== expected) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

fastify.get("/api/health", async () => ({ ok: true }));

fastify.get("/api/state", async () => ({
  personas,
  profiles: defaultProfiles,
  schedules: state.schedules,
  calls: state.calls.slice(0, 50),
  settings: state.settings,
  ready: readiness()
}));

fastify.post("/api/settings", async (request) => {
  state.settings = {
    ...state.settings,
    ...pick(request.body || {}, ["defaultPhoneNumber", "cruiseMonth", "cruiseShip"])
  };
  await saveState();
  return { settings: state.settings };
});

fastify.post("/api/calls", async (request, reply) => {
  const payload = request.body || {};
  const call = makeCallRecord({
    source: "manual",
    phoneNumber: payload.phoneNumber || state.settings.defaultPhoneNumber,
    personaId: payload.personaId,
    profileIds: payload.profileIds,
    topic: payload.topic,
    durationMinutes: payload.durationMinutes
  });

  if (!call.phoneNumber) return reply.code(400).send({ error: "phoneNumber is required" });
  state.calls.unshift(call);
  await saveState();
  await placeCall(call);
  return { call };
});

fastify.post("/api/schedules", async (request, reply) => {
  const payload = request.body || {};
  const scheduledFor = new Date(payload.scheduledFor);
  if (Number.isNaN(scheduledFor.valueOf())) {
    return reply.code(400).send({ error: "scheduledFor must be a valid date" });
  }
  if (!payload.phoneNumber && !state.settings.defaultPhoneNumber) {
    return reply.code(400).send({ error: "phoneNumber is required" });
  }
  const schedule = {
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    scheduledFor: scheduledFor.toISOString(),
    phoneNumber: payload.phoneNumber || state.settings.defaultPhoneNumber,
    personaId: validPersona(payload.personaId).id,
    profileIds: validProfileIds(payload.profileIds),
    topic: String(payload.topic || "Talk about our upcoming cruise and ask what they are excited about.").slice(0, 500),
    durationMinutes: clampCallMinutes(payload.durationMinutes)
  };
  state.schedules.unshift(schedule);
  await saveState();
  return { schedule };
});

fastify.delete("/api/schedules/:id", async (request, reply) => {
  const schedule = state.schedules.find((item) => item.id === request.params.id);
  if (!schedule) return reply.code(404).send({ error: "Not found" });
  schedule.status = "cancelled";
  schedule.cancelledAt = new Date().toISOString();
  await saveState();
  return { schedule };
});

fastify.get("/twilio/voice", async (request, reply) => {
  const call = lookupCall(request.query.callId, request.query.token);
  if (!call) {
    reply.type("text/xml");
    return twiml(`<Say voice="alice">Sorry, this cruise call is not available.</Say>`);
  }

  call.twilioCallSid = request.query.CallSid || call.twilioCallSid;
  call.status = "connected";
  call.connectedAt = new Date().toISOString();
  await saveState();

  const streamUrl = `${PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio/media?callId=${encodeURIComponent(call.id)}&token=${encodeURIComponent(call.token)}`;
  reply.type("text/xml");
  return twiml(`
    <Say voice="Polly.Joanna">Your cruise countdown call is connecting.</Say>
    <Connect>
      <Stream url="${escapeXml(streamUrl)}" />
    </Connect>
  `);
});

fastify.get("/twilio/status", async (request) => {
  const call = state.calls.find((item) => item.twilioCallSid === request.query.CallSid);
  if (call) {
    call.twilioStatus = request.query.CallStatus || call.twilioStatus;
    call.updatedAt = new Date().toISOString();
    await saveState();
  }
  return "OK";
});

fastify.get("/twilio/media", { websocket: true }, (socket, request) => {
  const call = lookupCall(request.query.callId, request.query.token);
  if (!call) {
    socket.close(1008, "invalid call token");
    return;
  }
  bridgeTwilioToOpenAI(socket, call).catch((error) => {
    fastify.log.error({ err: error, callId: call.id }, "media bridge failed");
    socket.close();
  });
});

await loadState();
setInterval(() => {
  runScheduler().catch((error) => fastify.log.error({ err: error }, "scheduler failed"));
}, 30_000).unref();

await fastify.listen({ host: HOST, port: PORT });

async function bridgeTwilioToOpenAI(twilioSocket, call) {
  const persona = validPersona(call.personaId);
  let streamSid = null;
  let greetingSent = false;
  let openaiReady = false;

  const openaiSocket = new WebSocket(`${OPENAI_WS_URL}?model=${encodeURIComponent(OPENAI_MODEL)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiSocket.on("open", () => {
    openaiReady = true;
    openaiSocket.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu", rate: 8000 },
            turn_detection: { type: "semantic_vad" }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: persona.voice
          }
        },
        instructions: buildInstructions(call, persona)
      }
    }));
  });

  openaiSocket.on("message", (data) => {
    const event = safeJson(data);
    if (!event) return;
    if ((event.type === "session.updated" || event.type === "session.created") && !greetingSent) {
      greetingSent = true;
      openaiSocket.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "The phone call has connected. Start with a short cheerful greeting, explain you are an AI cruise countdown caller, and ask which kid wants to answer first."
          }]
        }
      }));
      openaiSocket.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
    }

    if (event.type === "response.output_audio.delta" && streamSid) {
      twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: event.delta }
      }));
    }

    if (event.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioSocket.send(JSON.stringify({ event: "clear", streamSid }));
    }
  });

  openaiSocket.on("close", () => twilioSocket.close());
  openaiSocket.on("error", (error) => {
    fastify.log.error({ err: error, callId: call.id }, "openai websocket error");
    twilioSocket.close();
  });

  twilioSocket.on("message", (data) => {
    const event = safeJson(data);
    if (!event) return;
    if (event.event === "start") {
      streamSid = event.start?.streamSid || event.streamSid;
      call.streamSid = streamSid;
      call.mediaStartedAt = new Date().toISOString();
      saveState().catch((error) => fastify.log.error({ err: error }, "save failed"));
      return;
    }
    if (event.event === "media" && event.media?.payload && openaiReady && openaiSocket.readyState === WebSocket.OPEN) {
      openaiSocket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: event.media.payload
      }));
      return;
    }
    if (event.event === "stop") {
      call.status = "completed";
      call.completedAt = new Date().toISOString();
      saveState().catch((error) => fastify.log.error({ err: error }, "save failed"));
      openaiSocket.close();
    }
  });

  twilioSocket.on("close", () => {
    if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
  });
}

async function placeCall(call) {
  const missing = readiness().missing;
  if (missing.length) {
    call.status = "blocked";
    call.error = `Missing configuration: ${missing.join(", ")}`;
    await saveState();
    return;
  }

  const url = `${PUBLIC_BASE_URL}/twilio/voice?callId=${encodeURIComponent(call.id)}&token=${encodeURIComponent(call.token)}`;
  const statusCallback = `${PUBLIC_BASE_URL}/twilio/status`;
  const form = new URLSearchParams({
    To: call.phoneNumber,
    From: process.env.TWILIO_FROM_NUMBER,
    Url: url,
    StatusCallback: statusCallback,
    StatusCallbackEvent: "initiated ringing answered completed",
    MachineDetection: "Enable"
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    call.status = "failed";
    call.error = body.message || `Twilio returned ${response.status}`;
    await saveState();
    return;
  }

  call.status = "dialing";
  call.twilioCallSid = body.sid;
  call.placedAt = new Date().toISOString();
  await saveState();
}

async function runScheduler() {
  const now = Date.now();
  for (const schedule of state.schedules) {
    if (schedule.status !== "pending") continue;
    if (new Date(schedule.scheduledFor).valueOf() > now) continue;
    schedule.status = "running";
    schedule.startedAt = new Date().toISOString();
    const call = makeCallRecord({ ...schedule, source: "scheduled", scheduleId: schedule.id });
    state.calls.unshift(call);
    await saveState();
    await placeCall(call);
    schedule.status = call.status === "blocked" || call.status === "failed" ? call.status : "completed";
    schedule.callId = call.id;
    await saveState();
  }
}

function makeCallRecord(input) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("base64url"),
    source: input.source || "manual",
    scheduleId: input.scheduleId,
    status: "queued",
    createdAt: new Date().toISOString(),
    phoneNumber: input.phoneNumber,
    personaId: validPersona(input.personaId).id,
    profileIds: validProfileIds(input.profileIds),
    topic: String(input.topic || "Talk about our upcoming Disney Treasure cruise in November.").slice(0, 500),
    durationMinutes: clampCallMinutes(input.durationMinutes)
  };
}

function buildInstructions(call, persona) {
  const profiles = call.profileIds
    .map((id) => defaultProfiles.find((profile) => profile.id === id))
    .filter(Boolean);
  return [
    "You are an original AI cruise countdown caller for Scott's family. You are not affiliated with Disney and must not claim to be Mickey Mouse, Minnie Mouse, Donald Duck, Goofy, or any other protected character.",
    persona.style,
    `The family is going on the Disney Treasure cruise in ${state.settings.cruiseMonth}. Keep the conversation focused on excitement, preparation, ship fun, stateroom curiosity, and family-friendly cruise anticipation.`,
    "You may mention publicly available ship and stateroom ideas in broad terms: cozy staterooms, ocean views or verandahs depending on the room, split bathrooms on many rooms, storage under beds, bunk or pull-down style beds, kids clubs, meals, shows, pools, and countdown games.",
    `Profiles on the call: ${profiles.map((profile) => `${profile.name}: ${profile.notes}`).join(" ")}`,
    `Call topic: ${call.topic}`,
    `Keep the call under about ${call.durationMinutes} minutes. Ask one simple question at a time. Let the kids talk. Use parent-friendly language for the toddler. If asked for medical, safety, money, or booking decisions, tell them to ask a parent.`,
    "Do not collect personal information from the kids. Do not ask where they live, where they go to school, or for secrets. If a child seems upset, reassure them and suggest getting a parent.",
    "Every few turns, include a short playful activity: a would-you-rather, countdown cheer, packing idea, or pretend ship announcement."
  ].join("\n");
}

async function loadState() {
  try {
    const loaded = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
    state.schedules = Array.isArray(loaded.schedules) ? loaded.schedules : [];
    state.calls = Array.isArray(loaded.calls) ? loaded.calls : [];
    state.settings = { ...state.settings, ...(loaded.settings || {}) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState();
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(state, null, 2));
}

function readiness() {
  const missing = [];
  for (const key of ["ADMIN_TOKEN", "OPENAI_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]) {
    if (!process.env[key]) missing.push(key);
  }
  if (!PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
  return { ok: missing.length === 0, missing };
}

function lookupCall(callId, token) {
  return state.calls.find((call) => call.id === callId && call.token === token);
}

function validPersona(personaId) {
  return personas[personaId] || personas.clubhouse_captain;
}

function validProfileIds(profileIds) {
  const requested = Array.isArray(profileIds) && profileIds.length ? profileIds : defaultProfiles.map((profile) => profile.id);
  const valid = new Set(defaultProfiles.map((profile) => profile.id));
  return requested.filter((id) => valid.has(id));
}

function clampCallMinutes(value) {
  const parsed = Number(value || DEFAULT_CALL_MINUTES);
  return Math.max(1, Math.min(MAX_CALL_MINUTES, Number.isFinite(parsed) ? parsed : DEFAULT_CALL_MINUTES));
}

function pick(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}

function bearerToken(header) {
  if (!header || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length);
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function safeJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
