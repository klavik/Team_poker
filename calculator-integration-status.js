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
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const runtimeConfig = window.PLANNING_POKER_CONFIG || {};
const integrationConfig =
  window.TEAM_CALCULATOR_INTEGRATION || {};

let unsubscribeIssue = null;
let syncInFlightKey = null;
let currentAuthUser = null;

function integrationStyle() {
  if (document.getElementById("teamCalculatorIntegrationStyle")) return;

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

  const oldButton = [...document.querySelectorAll("button")].find(button =>
    /^copyTeam/i.test(button.id || "")
    || /^Данные\s+Team_/i.test(
      (button.textContent || "").trim()
    )
  );

  if (oldButton) oldButton.style.display = "none";

  let box = document.getElementById("teamCalculatorSyncBox");
  if (box) return box;

  box = document.createElement("div");
  box.id = "teamCalculatorSyncBox";
  box.className = "team-calculator-sync-box";
  box.textContent =
    "После фиксации оценка будет автоматически передана в Team_calculator.";

  const anchor = document.getElementById("finalMessage");
  if (anchor) {
    anchor.insertAdjacentElement("afterend", box);
  }

  return box;
}

function setStatus(text, type = "") {
  const box = ensureStatusBox();
  if (!box) return;

  box.textContent = text;
  box.className =
    "team-calculator-sync-box"
    + (type ? ` ${type}` : "");
}

