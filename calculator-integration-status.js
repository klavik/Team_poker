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
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const integrationConfig =
  window.TEAM_CALCULATOR_INTEGRATION || {};

let currentUser = null;
let statusRefreshTimer = null;
let inFlightKey = null;

let deliveryStatusDb = null;
let deliveryStatusUnsubscribe = null;
let deliveryStatusTeamId = null;
const deliveryStatusSnapshotByIssueId = new Map();

let calculatorSyncDb = null;
const calculatorSyncJobUnsubscribers = new Map();

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
    .team-calculator-sync-box .team-calculator-retry{
      margin-top:8px;
      border:0;
      border-radius:8px;
      padding:7px 10px;
      background:#edf1f7;
      color:#172033;
      font-weight:700;
      cursor:pointer;
    }
    .team-calculator-sync-box .team-calculator-retry:disabled{
      cursor:default;
      opacity:.55;
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

function setStatus(
  text,
  type = "",
  retryHandler = null,
  retryDisabled = false
) {
  const box = ensureStatusBox();

  if (!box) {
    return;
  }

  box.textContent = text;
  box.className =
    "team-calculator-sync-box"
    + (type ? ` ${type}` : "");

  if (retryHandler || retryDisabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-calculator-retry";
    button.textContent = "Передать повторно";
    button.disabled = retryDisabled;

    if (retryHandler && !retryDisabled) {
      button.addEventListener("click", retryHandler);
    }

    box.appendChild(document.createElement("br"));
    box.appendChild(button);
  }
}

function configuredSyncCollection() {
  const value = String(
    integrationConfig.syncCollection
    || "team_calculator_sync"
  ).trim();

  return value || "team_calculator_sync";
}

function configuredStatusCollection() {
  const value = String(
    integrationConfig.statusCollection
    || "delivery_status"
  ).trim();

  return value || "delivery_status";
}

function configuredTeamCalculatorBaseUrl() {
  const configured = String(
    integrationConfig.teamCalculatorBaseUrl
    || "../Team_calculator/"
  ).trim();

  if (!configured) {
    return null;
  }

  try {
    const url = new URL(
      configured,
      window.location.href
    );

    url.hash = "";
    url.search = "";

    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }

    return url;
  } catch (error) {
    console.warn(
      "Некорректный teamCalculatorBaseUrl:",
      configured,
      error
    );
    return null;
  }
}

function teamCalculatorTaskUrl(targetTaskId) {
  const taskId = String(
    targetTaskId || ""
  ).trim();

  const baseUrl =
    configuredTeamCalculatorBaseUrl();

  if (!taskId || !baseUrl) {
    return null;
  }

  const url = new URL(baseUrl.href);
  url.searchParams.set("task", taskId);

  return url.href;
}

function ensureTeamCalculatorTaskLink() {
  const issueLinks =
    document.querySelector(".issue-links");

  if (!issueLinks) {
    return null;
  }

  let link =
    document.getElementById(
      "teamCalculatorTaskLink"
    );

  if (link) {
    return link;
  }

  link = document.createElement("a");
  link.id = "teamCalculatorTaskLink";
  link.className = "hidden";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Открыть в Team_calculator";

  const copyLinkButton =
    document.getElementById(
      "copyIssueLinkBtn"
    );

  issueLinks.insertBefore(
    link,
    copyLinkButton || null
  );

  return link;
}

function mirroredTeamCalculatorTask(
  issueId,
  expectedTeamId = ""
) {
  const normalizedIssueId = String(
    issueId || ""
  ).trim();

  if (!normalizedIssueId) {
    return null;
  }

  const item =
    deliveryStatusSnapshotByIssueId.get(
      normalizedIssueId
    );

  if (
    !item
    || item.found !== true
    || !String(
      item.targetTaskId || ""
    ).trim()
  ) {
    return null;
  }

  const mirroredTeamId = String(
    item.teamId || ""
  ).trim();

  const normalizedTeamId = String(
    expectedTeamId || ""
  ).trim();

  if (
    normalizedTeamId
    && mirroredTeamId
    && mirroredTeamId !== normalizedTeamId
  ) {
    return null;
  }

  return item;
}

