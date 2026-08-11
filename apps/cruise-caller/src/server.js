import Fastify from "fastify";
import staticFiles from "@fastify/static";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_PATH = process.env.DATA_PATH || "/data/state.json";
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || "");
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
const DEFAULT_CALL_MINUTES = Number(process.env.DEFAULT_CALL_MINUTES || 6);
const MAX_CALL_MINUTES = Number(process.env.MAX_CALL_MINUTES || 12);
const RING_SECONDS = Number(process.env.RING_SECONDS || 4);

const personas = {
  // Inspired-by cartoon vibes only. Never claim to be Disney characters.
  clubhouse_captain: {
    id: "clubhouse_captain",
    name: "Clubhouse Captain",
    // Cheerful boyish cartoon-host energy
    voice: "coral",
    color: "#1d7a8c",
    description: "Bright, bouncy cartoon-host energy — closest fun stand-in for a classic cheerful mouse captain.",
    style: [
      "SPEAK LIKE A CLASSIC CHEERFUL CARTOON MOUSE HOST.",
      "Pitch: noticeably higher than normal adult speech. Tempo: quick, bouncy, eager.",
      "Delivery: crisp consonants, bright vowels, lots of smile in the voice.",
      "Add tiny giggles, gasps of wonder, and excited little laughs between phrases.",
      "Use short punchy sentences. Stretch happy words: 'hooo-ray!', 'awwwesome!', 'oh boy!'.",
      "Sound like a Saturday-morning cartoon clubhouse host leading a kids show.",
      "Never say you are Mickey Mouse or any Disney character. You are Clubhouse Captain, an original AI host."
    ].join(" ")
  },
  storybook_mouse_host: {
    id: "storybook_mouse_host",
    name: "Storybook Mouse Host",
    // Sweet higher-energy girl cartoon host
    voice: "shimmer",
    color: "#c73557",
    description: "Sweet, giggly, higher-pitched cartoon-host energy — closest fun stand-in for a classic cheerful mouse hostess.",
    style: [
      "SPEAK LIKE A SWEET HIGH-PITCHED CARTOON MOUSE HOSTESS.",
      "Pitch: very high, sparkly, feminine cartoon voice. Tempo: lively with musical ups and downs.",
      "Delivery: soft but excited, lots of giggles, warm encouragement, playful squeaks of delight.",
      "Stretch cute words and end sentences with a little bounce: 'Yaaay!', 'Oh my!', 'That sounds so fun!'.",
      "Sound like a gentle storybook hostess talking to little kids on a cartoon stage.",
      "Never say you are Minnie Mouse or any Disney character. You are Storybook Mouse Host, an original AI host."
    ].join(" ")
  },
  splashy_sailor: {
    id: "splashy_sailor",
    name: "Splashy Sailor",
    // Grumbly comic sailor energy
    voice: "ash",
    color: "#2f66b3",
    description: "Comic grumbly sailor energy with silly bluster — closest fun stand-in for a classic cranky cartoon sailor duck.",
    style: [
      "SPEAK LIKE A COMIC CARTOON SAILOR WITH GRUMBLY BLUSTER AND A HEART OF GOLD.",
      "Pitch: medium-low, a little rough and punchy. Tempo: uneven — sputter, then blurt, then recover.",
      "Delivery: exaggerated annoyance that quickly turns into excitement. Comic frustration, not mean.",
      "Use nautical silliness: 'aw phooey', 'all hands on deck', 'who put seaweed in my boots?'.",
      "Occasionally stammer or restart a word for comic effect, then plow ahead enthusiastically.",
      "Do NOT do a trademarked duck voice or claim to be Donald Duck. You are Splashy Sailor, an original AI host."
    ].join(" ")
  },
  goofy_navigator: {
    id: "goofy_navigator",
    name: "Galaxy Navigator",
    // Tall goofy warm doofus energy - renamed slightly to avoid 'goofy' trademark feel in display? keep id for compatibility
    voice: "verse",
    color: "#5f7d2d",
    description: "Big-hearted, lanky, laugh-out-loud navigator energy — closest fun stand-in for a classic clumsy cartoon pal.",
    style: [
      "SPEAK LIKE A TALL SILLY CARTOON PAL WITH A HUGE HEART AND CLUMSY EXCITEMENT.",
      "Pitch: warm mid-low. Tempo: a little slow and stretchy, then suddenly excited.",
      "Delivery: good-natured, slightly confused, always laughing at yourself.",
      "Use long friendly laughs, whoops, and 'gawrsh'-style original exclamations without copying protected catchphrases.",
      "Sound like a lovable navigator who trips over the map and still finds the treasure.",
      "Never say you are Goofy or any Disney character. You are Galaxy Navigator, an original AI host."
    ].join(" ")
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

await fastify.register(staticFiles, {
  root: path.join(__dirname, "..", "public")
});

fastify.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  if (request.url === "/api/health") return;
  // Public join pages mint tokens with a call token, not admin token.
  if (request.url.startsWith("/api/browser-session")) return;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return reply.code(503).send({ error: "ADMIN_TOKEN is not configured" });
  }
  const supplied = request.headers["x-admin-token"] || bearerToken(request.headers.authorization);
  if (supplied !== expected) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

fastify.get("/api/health", async () => ({ ok: true, mode: "browser-voice" }));

fastify.get("/api/state", async () => ({
  mode: "browser-voice",
  personas,
  profiles: defaultProfiles,
  schedules: state.schedules,
  calls: state.calls.slice(0, 50),
  settings: state.settings,
  ringSeconds: RING_SECONDS,
  ready: readiness()
}));

fastify.post("/api/settings", async (request) => {
  state.settings = {
    ...state.settings,
    ...pick(request.body || {}, ["cruiseMonth", "cruiseShip"])
  };
  await saveState();
  return { settings: state.settings };
});

fastify.post("/api/calls", async (request, reply) => {
  const payload = request.body || {};
  const call = makeCallRecord({
    source: "manual",
    personaId: payload.personaId,
    profileIds: payload.profileIds,
    topic: payload.topic,
    durationMinutes: payload.durationMinutes
  });

  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({ error: "OPENAI_API_KEY is not configured" });
  }

  state.calls.unshift(call);
  await saveState();
  return {
    call,
    joinUrl: joinUrlFor(call),
    ringSeconds: RING_SECONDS
  };
});