function currentIssueLink() {
  const params = new URLSearchParams(
    window.location.hash.replace(/^#/, "")
  );

  const teamId = params.get("team");
  const sessionId = params.get("session");
  const issueId = params.get("issue");

  if (!teamId || !sessionId || !issueId) return null;

  return {
    teamId,
    sessionId,
    issueId
  };
}

function isFinalEstimate(issue) {
  return issue
    && issue.status === "estimated"
    && ["backend", "frontend"].includes(issue.estimatedRole)
    && Number.isFinite(Number(issue.finalEstimate))
    && Number(issue.finalEstimate) > 0;
}

function timestampToIso(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (typeof value.toMillis === "function") {
    return new Date(value.toMillis()).toISOString();
  }

  if (value.seconds) {
    return new Date(value.seconds * 1000).toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function syncVersion(issue) {
  return Math.max(1, Number(issue.estimateVersion) || 1);
}

function shouldSync(issue) {
  if (!isFinalEstimate(issue)) return false;

  const version = syncVersion(issue);
  const sync = issue.calculatorSync || {};

  if (sync.status === "sending" && sync.estimateVersion === version) {
    return false;
  }

  if (
    ["synced", "ignored_stale"].includes(sync.status)
    && Number(sync.estimateVersion) >= version
  ) {
    return false;
  }

  return true;
}

function renderSync(issue) {
  if (!integrationConfig.endpoint
      || integrationConfig.endpoint.includes("REPLACE_")) {
    setStatus(
      "Интеграция с Team_calculator не настроена: укажите URL Cloudflare Worker.",
      "error"
    );
    return;
  }

  if (!isFinalEstimate(issue)) {
    setStatus(
      "После фиксации оценка будет автоматически передана в Team_calculator."
    );
    return;
  }

  const sync = issue.calculatorSync || {};

  if (sync.status === "synced") {
    setStatus(
      `Передано в общий пул Team_calculator · версия ${
        sync.estimateVersion || "—"
      }.`,
      "ok"
    );
    return;
  }

  if (sync.status === "ignored_stale") {
    setStatus(
      "Передача пропущена: в Team_calculator уже есть более новая версия.",
      "warn"
    );
    return;
  }

  if (sync.status === "error") {
    setStatus(
      `Ошибка передачи в Team_calculator: ${
        sync.lastError || "повтор будет выполнен при следующем открытии задачи"
      }.`,
      "error"
    );
    return;
  }

  setStatus(
    "Оценка передаётся в общий пул Team_calculator…",
    "warn"
  );
}

async function readNames(db, link, issue) {
  const [teamSnapshot, sessionSnapshot] = await Promise.all([
    getDoc(doc(db, "teams", link.teamId)),
    getDoc(
      doc(
        db,
        "teams",
        link.teamId,
        "sessions",
        link.sessionId
      )
    )
  ]);

  return {
    teamName:
      issue.estimatedTeamName
      || teamSnapshot.data()?.name
      || "",
    sessionName:
      sessionSnapshot.data()?.name
      || ""
  };
}

async function writeSyncState(issueRef, state) {
  await setDoc(
    issueRef,
    {
      calculatorSync: {
        ...state,
        updatedAt: new Date().toISOString()
      }
    },
    { merge: true }
  );
}

async function sendIssue(db, link, issue) {
  if (!currentAuthUser) return;
  if (!shouldSync(issue)) return;

  const version = syncVersion(issue);
  const inFlightKey =
    `${link.teamId}/${link.sessionId}/${link.issueId}/v${version}`;

  if (syncInFlightKey === inFlightKey) return;
  syncInFlightKey = inFlightKey;

  const issueRef = doc(
    db,
    "teams",
    link.teamId,
    "sessions",
    link.sessionId,
    "issues",
    link.issueId
  );

  try {
    await writeSyncState(issueRef, {
      status: "sending",
      estimateVersion: version,
      lastError: null
    });

    const names = await readNames(db, link, issue);
    const token = await currentAuthUser.getIdToken();

    const payload = {
      taskId: link.issueId,
      title: String(issue.title || "").trim(),
      externalTaskUrl:
        issue.gitlabUrl
        || issue.externalTaskUrl
        || issue.url
        || null,
      estimatedRole: issue.estimatedRole,
      finalEstimate: Number(issue.finalEstimate),
      estimateVersion: version,
      finalizedAt: timestampToIso(issue.finalizedAt),
      finalizedBy: {
        uid:
          issue.finalizedByUid
          || currentAuthUser.uid,
        email:
          issue.finalizedByEmail
          || currentAuthUser.email
          || null,
        displayName:
          issue.finalizedByDisplayName
          || currentAuthUser.displayName
          || null
      },
      team: {
        id: issue.estimatedTeamId || link.teamId,
        name: names.teamName
      },
      session: {
        id: link.sessionId,
        name: names.sessionName
      },
      source: "team_poker"
    };

    const response = await fetch(integrationConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok !== true) {
      throw new Error(
        result.error
        || `HTTP ${response.status}`
      );
    }

    await writeSyncState(issueRef, {
      status: result.status || "synced",
      targetTaskId: result.taskId || null,
      workspaceId: result.workspaceId || "main",
      estimateVersion: version,
      syncedAt: new Date().toISOString(),
      lastError: null
    });
  } catch (error) {
    console.error(error);

    try {
      await writeSyncState(issueRef, {
        status: "error",
        estimateVersion: version,
        lastError: String(
          error?.message || error
        ).slice(0, 1000)
      });
    } catch (stateError) {
      console.error(stateError);
    }
  } finally {
    if (syncInFlightKey === inFlightKey) {
      syncInFlightKey = null;
    }
  }
}

function subscribeToCurrentIssue(db) {
  if (typeof unsubscribeIssue === "function") {
    unsubscribeIssue();
    unsubscribeIssue = null;
  }

  const link = currentIssueLink();

  if (!link) {
    setStatus(
      "Откройте задачу. После фиксации оценка будет передана автоматически."
    );
    return;
  }

  unsubscribeIssue = onSnapshot(
    doc(
      db,
      "teams",
      link.teamId,
      "sessions",
      link.sessionId,
      "issues",
      link.issueId
    ),
    snapshot => {
      const issue = snapshot.exists()
        ? snapshot.data()
        : null;

      renderSync(issue);

      if (issue) {
        sendIssue(db, link, issue);
      }
    },
    error => {
      console.error(error);
      setStatus(
        "Не удалось прочитать статус передачи в Team_calculator.",
        "error"
      );
    }
  );
}

async function waitForFirebaseApp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getApps().length) return getApp();

    await new Promise(resolve => setTimeout(resolve, 100));
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
    const db = getFirestore(
      app,
      runtimeConfig.firestoreDatabaseId || "(default)"
    );

    onAuthStateChanged(auth, user => {
      currentAuthUser = user || null;

      if (user) {
        subscribeToCurrentIssue(db);
      } else {
        if (typeof unsubscribeIssue === "function") {
          unsubscribeIssue();
        }

        setStatus(
          "Войдите, чтобы передавать оценки в Team_calculator."
        );
      }
    });

    window.addEventListener(
      "hashchange",
      () => subscribeToCurrentIssue(db)
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message, "error");
  }
}

start();