function renderTeamCalculatorTaskLink(
  item = null
) {
  const link =
    ensureTeamCalculatorTaskLink();

  if (!link) {
    return;
  }

  const targetTaskId = String(
    item?.targetTaskId || ""
  ).trim();

  const href =
    item?.found === true
      ? teamCalculatorTaskUrl(
          targetTaskId
        )
      : null;

  if (!href) {
    link.classList.add("hidden");
    link.removeAttribute("href");
    link.removeAttribute("title");
    return;
  }

  link.href = href;
  link.title =
    "Открыть эту задачу в Team_calculator";
  link.classList.remove("hidden");
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

function canManualRetry() {
  const api = window.TeamPokerIntegration;

  return Boolean(
    api
    && typeof api.canManageCurrentEstimation === "function"
    && api.canManageCurrentEstimation()
  );
}

function currentTaskLocationFromHash() {
  /*
    При переключении карточек внутри Team_poker сначала используем
    живое состояние приложения. URL остаётся fallback для прямого
    открытия ссылки и ранней стадии загрузки.
  */
  try {
    const api = window.TeamPokerIntegration;

    if (
      api
      && typeof api.getCurrentTaskLocation === "function"
    ) {
      const live = api.getCurrentTaskLocation() || {};
      const issueId = String(
        live.issueId || ""
      ).trim();

      if (issueId) {
        return {
          teamId: String(
            live.teamId || ""
          ).trim(),
          sessionId: String(
            live.sessionId || ""
          ).trim(),
          issueId
        };
      }
    }
  } catch (error) {
    console.warn(
      "Не удалось получить текущую задачу Team_poker:",
      error
    );
  }

  try {
    const rawHash =
      window.location.hash.replace(/^#/, "");

    if (!rawHash) {
      return null;
    }

    const params = new URLSearchParams(rawHash);
    const teamId = String(
      params.get("team") || ""
    ).trim();
    const sessionId = String(
      params.get("session") || ""
    ).trim();
    const issueId = String(
      params.get("issue") || ""
    ).trim();

    if (!issueId) {
      return null;
    }

    return {
      teamId,
      sessionId,
      issueId
    };
  } catch {
    return null;
  }
}

function mirroredDeliveryStatus(
  issueId,
  expectedRole = "",
  expectedTeamId = ""
) {
  const normalizedIssueId = String(
    issueId || ""
  ).trim();

  if (!normalizedIssueId) {
    return null;
  }

  const item =
    deliveryStatusSnapshotByIssueId.get(
      normalizedIssueId
    );

  if (!item || item.found !== true) {
    return null;
  }

  const mirroredRole = String(
    item.estimatedRole || ""
  ).trim();

  const normalizedRole = String(
    expectedRole || ""
  ).trim();

  if (
    normalizedRole
    && mirroredRole
    && mirroredRole !== normalizedRole
  ) {
    return null;
  }

  const mirroredTeamId = String(
    item.teamId || ""
  ).trim();

  const normalizedTeamId = String(
    expectedTeamId || ""
  ).trim();

  if (
    normalizedTeamId
    && mirroredTeamId
    && mirroredTeamId !== normalizedTeamId
  ) {
    return null;
  }

  return item;
}

function renderMirroredTeamCalculatorStatus(
  item,
  payload = null
) {
  if (!item) {
    return false;
  }

  const deliveryLabel = String(
    item?.delivery?.label || ""
  ).trim();

  const suffix = deliveryLabel
    ? ` · ${deliveryLabel}`
    : "";

  setStatus(
    payload?.reestimate?.required === true
      ? "Задача ранее была передана в Team_calculator и сейчас требует переоценки."
      : `Задача уже есть в Team_calculator${suffix}.`,
    "ok",
    payload && canManualRetry()
      ? retryCurrentPayload
      : null
  );

  return true;
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

function safeJobPart(value, maxLength = 40) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, maxLength);
}

function hashString(value) {
  let hash = 2166136261;

  for (
    let index = 0;
    index < String(value || "").length;
    index += 1
  ) {
    hash ^= String(value || "").charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function calculatorSyncJobId(payload) {
  return [
    "tc",
    safeJobPart(payload.taskId, 36),
    safeJobPart(payload.estimatedRole, 12),
    `v${Number(payload.estimateVersion || 0)}`,
    hashString(payloadKey(payload))
  ].join("__");
}

function calculatorSyncTeamId(payload) {
  return String(
    payload?.team?.id || ""
  ).trim();
}

function calculatorSyncSessionId(payload) {
  return String(
    payload?.session?.id || ""
  ).trim();
}

function calculatorSyncJobReference(payload) {
  const teamId = calculatorSyncTeamId(payload);

  if (!teamId) {
    return null;
  }

  return doc(
    calculatorSyncDatabase(),
    "teams",
    teamId,
    configuredSyncCollection(),
    calculatorSyncJobId(payload)
  );
}

function calculatorSyncDatabase() {
  if (calculatorSyncDb) {
    return calculatorSyncDb;
  }

  const app = getApp();
  calculatorSyncDb = getFirestore(app);
  return calculatorSyncDb;
}

function currentPayloadKey() {
  const payload = currentPayload();

  return payload
    ? payloadKey(payload)
    : null;
}

function terminalSyncJobStatus(data) {
  const status = String(
    data?.status || ""
  ).trim();

  return ["succeeded", "failed"].includes(status);
}

function syncResultStatus(data) {
  return String(
    data?.resultStatus || data?.status || "synced"
  ).trim() || "synced";
}

function stopCalculatorSyncJobWatch(key) {
  const unsubscribe =
    calculatorSyncJobUnsubscribers.get(key);

  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      // Best effort.
    }
  }

  calculatorSyncJobUnsubscribers.delete(key);
}

function watchCalculatorSyncJob(
  jobRef,
  payload,
  key
) {
  if (
    !jobRef
    || !payload
    || calculatorSyncJobUnsubscribers.has(key)
  ) {
    return;
  }

  const unsubscribe = onSnapshot(
    jobRef,
    snapshot => {
      if (!snapshot.exists()) {
        return;
      }

      const data = snapshot.data() || {};
      const status = String(
        data.status || ""
      ).trim();

      const isCurrent =
        currentPayloadKey() === key;

      if (
        status === "pending"
        || status === "processing"
      ) {
        writeStoredSync(payload, {
          status,
          jobId: jobRef.id,
          queuedAt:
            data.requestedAt
            || new Date().toISOString()
        });

        if (isCurrent) {
          setStatus(
            status === "processing"
              ? "Оценка обрабатывается connector и передаётся в Team_calculator…"
              : "Оценка поставлена в очередь Team_calculator. Ожидается connector…",
            "warn",
            null,
            canManualRetry()
          );
        }

        return;
      }

      if (status === "succeeded") {
        const resultStatus =
          syncResultStatus(data);

        writeStoredSync(payload, {
          status: resultStatus,
          jobId: jobRef.id,
          targetTaskId:
            data.targetTaskId || null,
          workspaceId:
            data.workspaceId || "main",
          syncedAt:
            data.completedAt
            || new Date().toISOString()
        });

        if (isCurrent) {
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
            "ok",
            canManualRetry()
              ? retryCurrentPayload
              : null
          );

          scheduleDeliveryStatusRefresh(500);
        }

        stopCalculatorSyncJobWatch(key);
        return;
      }

      if (status === "failed") {
        const error = String(
          data.error
          || "Неизвестная ошибка connector"
        );

        writeStoredSync(payload, {
          status: "error",
          jobId: jobRef.id,
          error,
          failedAt:
            data.completedAt
            || new Date().toISOString()
        });

        if (isCurrent) {
          setStatus(
            `Ошибка передачи в Team_calculator: ${error}.`,
            "error",
            canManualRetry()
              ? retryCurrentPayload
              : null
          );
        }

        stopCalculatorSyncJobWatch(key);
      }
    },
    error => {
      /*
        Ошибка realtime-listener не означает ошибку самой передачи.
        Firestore автоматически переподключится.
      */
      console.error(
        "Ошибка наблюдения за очередью Team_calculator",
        error
      );
    }
  );

  calculatorSyncJobUnsubscribers.set(
    key,
    unsubscribe
  );
}

