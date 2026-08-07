const state = {
  token: localStorage.getItem("cruiseCallerToken") || "",
  selectedPersona: "clubhouse_captain",
  data: null
};

const els = {
  authPanel: document.querySelector("#authPanel"),
  workspace: document.querySelector("#workspace"),
  authForm: document.querySelector("#authForm"),
  adminToken: document.querySelector("#adminToken"),
  readyStatus: document.querySelector("#readyStatus"),
  personaGrid: document.querySelector("#personaGrid"),
  scheduleList: document.querySelector("#scheduleList"),
  callList: document.querySelector("#callList"),
  callForm: document.querySelector("#callForm"),
  callNow: document.querySelector("#callNow"),
  refresh: document.querySelector("#refresh"),
  phoneNumber: document.querySelector("#phoneNumber")
};

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = els.adminToken.value.trim();
  localStorage.setItem("cruiseCallerToken", state.token);
  await loadState();
});

els.refresh.addEventListener("click", loadState);
els.callForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await scheduleCall();
});
els.callNow.addEventListener("click", async () => callNow());

if (state.token) {
  loadState();
}

async function loadState() {
  const response = await api("/api/state");
  if (!response.ok) {
    showLocked();
    return;
  }
  state.data = await response.json();
  showWorkspace();
  render();
}

function render() {
  const { ready, settings } = state.data;
  els.readyStatus.textContent = ready.ok ? "Ready" : `Missing ${ready.missing.length}`;
  els.readyStatus.className = `status ${ready.ok ? "ready" : "blocked"}`;
  if (!els.phoneNumber.value) els.phoneNumber.value = settings.defaultPhoneNumber || "";

  els.personaGrid.innerHTML = Object.values(state.data.personas)
    .map((persona) => `
      <button type="button" class="persona ${persona.id === state.selectedPersona ? "selected" : ""}" style="--accent:${persona.color}" data-persona="${persona.id}">
        <strong>${escapeHtml(persona.name)}</strong>
        <span>${escapeHtml(persona.description)}</span>
      </button>
    `)
    .join("");

  for (const button of els.personaGrid.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      state.selectedPersona = button.dataset.persona;
      render();
    });
  }

  els.scheduleList.innerHTML = state.data.schedules.length
    ? state.data.schedules.map(renderSchedule).join("")
    : `<div class="empty">No calls scheduled yet.</div>`;

  for (const button of els.scheduleList.querySelectorAll("[data-cancel]")) {
    button.addEventListener("click", async () => {
      await api(`/api/schedules/${button.dataset.cancel}`, { method: "DELETE" });
      await loadState();
    });
  }

  els.callList.innerHTML = state.data.calls.length
    ? state.data.calls.map(renderCall).join("")
    : `<div class="empty">No calls placed yet.</div>`;
}

async function scheduleCall() {
  const payload = formPayload();
  if (!payload.scheduledFor) {
    alert("Pick a schedule time first.");
    return;
  }
  await api("/api/schedules", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  els.callForm.reset();
  await loadState();
}

async function callNow() {
  await api("/api/calls", {
    method: "POST",
    body: JSON.stringify(formPayload())
  });
  await loadState();
}

function formPayload() {
  const form = new FormData(els.callForm);
  return {
    phoneNumber: form.get("phoneNumber"),
    profileIds: form.getAll("profiles"),
    personaId: state.selectedPersona,
    topic: form.get("topic"),
    durationMinutes: Number(form.get("durationMinutes") || 6),
    scheduledFor: localDateToIso(form.get("scheduledFor"))
  };
}

function renderSchedule(schedule) {
  return `
    <div class="row">
      <div>
        <strong>${formatDate(schedule.scheduledFor)} · ${escapeHtml(personaName(schedule.personaId))}</strong>
        <small>${escapeHtml(schedule.topic)} · ${escapeHtml(schedule.phoneNumber)}</small>
      </div>
      <div class="button-row">
        <span class="badge">${escapeHtml(schedule.status)}</span>
        ${schedule.status === "pending" ? `<button type="button" class="ghost" data-cancel="${schedule.id}">Cancel</button>` : ""}
      </div>
    </div>
  `;
}

function renderCall(call) {
  return `
    <div class="row">
      <div>
        <strong>${formatDate(call.createdAt)} · ${escapeHtml(personaName(call.personaId))}</strong>
        <small>${escapeHtml(call.error || call.topic)} · ${escapeHtml(call.phoneNumber || "")}</small>
      </div>
      <span class="badge">${escapeHtml(call.twilioStatus || call.status)}</span>
    </div>
  `;
}

function personaName(id) {
  return state.data.personas[id]?.name || "Clubhouse Captain";
}

async function api(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": state.token,
      ...(options.headers || {})
    }
  });
}

function showWorkspace() {
  els.authPanel.classList.add("hidden");
  els.workspace.classList.remove("hidden");
}

function showLocked() {
  els.authPanel.classList.remove("hidden");
  els.workspace.classList.add("hidden");
  els.readyStatus.textContent = "Locked";
  els.readyStatus.className = "status blocked";
}

function localDateToIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