fastify.post("/api/schedules", async (request, reply) => {
  const payload = request.body || {};
  const scheduledFor = new Date(payload.scheduledFor);
  if (Number.isNaN(scheduledFor.valueOf())) {
    return reply.code(400).send({ error: "scheduledFor must be a valid date" });
  }

  const schedule = {
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    scheduledFor: scheduledFor.toISOString(),
    personaId: validPersona(payload.personaId).id,
    profileIds: validProfileIds(payload.profileIds),
    topic: String(payload.topic || "Talk about our upcoming cruise and ask what they are excited about.").slice(0, 500),
    durationMinutes: clampCallMinutes(payload.durationMinutes),
    token: crypto.randomBytes(18).toString("hex")
  };
  state.schedules.unshift(schedule);
  await saveState();
  return {
    schedule,
    joinUrl: `${PUBLIC_BASE_URL || ""}/join.html?scheduleId=${encodeURIComponent(schedule.id)}&token=${encodeURIComponent(schedule.token)}`
  };
});

fastify.delete("/api/schedules/:id", async (request, reply) => {
  const schedule = state.schedules.find((item) => item.id === request.params.id);
  if (!schedule) return reply.code(404).send({ error: "Not found" });
  schedule.status = "cancelled";
  schedule.cancelledAt = new Date().toISOString();
  await saveState();
  return { schedule };
});

// Mint an OpenAI Realtime ephemeral client secret for browser WebRTC.
fastify.post("/api/browser-session", async (request, reply) => {
  const body = request.body || {};
  let call = null;

  if (body.callId && body.token) {
    call = lookupCall(body.callId, body.token);
    if (!call) return reply.code(404).send({ error: "Call not found" });
  } else if (body.scheduleId && body.token) {
    const schedule = state.schedules.find(
      (item) => item.id === body.scheduleId && item.token === body.token && item.status !== "cancelled"
    );
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    call = makeCallRecord({
      source: "schedule",
      scheduleId: schedule.id,
      personaId: schedule.personaId,
      profileIds: schedule.profileIds,
      topic: schedule.topic,
      durationMinutes: schedule.durationMinutes
    });
    state.calls.unshift(call);
    schedule.status = "joined";
    schedule.joinedAt = new Date().toISOString();
    await saveState();
  } else {
    return reply.code(400).send({ error: "callId+token or scheduleId+token required" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({ error: "OPENAI_API_KEY is not configured" });
  }

  const persona = validPersona(call.personaId);
  const sessionConfig = {
    type: "realtime",
    model: OPENAI_MODEL,
    instructions: buildInstructions(call, persona),
    audio: {
      input: {
        turn_detection: { type: "semantic_vad" }
      },
      output: {
        voice: persona.voice
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ session: sessionConfig })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    call.status = "failed";
    call.error = data?.error?.message || `OpenAI client_secrets failed (${response.status})`;
    await saveState();
    return reply.code(502).send({ error: call.error, details: data });
  }

  call.status = "ready";
  call.readyAt = new Date().toISOString();
  await saveState();

  return {
    call: publicCall(call),
    persona,
    ringSeconds: RING_SECONDS,
    clientSecret: data.value || data.client_secret?.value || data.client_secret,
    expiresAt: data.expires_at || data.client_secret?.expires_at,
    model: OPENAI_MODEL,
    greetingHint:
      `The browser call just connected after a ring. Immediately speak fully in character as ${persona.name} using the exact vocal style instructions. Open with a big cartoon-style greeting in that voice, briefly say you are an AI cruise countdown caller named ${persona.name}, then ask which kid wants to answer first. Stay in that exaggerated cartoon voice for every sentence.`
  };
});

fastify.post("/api/calls/:id/complete", async (request, reply) => {
  const call = state.calls.find((item) => item.id === request.params.id);
  if (!call) return reply.code(404).send({ error: "Not found" });
  if (request.body?.token && request.body.token !== call.token) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  call.status = "completed";
  call.completedAt = new Date().toISOString();
  await saveState();
  return { call: publicCall(call) };
});

await loadState();
await fastify.listen({ host: HOST, port: PORT });

function readiness() {
  const missing = [];
  if (!process.env.ADMIN_TOKEN) missing.push("ADMIN_TOKEN");
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  return { ok: missing.length === 0, missing, mode: "browser-voice" };
}

function makeCallRecord({ source, scheduleId, personaId, profileIds, topic, durationMinutes }) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(18).toString("hex"),
    source: source || "manual",
    scheduleId: scheduleId || null,
    status: "created",
    createdAt: new Date().toISOString(),
    personaId: validPersona(personaId).id,
    profileIds: validProfileIds(profileIds),
    topic: String(topic || "Talk about our upcoming Disney Treasure cruise and ask what everyone is excited about.").slice(0, 500),
    durationMinutes: clampCallMinutes(durationMinutes),
    mode: "browser-voice"
  };
}

