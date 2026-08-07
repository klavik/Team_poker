import {
  getApps,
  getApp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const integrationConfig =
  window.TEAM_CALCULATOR_INTEGRATION || {};

const POLL_INTERVAL_MS = 1200;
const RETRY_DELAY_MS = 30000;
let currentUser = null;
let pollTimer = null;
let statusRefreshTimer = null;
let inFlightKey = null;
let retryAfterByKey = new Map();

let deliveryStatusDb = null;
let deliveryStatusUnsubscribe = null;
let deliveryStatusTeamId = null;
const deliveryStatusSnapshotByIssueId = new Map();

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

function configuredStatusCollection() {
  const value = String(
    integrationConfig.statusCollection
    || "delivery_status"
  ).trim();

  return value || "delivery_status";
}

function stopDeliveryStatusSubscription() {
  if (deliveryStatusUnsubscribe) {
    try {
      deliveryStatusUnsubscribe();
    } catch {
      // Best-effort cleanup.
    }
  }

  deliveryStatusUnsubscribe = null;
  deliveryStatusTeamId = null;
  deliveryStatusSnapshotByIssueId.clear();
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

function renderDeliveryStatusSnapshot() {
  const descriptors = deliveryStatusDescriptors();

  if (!descriptors.length) {
    applyDeliveryStatuses([], {
      state: "ok",
      syncedAt: new Date().toISOString(),
      error: null,
      transport: "firestore"
    });
    return;
  }

  const descriptorByIssueId = new Map(
    descriptors.map(item => [
      String(item.issueId || "").trim(),
      item
    ])
  );

  const statuses = [];

  for (
    const [issueId, item]
    of deliveryStatusSnapshotByIssueId.entries()
  ) {
    const descriptor =
      descriptorByIssueId.get(issueId);

    if (
      !descriptor
      || item?.found !== true
    ) {
      continue;
    }

    const mirroredRole = String(
      item?.estimatedRole || ""
    ).trim();

    if (
      mirroredRole
      && mirroredRole !== descriptor.estimatedRole
    ) {
      continue;
    }

    statuses.push({
      ...item,
      issueId
    });
  }

  applyDeliveryStatuses(statuses, {
    state: "ok",
    syncedAt: new Date().toISOString(),
    error: null,
    transport: "firestore"
  });
}

function syncDeliveryStatuses() {
  const descriptors = deliveryStatusDescriptors();

  if (!currentUser) {
    stopDeliveryStatusSubscription();

    applyDeliveryStatuses([], {
      state: "idle",
      syncedAt: null,
      error: null,
      transport: "firestore"
    });

    return;
  }

  const teamId = String(
    descriptors[0]?.teamId || ""
  ).trim();

  if (!teamId) {
    stopDeliveryStatusSubscription();

    applyDeliveryStatuses([], {
      state: "ok",
      syncedAt: new Date().toISOString(),
      error: null,
      transport: "firestore"
    });

    return;
  }

  if (
    deliveryStatusUnsubscribe
    && deliveryStatusTeamId === teamId
  ) {
    renderDeliveryStatusSnapshot();
    return;
  }

  stopDeliveryStatusSubscription();

  try {
    const app = getApp();

    deliveryStatusDb =
      deliveryStatusDb || getFirestore(app);

    const statusRef = collection(
      deliveryStatusDb,
      "teams",
      teamId,
      configuredStatusCollection()
    );

    deliveryStatusTeamId = teamId;

    deliveryStatusUnsubscribe = onSnapshot(
      statusRef,
      snapshot => {
        deliveryStatusSnapshotByIssueId.clear();

        for (const docSnapshot of snapshot.docs) {
          const data = docSnapshot.data() || {};
          const issueId = String(
            data.issueId || docSnapshot.id
          ).trim();

          if (!issueId) continue;

          deliveryStatusSnapshotByIssueId.set(
            issueId,
            {
              ...data,
              issueId
            }
          );
        }

        renderDeliveryStatusSnapshot();
      },
      error => {
        console.error(
          "Ошибка чтения статусов Team_calculator из Firestore Team_poker",
          error
        );

        /*
          Последнее успешно полученное состояние не стираем.
          Firestore listener сам переподключится после
          восстановления соединения.
        */
      }
    );
  } catch (error) {
    console.error(
      "Не удалось запустить realtime-статусы Team_calculator",
      error
    );
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
      () => {
        renderDeliveryStatusSnapshot();
        scheduleDeliveryStatusRefresh(200);
      }
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

    window.addEventListener(
      "beforeunload",
      () => {
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        if (statusRefreshTimer) {
          clearTimeout(statusRefreshTimer);
        }
        stopDeliveryStatusSubscription();
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