async function ensureCurrentSyncJobWatch(
  payload,
  stored
) {
  if (
    !payload
    || !stored?.jobId
    || !currentUser
  ) {
    return;
  }

  const teamId =
    calculatorSyncTeamId(payload);

  if (!teamId) {
    return;
  }

  const key = payloadKey(payload);
  const jobRef = doc(
    calculatorSyncDatabase(),
    "teams",
    teamId,
    configuredSyncCollection(),
    stored.jobId
  );

  watchCalculatorSyncJob(
    jobRef,
    payload,
    key
  );
}

function renderCurrentState() {
  const location =
    currentTaskLocationFromHash();

  const mirroredTask = location
    ? mirroredTeamCalculatorTask(
        location.issueId,
        location.teamId
      )
    : null;

  renderTeamCalculatorTaskLink(
    mirroredTask
  );

  if (!currentUser) {
    setStatus(
      "Войдите, чтобы передавать оценки в Team_calculator."
    );
    return;
  }

  const payload = currentPayload();

  if (!payload) {
    const mirrored = location
      ? mirroredDeliveryStatus(
          location.issueId,
          "",
          location.teamId
        )
      : null;

    if (
      renderMirroredTeamCalculatorStatus(
        mirrored
      )
    ) {
      return;
    }

    setStatus(
      "После фиксации оценка будет автоматически поставлена в очередь Team_calculator."
    );
    return;
  }

  const key = payloadKey(payload);

  if (inFlightKey === key) {
    setStatus(
      "Оценка ставится в очередь Team_calculator…",
      "warn",
      null,
      canManualRetry()
    );
    return;
  }

  const stored = readStoredSync(payload);

  if (
    stored
    && ["synced", "ignored_stale", "reestimate_required"]
      .includes(stored.status)
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
      "ok",
      canManualRetry()
        ? retryCurrentPayload
        : null
    );

    scheduleDeliveryStatusRefresh(500);
    return;
  }

  if (
    stored
    && ["pending", "processing", "queued"]
      .includes(stored.status)
  ) {
    setStatus(
      stored.status === "processing"
        ? "Оценка обрабатывается connector и передаётся в Team_calculator…"
        : "Оценка находится в очереди Team_calculator. Ожидается connector…",
      "warn",
      null,
      canManualRetry()
    );

    ensureCurrentSyncJobWatch(
      payload,
      stored
    ).catch(error => {
      console.error(
        "Не удалось восстановить наблюдение за очередью Team_calculator",
        error
      );
    });

    return;
  }

  if (stored?.status === "error") {
    setStatus(
      `Последняя передача в Team_calculator завершилась ошибкой: ${
        stored.error || "неизвестная ошибка"
      }.`,
      "error",
      canManualRetry()
        ? retryCurrentPayload
        : null
    );
    return;
  }

  /*
    localStorage может быть пустым после очистки браузера,
    входа с другого компьютера или для старой передачи.
    Firestore delivery_status — серверный источник истины:
    если там есть found=true для этой задачи/роли, задача
    уже существует в Team_calculator.
  */
  const mirrored = mirroredDeliveryStatus(
    payload.taskId,
    payload.estimatedRole,
    payload?.team?.id || ""
  );

  if (
    renderMirroredTeamCalculatorStatus(
      mirrored,
      payload
    )
  ) {
    return;
  }

  setStatus(
    payload.reestimate?.required === true
      ? "Задача отмечена для передачи в список «На переоценку»."
      : "Оценка зафиксирована. Можно повторно передать текущую версию без создания новой оценки.",
    "warn",
    canManualRetry()
      ? retryCurrentPayload
      : null
  );
}