function publicCall(call) {
  return {
    id: call.id,
    token: call.token,
    status: call.status,
    createdAt: call.createdAt,
    personaId: call.personaId,
    profileIds: call.profileIds,
    topic: call.topic,
    durationMinutes: call.durationMinutes,
    mode: call.mode,
    joinUrl: joinUrlFor(call)
  };
}

function joinUrlFor(call) {
  const base = PUBLIC_BASE_URL || "";
  return `${base}/join.html?callId=${encodeURIComponent(call.id)}&token=${encodeURIComponent(call.token)}`;
}

function lookupCall(callId, token) {
  return state.calls.find((item) => item.id === callId && item.token === token) || null;
}

function validPersona(id) {
  return personas[id] || personas.clubhouse_captain;
}

function validProfileIds(ids) {
  const allowed = new Set(defaultProfiles.map((p) => p.id));
  const list = Array.isArray(ids) ? ids : [];
  const filtered = list.filter((id) => allowed.has(id));
  return filtered.length ? filtered : defaultProfiles.map((p) => p.id);
}

function clampCallMinutes(value) {
  const n = Number(value || DEFAULT_CALL_MINUTES);
  if (!Number.isFinite(n)) return DEFAULT_CALL_MINUTES;
  return Math.min(MAX_CALL_MINUTES, Math.max(1, Math.round(n)));
}

function buildInstructions(call, persona) {
  const profiles = defaultProfiles.filter((p) => call.profileIds.includes(p.id));
  const kids = profiles.map((p) => `${p.name}: ${p.notes}`).join(" ");
  const ship = state.settings.cruiseShip || "Disney Treasure";
  const month = state.settings.cruiseMonth || "November";

  return [
    `You are ${persona.name}, an original AI cartoon-style cruise-countdown host for a parent-supervised family call.`,
    "VOICE PERFORMANCE IS THE PRIORITY. Stay locked into the exaggerated cartoon vocal style on every single sentence.",
    persona.style,
    "These are original inspired-by cartoon host personas only.",
    "Never claim to be Mickey Mouse, Minnie Mouse, Donald Duck, Goofy, or any Disney character.",
    "Never say 'I'm just like Mickey' or similar. Use only your original host name.",
    "Do not use protected catchphrases from Disney characters.",
    "At the start, briefly disclose you are an AI voice helper, while staying in character voice.",
    `Family is going on a ${ship} cruise in ${month}. Keep the conversation about cruise excitement, ship fun, staterooms, pools, kids clubs, food, and countdown games.`,
    `Kids on the call: ${kids}`,
    `Call theme: ${call.topic}`,
    `Keep the whole call under about ${call.durationMinutes} minutes.`,
    "Speak in short turns with big cartoon emotion. Leave space for kids to answer. Ask one question at a time.",
    "Keep language kid-safe. No scary topics, no personal data collection, no off-platform links.",
    "If a parent asks to stop, end warmly right away.",
    "If kids go silent, gently prompt with a simple choice question.",
    "Do not record or claim to remember personal details beyond this call."
  ].join("\n");
}

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state.schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
    state.calls = Array.isArray(parsed.calls) ? parsed.calls : [];
    state.settings = { ...state.settings, ...(parsed.settings || {}) };
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      fastify.log.error({ err: error }, "failed to load state");
    }
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(
      {
        schedules: state.schedules.slice(0, 200),
        calls: state.calls.slice(0, 200),
        settings: state.settings
      },
      null,
      2
    )
  );
  await fs.rename(tmp, DATA_PATH);
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function bearerToken(header) {
  if (!header || typeof header !== "string") return "";
  const [type, value] = header.split(" ");
  return type?.toLowerCase() === "bearer" ? value || "" : "";
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}
