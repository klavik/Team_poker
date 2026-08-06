import {
  getApps,
  getApp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const integrationConfig =
  window.TEAM_CALCULATOR_INTEGRATION || {};

const POLL_INTERVAL_MS = 1200;
const RETRY_DELAY_MS = 30000;
const STATUS_POLL_INTERVAL_MS = Math.max(
  5000,
  Number(integrationConfig.statusPollIntervalMs) || 15000
);
const STATUS_BATCH_SIZE = 100;

let currentUser = null;
let pollTimer = null;
let statusPollTimer = null;
let statusInFlight = false;
let statusRefreshTimer = null;
let inFlightKey = null;
let retryAfterByKey = new Map();

function integrationStyle() {
  if (document.getElementById("teamCalculatorIntegrationStyle")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "teamCalculatorIntegrationStyle";
  style.textContent = `
    .team-calculator-sync-box{
      margin-top:12px;
      padding:10px 12px;
      border-radius:10px;
      border:1px solid #d9dde7;
      background:#f8f9fc;
      font-size:13px;
    }
    .team-calculator-sync-box.ok{
      color:#137333;
      border-color:#bfe6ca;
      background:#eef9f1;
    }
    .team-calculator-sync-box.warn{
      color:#9a5b00;
      border-color:#ffd7a3;
      background:#fff7ea;
    }
    .team-calculator-sync-box.error{
      color:#b3261e;
      border-color:#f5b7b1;
      background:#fff3f2;
    }
  `;

  document.head.appendChild(style);
}

function ensureStatusBox() {
  integrationStyle();

  const oldButton =
    document.getElementById("copyTeamCalendarBtn")
    || [...document.querySelectorAll("button")].find(button =>
      /^Данные\s+Team_/i.test(
        (button.textContent || "").trim()
      )
    );

  if (oldButton) {
    oldButton.style.display = "none";
  }

  let box = document.getElementById("teamCalculatorSyncBox");

  if (box) {
    return box;
  }

  const anchor = document.getElementById("finalMessage");

  if (!anchor) {
    return null;
  }

  box = document.createElement("div");
  box.id = "teamCalculatorSyncBox";
  box.className = "team-calculator-sync-box";
  box.textContent =
    "После фиксации оценка будет автоматически передана в Team_calculator.";

  anchor.insertAdjacentElement("afterend", box);

  return box;
}

function setStatus(text, type = "") {
  const box = ensureStatusBox();

  if (!box) {
    return;
  }

  box.textContent = text;
  box.className =
    "team-calculator-sync-box"
    + (type ? ` ${type}` : "");
}

function configuredEndpoint() {
  const endpoint = String(
    integrationConfig.endpoint || ""
  ).trim();

  if (!endpoint || endpoint.includes("REPLACE_")) {
    return null;
  }

  return endpoint;
}

function configuredStatusEndpoint() {
  const explicit = String(
    integrationConfig.statusEndpoint || ""
  ).trim();

  if (explicit && !explicit.includes("REPLACE_")) {
    return explicit;
  }

  const syncEndpoint = configuredEndpoint();
  if (!syncEndpoint) return null;

  try {
    const url = new URL(syncEndpoint);
    url.pathname = "/task-statuses";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return syncEndpoint.replace(/\/sync\/?$/, "/task-statuses");
  }
}

function deliveryStatusDescriptors() {
  const api = window.TeamPokerIntegration;

  if (
    !api
    || typeof api.getDeliveryStatusDescriptors !== "function"
  ) {
    return [];
  }

  const descriptors = api.getDeliveryStatusDescriptors();

  return Array.isArray(descriptors)
    ? descriptors.filter(item => item?.issueId && item?.taskId)
    : [];
}

function applyDeliveryStatuses(items, meta = {}) {
  const api = window.TeamPokerIntegration;

  if (
    api
    && typeof api.setDeliveryStatuses === "function"
  ) {
    api.setDeliveryStatuses(items, meta);
  }
}

function currentPayload() {
  const api = window.TeamPokerIntegration;

  if (
    !api
    || typeof api.getCurrentEstimatePayload !== "function"
  ) {
    return null;
  }

  const payload = api.getCurrentEstimatePayload();

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const normalized = {
    ...payload,
    taskId: String(payload.taskId || "").trim(),
    title: String(payload.title || "").trim(),
    estimatedRole: String(
      payload.estimatedRole || ""
    ).trim(),
    eventType: String(
      payload.eventType || "estimate_finalized"
    ).trim(),
    finalEstimate:
      payload.finalEstimate == null
        ? null
        : Number(payload.finalEstimate),
    estimateVersion: Math.max(
      0,
      Number(payload.estimateVersion) || 0
    ),
    integrationSchemaVersion: Math.max(
      1,
      Number(payload.integrationSchemaVersion) || 1
    ),
    reestimate:
      payload.reestimate
      && typeof payload.reestimate === "object"
        ? payload.reestimate
        : null,
    transfer:
      payload.transfer?.isTransferred === true
        ? payload.transfer
        : null
  };

  if (!normalized.taskId || !normalized.title) {
    return null;
  }

  if (
    !["backend", "frontend"].includes(
      normalized.estimatedRole
    )
  ) {
    return null;
  }

  const reestimateRequired =
    normalized.eventType === "reestimate_required"
    || normalized.reestimate?.required === true;

  if (
    !reestimateRequired
    && (
      !Number.isFinite(normalized.finalEstimate)
      || normalized.finalEstimate <= 0
    )
  ) {
    return null;
  }

  return normalized;
}

function payloadKey(payload) {
  const transferSignature =
    payload.transfer?.isTransferred === true
      ? [
          "moved",
          payload.transfer.fromSessionId || "",
          payload.transfer.toSessionId || "",
          payload.transfer.movedAt || ""
        ].join("-")
      : "not-moved";

  const reestimateSignature =
    payload.reestimate?.required === true
      ? [
          "reestimate",
          payload.reestimate.reason || "",
          payload.reestimate.requestedAt || "",
          payload.reestimate.previousEstimateVersion || 0
        ].join("-")
      : "estimate";

  return [
    payload.taskId,
    payload.estimatedRole,
    payload.estimateVersion,
    payload.eventType || "estimate_finalized",
    `schema${payload.integrationSchemaVersion || 1}`,
    transferSignature,
    reestimateSignature
  ].join(":");
}

function storageKey(payload) {
  return `teamCalculatorSync:${payloadKey(payload)}`;
}

function readStoredSync(payload) {
  try {
    const raw = localStorage.getItem(storageKey(payload));

    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredSync(payload, value) {
  try {
    localStorage.setItem(
      storageKey(payload),
      JSON.stringify(value)
    );
  } catch {
    // Интеграция продолжит работать и без localStorage.
  }
}

function renderCurrentState() {
  const endpoint = configuredEndpoint();

  if (!endpoint) {
    setStatus(
      "Интеграция не настроена: укажите URL Cloudflare Worker.",
      "error"
    );
    return;
  }

  if (!currentUser) {
    setStatus(
      "Войдите, чтобы передавать оценки в Team_calculator."
    );
    return;
  }

  const payload = currentPayload();

  if (!payload) {
    setStatus(
      "После фиксации оценка будет автоматически передана в Team_calculator."
    );
    return;
  }

  const key = payloadKey(payload);

  if (inFlightKey === key) {
    setStatus(
      "Оценка передаётся в общий пул Team_calculator…",
      "warn"
    );
    return;
  }

  const stored = readStoredSync(payload);

  if (
    stored
    && ["synced", "ignored_stale"].includes(stored.status)
  ) {
    setStatus(
      payload.reestimate?.required === true
        ? "Задача передана в список Team_calculator «На переоценку»."
        : `Передано в общий пул Team_calculator · версия ${
            payload.estimateVersion
          }${
            payload.transfer?.isTransferred
              ? " · перенос отмечен"
              : ""
          }.`,
      "ok"
    );

    scheduleDeliveryStatusRefresh(700);
    return;
  }

  if (stored?.status === "error") {
    setStatus(
      `Ошибка передачи в Team_calculator: ${
        stored.error || "повторная попытка будет выполнена автоматически"
      }.`,
      "error"
    );
    return;
  }

  setStatus(
    payload.reestimate?.required === true
      ? "Задача готова к передаче в список «На переоценку»."
      : "Оценка готова к автоматической передаче.",
    "warn"
  );
}

async function sendPayload(payload) {
  const endpoint = configuredEndpoint();

  if (!endpoint || !currentUser) {
    return;
  }

  const key = payloadKey(payload);

  if (inFlightKey === key) {
    return;
  }

  const stored = readStoredSync(payload);

  if (
    stored
    && ["synced", "ignored_stale"].includes(stored.status)
  ) {
    return;
  }

  const retryAfter = retryAfterByKey.get(key) || 0;

  if (Date.now() < retryAfter) {
    return;
  }

  inFlightKey = key;
  setStatus(
    payload.reestimate?.required === true
      ? "Задача передаётся в список Team_calculator «На переоценку»…"
      : "Оценка передаётся в общий пул Team_calculator…",
    "warn"
  );

  try {
    const token = await currentUser.getIdToken();

    const requestPayload = {
      ...payload,
      finalizedBy: payload.finalizedBy || {
        uid: currentUser.uid,
        email: currentUser.email || null,
        displayName: currentUser.displayName || null
      },
      source: "team_poker"
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(requestPayload)
    });

    const result = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || result.ok !== true) {
      throw new Error(
        result.error || `HTTP ${response.status}`
      );
    }

    const status = result.status || "synced";

    writeStoredSync(payload, {
      status,
      targetTaskId: result.taskId || null,
      workspaceId: result.workspaceId || "main",
      syncedAt: new Date().toISOString()
    });

    retryAfterByKey.delete(key);

    setStatus(
      payload.reestimate?.required === true
        ? "Задача передана в список Team_calculator «На переоценку»."
        : `Передано в общий пул Team_calculator · версия ${
            payload.estimateVersion
          }${
            payload.transfer?.isTransferred
              ? " · перенос отмечен"
              : ""
          }.`,
      "ok"
    );
  } catch (error) {
    console.error(
      "Ошибка интеграции Team_poker → Team_calculator",
      error
    );

    retryAfterByKey.set(
      key,
      Date.now() + RETRY_DELAY_MS
    );

    writeStoredSync(payload, {
      status: "error",
      error: String(
        error?.message || error
      ).slice(0, 1000),
      failedAt: new Date().toISOString()
    });

    setStatus(
      `Ошибка передачи в Team_calculator: ${
        error?.message || error
      }. Повтор через 30 секунд.`,
      "error"
    );
  } finally {
    if (inFlightKey === key) {
      inFlightKey = null;
    }
  }
}

async function requestDeliveryStatusChunk(
  endpoint,
  token,
  tasks
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ tasks })
  });

  const result = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || result.ok !== true) {
    throw new Error(
      result.error || `HTTP ${response.status}`
    );
  }

  return Array.isArray(result.statuses)
    ? result.statuses
    : [];
}

