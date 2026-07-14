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
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const config =
  window.GITLAB_CONNECTOR_INTEGRATION || {};

const POLL_INTERVAL_MS = 1600;
const RETRY_DELAY_MS = 30000;

let currentUser = null;
let db = null;
let timer = null;
let inFlightKey = null;
let lastRetryAt = 0;

function addStyles() {
  if (document.getElementById("gitlabConnectorStatusStyle")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "gitlabConnectorStatusStyle";
  style.textContent = `
    .gitlab-connector-box{
      margin-top:12px;
      padding:10px 12px;
      border:1px solid #d9dde7;
      border-radius:10px;
      background:#f8f9fc;
      font-size:13px;
      line-height:1.45;
    }
    .gitlab-connector-box.ok{
      color:#137333;
      border-color:#bfe6ca;
      background:#eef9f1;
    }
    .gitlab-connector-box.warn{
      color:#8a5a12;
      border-color:#e9cf9a;
      background:#fff8e9;
    }
    .gitlab-connector-box.error{
      color:#b3261e;
      border-color:#f5b7b1;
      background:#fff3f2;
    }
    .gitlab-connector-box .gitlab-retry{
      margin-top:8px;
      border:0;
      border-radius:8px;
      padding:7px 10px;
      background:#edf1f7;
      color:#172033;
      font-weight:700;
      cursor:pointer;
    }
  `;

  document.head.appendChild(style);
}

function ensureBox() {
  addStyles();

  let box = document.getElementById("gitlabConnectorStatusBox");
  if (box) return box;

  const calculatorBox =
    document.getElementById("teamCalculatorSyncBox");
  const finalMessage =
    document.getElementById("finalMessage");
  const anchor = calculatorBox || finalMessage;

  if (!anchor) return null;

  box = document.createElement("div");
  box.id = "gitlabConnectorStatusBox";
  box.className = "gitlab-connector-box";
  box.textContent =
    "После фиксации оценка будет поставлена в очередь GitLab.";

  anchor.insertAdjacentElement("afterend", box);
  return box;
}

function setStatus(text, type = "", retryHandler = null) {
  const box = ensureBox();
  if (!box) return;

  box.className =
    "gitlab-connector-box"
    + (type ? ` ${type}` : "");

  box.textContent = text;

  if (retryHandler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gitlab-retry";
    button.textContent = "Повторить отправку";
    button.addEventListener("click", retryHandler);
    box.appendChild(document.createElement("br"));
    box.appendChild(button);
  }
}

function configured() {
  const baseUrl = String(config.gitlabBaseUrl || "").trim();

  return Boolean(
    config.enabled !== false
    && baseUrl
    && !baseUrl.includes("REPLACE_")
  );
}

function currentDescriptor() {
  const api = window.TeamPokerIntegration;

  if (
    !api
    || typeof api.getCurrentGitLabJobDescriptor !== "function"
  ) {
    return null;
  }

  return api.getCurrentGitLabJobDescriptor();
}

function jobReference(descriptor) {
  return doc(
    db,
    "teams", descriptor.teamId,
    descriptor.collectionName || "gitlab_jobs",
    descriptor.id
  );
}

function humanDate(value) {
  if (!value) return "";

  const date = typeof value.toDate === "function"
    ? value.toDate()
    : null;

  return date
    ? date.toLocaleString("ru-RU")
    : "";
}

async function retryJob(ref, descriptor) {
  const now = Date.now();

  if (now - lastRetryAt < RETRY_DELAY_MS) {
    setStatus(
      "Повторная отправка уже запрошена. Подождите немного.",
      "warn"
    );
    return;
  }

  lastRetryAt = now;

  try {
    await updateDoc(ref, {
      status: "pending",
      lastError: null,
      nextAttemptAt: null,
      retryRequestedByUid: currentUser.uid,
      retryRequestedByEmail: currentUser.email || "",
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    setStatus(
      "Повторная отправка поставлена в очередь. Коннектор выполнит её после подключения VPN.",
      "warn"
    );
  } catch (error) {
    console.error(error);
    setStatus(
      "Не удалось повторно поставить задание в очередь.",
      "error",
      () => retryJob(ref, descriptor)
    );
  }
}

async function render() {
  if (!configured()) {
    setStatus(
      "GitLab-интеграция не настроена: укажите gitlabBaseUrl в gitlab-integration-config.js.",
      "error"
    );
    return;
  }

  if (!currentUser || !db) {
    setStatus(
      "Войдите в Team_poker, чтобы видеть статус GitLab."
    );
    return;
  }

  const descriptor = currentDescriptor();

  if (!descriptor) {
    setStatus(
      "После фиксации оценки задача будет автоматически поставлена в очередь GitLab."
    );
    return;
  }

  const key = [
    descriptor.teamId,
    descriptor.id
  ].join(":");

  if (inFlightKey === key) return;
  inFlightKey = key;

  try {
    const ref = jobReference(descriptor);
    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
      setStatus(
        "Для этой оценки ещё нет задания GitLab. Повторно зафиксируйте оценку под ролью Администратор или Тимлид.",
        "warn"
      );
      return;
    }

    const job = snapshot.data();

    if (job.status === "pending") {
      setStatus(
        "Ожидает Mac-коннектор. Включите MacBook и подключите корпоративный VPN.",
        "warn"
      );
      return;
    }

    if (job.status === "processing") {
      setStatus(
        "Mac-коннектор передаёт оценку в GitLab…",
        "warn"
      );
      return;
    }

    if (job.status === "succeeded") {
      const completedAt = humanDate(job.completedAt);
      const estimate =
        job.gitlabResult?.humanTimeEstimate
        || `${descriptor.finalEstimate} д.`;

      setStatus(
        `Передано в GitLab: ${estimate}; метка ${job.gitlabLabel || "estimate::done"} установлена`
        + (completedAt ? ` · ${completedAt}` : ""),
        "ok"
      );
      return;
    }

    if (job.status === "failed") {
      setStatus(
        `Ошибка передачи в GitLab: ${job.lastError || "неизвестная ошибка"}`,
        "error",
        () => retryJob(ref, descriptor)
      );
      return;
    }

    setStatus(
      `Неизвестный статус задания GitLab: ${job.status || "—"}.`,
      "warn"
    );
  } catch (error) {
    console.error(error);
    setStatus(
      "Не удалось получить статус задания GitLab.",
      "error"
    );
  } finally {
    inFlightKey = null;
  }
}

function schedule() {
  clearInterval(timer);
  render();
  timer = setInterval(render, POLL_INTERVAL_MS);
}

if (!getApps().length) {
  setStatus(
    "Firebase ещё не инициализирован. Обновите страницу.",
    "error"
  );
} else {
  const app = getApp();
  const auth = getAuth(app);

  const databaseId =
    window.PLANNING_POKER_CONFIG?.firestoreDatabaseId;

  db = databaseId && databaseId !== "(default)"
    ? getFirestore(app, databaseId)
    : getFirestore(app);

  onAuthStateChanged(auth, user => {
    currentUser = user;
    schedule();
  });

  window.addEventListener(
    "hashchange",
    () => setTimeout(render, 0)
  );

  document.addEventListener(
    "click",
    () => setTimeout(render, 100)
  );
}