async function retryCurrentPayload() {
  if (!currentUser) {
    setStatus(
      "Войдите, чтобы повторно передать оценку в Team_calculator.",
      "error"
    );
    return;
  }

  if (!canManualRetry()) {
    setStatus(
      "Повторная передача доступна Администратору и Тимлиду.",
      "error"
    );
    return;
  }

  const payload = currentPayload();

  if (!payload) {
    setStatus(
      "Нет зафиксированной оценки для повторной передачи в Team_calculator.",
      "error"
    );
    return;
  }

  const teamId = calculatorSyncTeamId(payload);
  const sessionId = calculatorSyncSessionId(payload);

  if (!teamId || !sessionId) {
    setStatus(
      "В текущей оценке отсутствует команда или сессия Team_poker.",
      "error"
    );
    return;
  }

  const key = payloadKey(payload);

  if (inFlightKey === key) {
    setStatus(
      "Операция Team_calculator уже выполняется…",
      "warn",
      null,
      true
    );
    return;
  }

  inFlightKey = key;

  try {
    const requestPayload = {
      ...payload,
      finalizedBy: payload.finalizedBy || {
        uid: currentUser.uid,
        email: currentUser.email || null,
        displayName:
          currentUser.displayName || null
      },
      source: "team_poker"
    };

    const jobId = calculatorSyncJobId(requestPayload);
    const jobRef = calculatorSyncJobReference(requestPayload);

    if (!jobRef) {
      throw new Error(
        "Не удалось определить Firestore job Team_calculator."
      );
    }

    const snapshot = await getDoc(jobRef);
    const now = new Date().toISOString();

    if (!snapshot.exists()) {
      await setDoc(jobRef, {
        schemaVersion: 1,
        type: "sync_team_calculator_estimate",
        status: "pending",
        idempotencyKey: jobId,

        teamId,
        sessionId,
        issueId: requestPayload.taskId,
        estimatedRole: requestPayload.estimatedRole,
        eventType: requestPayload.eventType,
        finalEstimate: requestPayload.finalEstimate,
        estimateVersion: requestPayload.estimateVersion,

        payload: requestPayload,

        requestedByUid: currentUser.uid,
        requestedByEmail: currentUser.email || "",
        requestedByDisplayName:
          currentUser.displayName
          || currentUser.email
          || "",
        requestedAt: now,
        updatedAt: now,
        attempts: 0
      });
    } else {
      const data = snapshot.data() || {};
      const status = String(data.status || "").trim();

      if (["pending", "processing"].includes(status)) {
        writeStoredSync(payload, {
          status,
          jobId,
          queuedAt: data.requestedAt || now
        });

        watchCalculatorSyncJob(jobRef, payload, key);

        setStatus(
          status === "processing"
            ? "Оценка уже обрабатывается connector и передаётся в Team_calculator…"
            : "Оценка уже находится в очереди Team_calculator.",
          "warn",
          null,
          true
        );
        return;
      }

      if (!["failed", "succeeded"].includes(status)) {
        throw new Error(
          `Нельзя повторить job Team_calculator со статусом ${status || "—"}`
        );
      }

      await updateDoc(jobRef, {
        status: "pending",
        error: null,
        retryRequestedByUid: currentUser.uid,
        retryRequestedByEmail: currentUser.email || "",
        retryRequestedByDisplayName:
          currentUser.displayName
          || currentUser.email
          || "",
        retryRequestedAt: now,
        requestedAt: now,
        updatedAt: now
      });
    }

    writeStoredSync(payload, {
      status: "pending",
      jobId,
      queuedAt: now
    });

    watchCalculatorSyncJob(jobRef, payload, key);

    setStatus(
      `Повторная передача версии ${payload.estimateVersion} в Team_calculator поставлена в очередь.`,
      "warn",
      null,
      true
    );
  } catch (error) {
    console.error(
      "Ошибка повторной постановки оценки в очередь Team_calculator",
      error
    );

    writeStoredSync(payload, {
      status: "error",
      error: String(
        error?.message || error
      ).slice(0, 1000),
      failedAt: new Date().toISOString()
    });

    setStatus(
      `Ошибка повторной передачи в Team_calculator: ${
        error?.message || error
      }.`,
      "error",
      retryCurrentPayload
    );
  } finally {
    if (inFlightKey === key) {
      inFlightKey = null;
    }
  }
}