async function syncDeliveryStatuses({ force = false } = {}) {
  const endpoint = configuredStatusEndpoint();
  const descriptors = deliveryStatusDescriptors();

  if (!currentUser || !endpoint) {
    applyDeliveryStatuses([], {
      state: "idle",
      syncedAt: null,
      error: null
    });
    return;
  }

  if (!descriptors.length) {
    applyDeliveryStatuses([], {
      state: "ok",
      syncedAt: new Date().toISOString(),
      error: null
    });
    return;
  }

  if (statusInFlight && !force) return;
  if (statusInFlight) return;

  statusInFlight = true;

  try {
    const token = await currentUser.getIdToken();
    const statuses = [];

    for (
      let start = 0;
      start < descriptors.length;
      start += STATUS_BATCH_SIZE
    ) {
      const chunk = descriptors.slice(
        start,
        start + STATUS_BATCH_SIZE
      );

      statuses.push(
        ...await requestDeliveryStatusChunk(
          endpoint,
          token,
          chunk
        )
      );
    }

    applyDeliveryStatuses(statuses, {
      state: "ok",
      syncedAt: new Date().toISOString(),
      error: null
    });
  } catch (error) {
    console.error(
      "Ошибка Team_calculator → Team_poker",
      error
    );

    /*
      Старые успешно полученные значения не стираем: приложение
      продолжает показывать последний известный статус.
    */
    // Последний успешно полученный набор остаётся в app.js.
    // В консоль пишем ошибку, следующая попытка будет по таймеру.
  } finally {
    statusInFlight = false;
  }
}

function scheduleDeliveryStatusRefresh(delay = 250) {
  if (statusRefreshTimer) {
    clearTimeout(statusRefreshTimer);
  }

  statusRefreshTimer = window.setTimeout(
    () => syncDeliveryStatuses({ force: true }),
    delay
  );
}

async function checkAndSync() {
  renderCurrentState();

  if (!currentUser || !configuredEndpoint()) {
    return;
  }

  const payload = currentPayload();

  if (!payload) {
    return;
  }

  await sendPayload(payload);
}

async function waitForFirebaseApp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getApps().length) {
      return getApp();
    }

    await new Promise(resolve =>
      setTimeout(resolve, 100)
    );
  }

  throw new Error(
    "Firebase-приложение Team_poker не инициализировано."
  );
}

async function start() {
  ensureStatusBox();

  try {
    const app = await waitForFirebaseApp();
    const auth = getAuth(app);

    onAuthStateChanged(auth, user => {
      currentUser = user || null;
      checkAndSync();
      scheduleDeliveryStatusRefresh(100);
    });

    window.addEventListener(
      "hashchange",
      () => {
        setTimeout(checkAndSync, 300);
        scheduleDeliveryStatusRefresh(350);
      }
    );

    window.addEventListener(
      "team-poker:issues-changed",
      () => scheduleDeliveryStatusRefresh(200)
    );

    const finalizeButton =
      document.getElementById("finalizeBtn");

    if (finalizeButton) {
      finalizeButton.addEventListener(
        "click",
        () => setTimeout(checkAndSync, 1500)
      );
    }

    pollTimer = window.setInterval(
      checkAndSync,
      POLL_INTERVAL_MS
    );

    statusPollTimer = window.setInterval(
      syncDeliveryStatuses,
      STATUS_POLL_INTERVAL_MS
    );

    window.addEventListener(
      "beforeunload",
      () => {
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        if (statusPollTimer) {
          clearInterval(statusPollTimer);
        }
        if (statusRefreshTimer) {
          clearTimeout(statusRefreshTimer);
        }
      },
      { once: true }
    );

    checkAndSync();
    syncDeliveryStatuses({ force: true });
  } catch (error) {
    console.error(error);
    setStatus(
      `Интеграция Team_calculator не запущена: ${
        error?.message || error
      }.`,
      "error"
    );
  }
}

start();