async function sendPayload(payload) {
  if (!currentUser) {
    return {
      ok: false,
      error: "Пользователь не авторизован."
    };
  }

  const teamId =
    calculatorSyncTeamId(payload);

  const sessionId =
    calculatorSyncSessionId(payload);

  if (!teamId || !sessionId) {
    return {
      ok: false,
      error:
        "В payload отсутствует команда или сессия Team_poker."
    };
  }

  const key = payloadKey(payload);

  if (inFlightKey === key) {
    return {
      ok: true,
      status: "pending"
    };
  }

  const stored = readStoredSync(payload);

  if (
    stored
    && ["synced", "ignored_stale", "reestimate_required"]
      .includes(stored.status)
  ) {
    return {
      ok: true,
      status: stored.status,
      targetTaskId:
        stored.targetTaskId || null,
      workspaceId:
        stored.workspaceId || "main",
      reusedStoredResult: true
    };
  }

  inFlightKey = key;

  setStatus(
    "Оценка ставится в очередь Team_calculator…",
    "warn",
    null,
    canManualRetry()
  );

  try {
    const requestPayload = {
      ...payload,
      finalizedBy: payload.finalizedBy || {
        uid: currentUser.uid,
        email: currentUser.email || null,
        displayName:
          currentUser.displayName || null
      },
      source: "team_poker"
    };

    const jobId =
      calculatorSyncJobId(requestPayload);

    const jobRef = doc(
      calculatorSyncDatabase(),
      "teams",
      teamId,
      configuredSyncCollection(),
      jobId
    );

    const existing =
      await getDoc(jobRef);

    if (!existing.exists()) {
      const now =
        new Date().toISOString();

      const job = {
        schemaVersion: 1,
        type:
          "sync_team_calculator_estimate",
        status: "pending",
        idempotencyKey: jobId,

        teamId,
        sessionId,
        issueId: requestPayload.taskId,
        estimatedRole:
          requestPayload.estimatedRole,
        eventType:
          requestPayload.eventType,
        finalEstimate:
          requestPayload.finalEstimate,
        estimateVersion:
          requestPayload.estimateVersion,

        payload: requestPayload,

        requestedByUid:
          currentUser.uid,
        requestedByEmail:
          currentUser.email || "",
        requestedByDisplayName:
          currentUser.displayName
          || currentUser.email
          || "",
        requestedAt: now,
        updatedAt: now,
        attempts: 0
      };

      try {
        await setDoc(jobRef, job);
      } catch (createError) {
        /*
          Если другая вкладка успела создать тот же детерминированный
          job между getDoc() и setDoc(), просто используем существующий.
        */
        const replay =
          await getDoc(jobRef);

        if (!replay.exists()) {
          throw createError;
        }
      }
    }

    writeStoredSync(payload, {
      status: "pending",
      jobId,
      queuedAt:
        new Date().toISOString()
    });

    watchCalculatorSyncJob(
      jobRef,
      payload,
      key
    );

    setStatus(
      "Оценка поставлена в очередь Team_calculator. Ожидается connector…",
      "warn",
      null,
      canManualRetry()
    );

    return {
      ok: true,
      status: "queued",
      jobId,
      workspaceId: "main"
    };
  } catch (error) {
    console.error(
      "Ошибка постановки оценки в очередь Team_calculator",
      error
    );

    writeStoredSync(payload, {
      status: "error",
      error: String(
        error?.message || error
      ).slice(0, 1000),
      failedAt:
        new Date().toISOString()
    });

    setStatus(
      `Ошибка постановки в очередь Team_calculator: ${
        error?.message || error
      }.`,
      "error",
      canManualRetry()
        ? retryCurrentPayload
        : null
    );

    return {
      ok: false,
      error: String(
        error?.message || error
      )
    };
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

        /*
          Обновляем и основной статус в открытой карточке.
          Раньше realtime delivery_status обновлял только
          статусы списка задач, а карточка продолжала
          опираться на localStorage.
        */
        renderCurrentState();
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

function refreshIntegrationUi() {
  renderCurrentState();
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
      refreshIntegrationUi();
      scheduleDeliveryStatusRefresh(100);
    });

    window.addEventListener(
      "hashchange",
      () => {
        setTimeout(refreshIntegrationUi, 300);
        scheduleDeliveryStatusRefresh(350);
      }
    );

    window.addEventListener(
      "team-poker:task-changed",
      () => {
        /*
          Обновляем href по открытой задаче сразу.
          Firestore перечитывать для этого не нужно:
          delivery_status уже закэширован по issueId.
        */
        renderCurrentState();
      }
    );

    window.addEventListener(
      "team-poker:issues-changed",
      () => {
        renderDeliveryStatusSnapshot();
        renderCurrentState();
        scheduleDeliveryStatusRefresh(200);
      }
    );

    // Передача оценки выполняется только явным вызовом
    // TeamCalculatorIntegration.syncPayload() после фиксации
    // или при специальном действии переноса.

    window.addEventListener(
      "beforeunload",
      () => {
        if (statusRefreshTimer) {
          clearTimeout(statusRefreshTimer);
        }
        stopDeliveryStatusSubscription();

        for (
          const key
          of [...calculatorSyncJobUnsubscribers.keys()]
        ) {
          stopCalculatorSyncJobWatch(key);
        }
      },
      { once: true }
    );

    refreshIntegrationUi();
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

window.TeamCalculatorIntegration = {
  async syncPayload(payload) {
    if (
      !payload
      || typeof payload !== "object"
    ) {
      return {
        ok: false,
        error:
          "Некорректный payload Team_calculator."
      };
    }

    const stored =
      readStoredSync(payload);

    if (
      stored
      && ["synced", "ignored_stale"]
        .includes(stored.status)
    ) {
      return {
        ok: true,
        status: stored.status,
        targetTaskId:
          stored.targetTaskId || null,
        workspaceId:
          stored.workspaceId || "main",
        reusedStoredResult: true
      };
    }

    const result =
      await sendPayload(payload);

    if (result) {
      return result;
    }

    const after =
      readStoredSync(payload);

    if (
      after
      && ["synced", "ignored_stale"]
        .includes(after.status)
    ) {
      return {
        ok: true,
        status: after.status,
        targetTaskId:
          after.targetTaskId || null,
        workspaceId:
          after.workspaceId || "main",
        reusedStoredResult: true
      };
    }

    return {
      ok: false,
      error:
        after?.error
        || "Не удалось синхронизировать Team_calculator."
    };
  }
};

start();
