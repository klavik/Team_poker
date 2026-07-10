import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";

import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  where,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  enableNetwork,
  disableNetwork
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const SCALE = [0.5, 1, 2, 3, 5, 8, 13];
const runtimeConfig = window.PLANNING_POKER_CONFIG || {};
const firebaseConfig = runtimeConfig.firebaseConfig || {};

const state = {
  teams: [],
  teamId: null,
  members: [],
  role: null,
  sessions: [],
  sessionId: null,
  issues: [],
  issueId: null,
  issue: null,
  voteStatuses: [],
  votes: [],
  myVote: null
};

let firebaseApp = null;
let auth = null;
let db = null;
let currentUser = null;

let unsubscribeTeams = null;
let unsubscribeMembers = null;
let unsubscribeSessions = null;
let unsubscribeIssues = null;
let unsubscribeOwnVote = null;
let unsubscribeVoteStatuses = null;
let unsubscribeVotes = null;
let activeVoteSubscriptionKey = null;

const $ = id => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function show(element, visible = true) {
  element.classList.toggle("hidden", !visible);
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  return 0;
}

function currentTeam() {
  return state.teams.find(team => team.id === state.teamId) || null;
}

function currentSession() {
  return state.sessions.find(session => session.id === state.sessionId) || null;
}

function isLead() {
  const email = normalizeEmail(currentUser?.email);
  const team = currentTeam();

  return Boolean(
    team &&
    (
      email === team.ownerEmail ||
      (Array.isArray(team.leadEmails) && team.leadEmails.includes(email))
    )
  );
}

function validFirebaseConfig() {
  return Boolean(
    firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId &&
    !String(firebaseConfig.apiKey).includes("YOUR_") &&
    !String(firebaseConfig.projectId).includes("YOUR_")
  );
}

function isNetworkError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();

  return [
    "network-request-failed",
    "unavailable",
    "deadline-exceeded",
    "failed-precondition"
  ].some(fragment => code.includes(fragment))
    || [
      "network",
      "offline",
      "failed to fetch",
      "timeout",
      "timed out",
      "unavailable"
    ].some(fragment => message.includes(fragment));
}

function friendlyError(error) {
  const code = String(error?.code || "");
  const messages = {
    "auth/invalid-credential": "Неверный email или пароль.",
    "auth/invalid-login-credentials": "Неверный email или пароль.",
    "auth/user-disabled": "Учетная запись отключена.",
    "auth/too-many-requests": "Слишком много попыток. Повторите позже.",
    "auth/weak-password": "Новый пароль не соответствует политике сложности.",
    "auth/requires-recent-login": "Необходимо повторно подтвердить текущий пароль.",
    "auth/network-request-failed": "Firebase временно недоступен. Проверьте соединение.",
    "permission-denied": "Недостаточно прав для выполнения действия.",
    "firestore/permission-denied": "Недостаточно прав для выполнения действия.",
    "firestore/unavailable": "Firestore временно недоступен.",
    "firestore/failed-precondition": "Операция временно недоступна или требуется настройка Firestore."
  };

  if (messages[code]) return messages[code];
  if (isNetworkError(error)) return "Firebase временно недоступен. Данные синхронизируются после восстановления связи.";

  return String(error?.message || error || "Неизвестная ошибка");
}

function setFormMessage(element, text = "", type = "error") {
  if (!text) {
    element.innerHTML = "";
    return;
  }

  element.innerHTML = `<div class="message ${type}">${escapeHtml(text)}</div>`;
}

function toast(text, type = "error", duration = 5000) {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = text;
  $("toastContainer").appendChild(item);
  setTimeout(() => item.remove(), duration);
}

function showConnectionProblem(text = "Нет связи с Firebase. Показываем локально сохранённые данные.") {
  const banner = $("connectionBanner");
  banner.textContent = text;
  banner.className = "connection-banner";
}

function hideConnectionProblem() {
  $("connectionBanner").className = "connection-banner hidden";
}

function handleError(error, target = null) {
  console.error(error);
  const text = friendlyError(error);

  if (isNetworkError(error)) {
    showConnectionProblem(text);
  }

  if (target) {
    setFormMessage(target, text);
  } else if (!isNetworkError(error)) {
    toast(text);
  }
}

async function withButton(button, busyText, operation) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;

  try {
    return await operation();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
}

function unsubscribe(fn) {
  if (typeof fn === "function") fn();
}

function clearVoteListeners() {
  unsubscribe(unsubscribeOwnVote);
  unsubscribe(unsubscribeVoteStatuses);
  unsubscribe(unsubscribeVotes);

  unsubscribeOwnVote = null;
  unsubscribeVoteStatuses = null;
  unsubscribeVotes = null;
  activeVoteSubscriptionKey = null;

  state.voteStatuses = [];
  state.votes = [];
  state.myVote = null;
}

function clearIssueListener() {
  unsubscribe(unsubscribeIssues);
  unsubscribeIssues = null;
  clearVoteListeners();
}

function clearTeamListeners() {
  unsubscribe(unsubscribeMembers);
  unsubscribe(unsubscribeSessions);
  unsubscribeMembers = null;
  unsubscribeSessions = null;
  clearIssueListener();
}

function clearAllListeners() {
  unsubscribe(unsubscribeTeams);
  unsubscribeTeams = null;
  clearTeamListeners();
}

async function init() {
  bindEvents();
  renderPokerCards();

  if (!validFirebaseConfig()) {
    show($("configError"));
    return;
  }

  firebaseApp = initializeApp(firebaseConfig);
  auth = getAuth(firebaseApp);
  await setPersistence(auth, browserLocalPersistence);

  const cache = runtimeConfig.enablePersistentCache === false
    ? memoryLocalCache()
    : persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      });

  db = initializeFirestore(
    firebaseApp,
    { localCache: cache },
    runtimeConfig.firestoreDatabaseId || "(default)"
  );

  onAuthStateChanged(auth, user => {
    currentUser = user;
    renderAuth();

    if (user) {
      startTeamsListener();
    } else {
      clearAllListeners();
      resetState();
    }
  });
}

function bindEvents() {
  $("loginBtn").addEventListener("click", login);
  $("logoutBtn").addEventListener("click", logout);
  $("syncBtn").addEventListener("click", synchronize);

  $("changePasswordBtn").addEventListener("click", openPasswordDialog);
  $("savePasswordBtn").addEventListener("click", changePassword);
  $("cancelPasswordBtn").addEventListener("click", closePasswordDialog);

  $("openTeamDialogBtn").addEventListener("click", () => openDialog("teamDialog"));
  $("createTeamBtn").addEventListener("click", createTeam);
  $("deleteTeamBtn").addEventListener("click", deleteTeam);
  $("manageMembersBtn").addEventListener("click", openMembersDialog);
  $("addMemberBtn").addEventListener("click", addMember);

  $("openSessionDialogBtn").addEventListener("click", () => openDialog("sessionDialog"));
  $("createSessionBtn").addEventListener("click", createSession);
  $("finishSessionBtn").addEventListener("click", finishSession);
  $("deleteSessionBtn").addEventListener("click", deleteSession);

  $("openIssueDialogBtn").addEventListener("click", () => openDialog("issueDialog"));
  $("createIssueBtn").addEventListener("click", createIssue);

  $("finalizeBtn").addEventListener("click", finalizeEstimate);
  $("copyEstimateBtn").addEventListener("click", copyEstimate);

  $("teamSelect").addEventListener("change", event => selectTeam(event.target.value));
  $("sessionSelect").addEventListener("change", event => selectSession(event.target.value));

  document.querySelectorAll("[data-close-dialog]").forEach(button => {
    button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
  });

  $("loginEmail").addEventListener("keydown", event => {
    if (event.key === "Enter") $("loginPassword").focus();
  });

  $("loginPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });

  $("currentPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") $("newPassword").focus();
  });

  $("newPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") $("confirmNewPassword").focus();
  });

  $("confirmNewPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") changePassword();
  });

  window.addEventListener("online", () => {
    hideConnectionProblem();
    synchronize(false);
  });

  window.addEventListener("offline", () => {
    showConnectionProblem("Нет подключения к интернету. Изменения будут сохранены локально.");
  });
}

function renderAuth() {
  show($("loginView"), !currentUser);
  show($("appView"), Boolean(currentUser));
  show($("userBox"), Boolean(currentUser));

  if (currentUser) {
    $("userEmail").textContent = currentUser.email || "";
  }
}

async function login() {
  const email = normalizeEmail($("loginEmail").value);
  const password = $("loginPassword").value;
  const target = $("loginMessage");

  setFormMessage(target);

  if (!email) return setFormMessage(target, "Укажите email.");
  if (!password) return setFormMessage(target, "Укажите пароль.");

  await withButton($("loginBtn"), "Вход...", async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      $("loginPassword").value = "";
    } catch (error) {
      handleError(error, target);
    }
  });
}

async function logout() {
  try {
    await signOut(auth);
  } catch (error) {
    handleError(error);
  }
}

async function synchronize(showSuccess = true) {
  if (!db) return;

  await withButton($("syncBtn"), "Синхронизация...", async () => {
    try {
      await disableNetwork(db);
      await enableNetwork(db);
      hideConnectionProblem();
      if (showSuccess) toast("Синхронизация запущена.", "success", 2500);
    } catch (error) {
      handleError(error);
    }
  });
}

function resetState() {
  Object.assign(state, {
    teams: [],
    teamId: null,
    members: [],
    role: null,
    sessions: [],
    sessionId: null,
    issues: [],
    issueId: null,
    issue: null,
    voteStatuses: [],
    votes: [],
    myVote: null
  });

  renderTeams();
  renderMembers();
  renderSessions();
  renderIssues();
  renderTeamControls();

  show($("welcomeCard"));
  show($("issueCard"), false);
}

function startTeamsListener() {
  clearAllListeners();

  const email = normalizeEmail(currentUser?.email);
  const teamsQuery = query(
    collection(db, "teams"),
    where("memberEmails", "array-contains", email)
  );

  unsubscribeTeams = onSnapshot(
    teamsQuery,
    { includeMetadataChanges: true },
    snapshot => {
      state.teams = snapshot.docs
        .map(teamDoc => ({ id: teamDoc.id, ...teamDoc.data() }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));

      if (!snapshot.metadata.fromCache) hideConnectionProblem();

      const storedTeamId = localStorage.getItem("planningPoker.firebase.teamId");
      const nextTeamId = state.teams.some(team => team.id === state.teamId)
        ? state.teamId
        : state.teams.some(team => team.id === storedTeamId)
          ? storedTeamId
          : state.teams[0]?.id || null;

      renderTeams();

      if (nextTeamId !== state.teamId) {
        selectTeam(nextTeamId);
      } else {
        renderTeamControls();
      }

      if (!nextTeamId) resetTeamDependentState();
    },
    error => handleError(error)
  );
}

function renderTeams() {
  $("teamSelect").innerHTML = state.teams.length
    ? state.teams.map(team => `
        <option value="${team.id}" ${team.id === state.teamId ? "selected" : ""}>
          ${escapeHtml(team.name)}
        </option>
      `).join("")
    : '<option value="">Нет команд</option>';
}

function selectTeam(teamId) {
  if (teamId === state.teamId && unsubscribeMembers && unsubscribeSessions) {
    renderTeams();
    renderTeamControls();
    return;
  }

  clearTeamListeners();

  state.teamId = teamId || null;
  state.members = [];
  state.sessions = [];
  state.sessionId = null;
  state.issues = [];
  state.issueId = null;
  state.issue = null;

  localStorage.setItem("planningPoker.firebase.teamId", state.teamId || "");
  renderTeams();

  if (!state.teamId) {
    resetTeamDependentState();
    return;
  }

  startMembersListener();
  startSessionsListener();
  renderTeamControls();
}

function resetTeamDependentState() {
  clearTeamListeners();

  state.teamId = null;
  state.members = [];
  state.role = null;
  state.sessions = [];
  state.sessionId = null;
  state.issues = [];
  state.issueId = null;
  state.issue = null;

  renderMembers();
  renderSessions();
  renderIssues();
  renderTeamControls();

  $("teamRole").textContent = "Создайте команду или попросите тимлида добавить ваш email.";
  show($("welcomeCard"));
  show($("issueCard"), false);
}

function startMembersListener() {
  const membersRef = collection(db, "teams", state.teamId, "members");

  unsubscribeMembers = onSnapshot(
    membersRef,
    { includeMetadataChanges: true },
    snapshot => {
      state.members = snapshot.docs
        .map(memberDoc => ({ id: memberDoc.id, ...memberDoc.data() }))
        .filter(member => member.active !== false)
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "ru"));

      const email = normalizeEmail(currentUser?.email);
      state.role = state.members.find(member => member.email === email)?.role || null;

      renderMembers();
      renderTeamControls();
      renderIssue();
    },
    error => handleError(error)
  );
}

function renderTeamControls() {
  const lead = isLead();

  $("teamRole").textContent = state.teamId
    ? `Ваша роль: ${lead ? "тимлид" : state.role === "member" ? "участник" : "нет активного членства"}`
    : "Команда не выбрана.";

  $("openSessionDialogBtn").disabled = !lead || !state.teamId;
  $("deleteTeamBtn").disabled = !lead || !state.teamId;
  $("manageMembersBtn").disabled = !state.teamId;

  $("openIssueDialogBtn").disabled = !lead || !state.sessionId;
  $("finishSessionBtn").disabled = !lead || !state.sessionId;
  $("deleteSessionBtn").disabled = !lead || !state.sessionId;
}

async function createTeam() {
  const name = $("newTeamName").value.trim();
  const target = $("teamDialogMessage");

  setFormMessage(target);
  if (!name) return setFormMessage(target, "Укажите название команды.");

  await withButton($("createTeamBtn"), "Создание...", async () => {
    try {
      const email = normalizeEmail(currentUser.email);
      const teamRef = await addDoc(collection(db, "teams"), {
        name,
        ownerUid: currentUser.uid,
        ownerEmail: email,
        memberEmails: [email],
        leadEmails: [email],
        createdAt: serverTimestamp()
      });

      await setDoc(doc(db, "teams", teamRef.id, "members", email), {
        email,
        displayName: currentUser.displayName || email,
        role: "lead",
        active: true,
        createdAt: serverTimestamp()
      });

      $("newTeamName").value = "";
      closeDialog("teamDialog");
      localStorage.setItem("planningPoker.firebase.teamId", teamRef.id);
      toast(`Команда «${name}» создана.`, "success");
    } catch (error) {
      handleError(error, target);
    }
  });
}

function openMembersDialog() {
  renderMembers();
  show($("memberEditor"), isLead());
  openDialog("membersDialog");
}

function renderMembers() {
  const root = $("membersList");

  if (!state.members.length) {
    root.innerHTML = '<div class="empty-state">Участников нет.</div>';
    return;
  }

  root.innerHTML = state.members.map(member => `
    <div class="member-row">
      <div>
        <strong>${escapeHtml(member.displayName)}</strong>
        <div class="member-email">${escapeHtml(member.email)}</div>
      </div>
      <div class="role-pill ${member.role === "lead" ? "lead" : ""}">
        ${member.role === "lead" ? "Тимлид" : "Участник"}
      </div>
      ${
        isLead() && member.email !== normalizeEmail(currentUser.email)
          ? `<button class="button danger icon-button" type="button" data-remove-member="${escapeHtml(member.email)}">×</button>`
          : "<span></span>"
      }
    </div>
  `).join("");

  root.querySelectorAll("[data-remove-member]").forEach(button => {
    button.addEventListener("click", () => removeMember(button.dataset.removeMember));
  });
}

async function addMember() {
  if (!isLead()) return;

  const displayName = $("memberName").value.trim();
  const email = normalizeEmail($("memberEmail").value);
  const role = $("memberRole").value;
  const target = $("memberDialogMessage");

  setFormMessage(target);

  if (!displayName || !email) {
    return setFormMessage(target, "Заполните имя и email.");
  }

  await withButton($("addMemberBtn"), "Добавление...", async () => {
    try {
      const teamRef = doc(db, "teams", state.teamId);
      const memberRef = doc(db, "teams", state.teamId, "members", email);
      const batch = writeBatch(db);

      batch.set(memberRef, {
        email,
        displayName,
        role,
        active: true,
        createdAt: serverTimestamp()
      }, { merge: true });

      batch.update(teamRef, {
        memberEmails: arrayUnion(email),
        ...(role === "lead"
          ? { leadEmails: arrayUnion(email) }
          : { leadEmails: arrayRemove(email) })
      });

      await batch.commit();

      $("memberName").value = "";
      $("memberEmail").value = "";
      $("memberRole").value = "member";
      toast("Участник добавлен.", "success");
    } catch (error) {
      handleError(error, target);
    }
  });
}

async function removeMember(email) {
  if (!isLead()) return;

  const member = state.members.find(item => item.email === email);
  if (!member || !confirm(`Удалить ${member.displayName} из команды?`)) return;

  try {
    const teamRef = doc(db, "teams", state.teamId);
    const memberRef = doc(db, "teams", state.teamId, "members", email);
    const batch = writeBatch(db);

    batch.delete(memberRef);
    batch.update(teamRef, {
      memberEmails: arrayRemove(email),
      leadEmails: arrayRemove(email)
    });

    await batch.commit();
    toast("Участник удалён.", "success");
  } catch (error) {
    handleError(error);
  }
}

function startSessionsListener() {
  const sessionsRef = collection(db, "teams", state.teamId, "sessions");

  unsubscribeSessions = onSnapshot(
    sessionsRef,
    { includeMetadataChanges: true },
    snapshot => {
      state.sessions = snapshot.docs
        .map(sessionDoc => ({ id: sessionDoc.id, ...sessionDoc.data() }))
        .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));

      const storedSessionId = localStorage.getItem(`planningPoker.firebase.sessionId.${state.teamId}`);
      const nextSessionId = state.sessions.some(session => session.id === state.sessionId)
        ? state.sessionId
        : state.sessions.some(session => session.id === storedSessionId)
          ? storedSessionId
          : state.sessions.find(session => session.status === "active")?.id
            || state.sessions[0]?.id
            || null;

      renderSessions();

      if (nextSessionId !== state.sessionId) {
        selectSession(nextSessionId);
      } else {
        renderTeamControls();
      }

      if (!nextSessionId) {
        clearIssueListener();
        state.issues = [];
        state.issueId = null;
        state.issue = null;
        renderIssues();
        show($("welcomeCard"));
        show($("issueCard"), false);
      }
    },
    error => handleError(error)
  );
}

function renderSessions() {
  $("sessionSelect").innerHTML = state.sessions.length
    ? state.sessions.map(session => `
        <option value="${session.id}" ${session.id === state.sessionId ? "selected" : ""}>
          ${escapeHtml(session.name)}
          ${session.iteration ? ` — ${escapeHtml(session.iteration)}` : ""}
          ${session.status === "finished" ? " ✓" : ""}
        </option>
      `).join("")
    : '<option value="">Нет сессий</option>';
}

function selectSession(sessionId) {
  if (sessionId === state.sessionId && unsubscribeIssues) {
    renderSessions();
    renderTeamControls();
    return;
  }

  clearIssueListener();

  state.sessionId = sessionId || null;
  state.issues = [];
  state.issueId = null;
  state.issue = null;

  if (state.teamId) {
    localStorage.setItem(`planningPoker.firebase.sessionId.${state.teamId}`, state.sessionId || "");
  }

  renderSessions();
  renderTeamControls();

  if (!state.sessionId) {
    renderIssues();
    show($("welcomeCard"));
    show($("issueCard"), false);
    return;
  }

  startIssuesListener();
}

async function createSession() {
  if (!isLead()) return;

  const name = $("sessionName").value.trim();
  const iteration = $("sessionIteration").value.trim();
  const target = $("sessionDialogMessage");

  setFormMessage(target);
  if (!name) return setFormMessage(target, "Укажите название сессии.");

  await withButton($("createSessionBtn"), "Создание...", async () => {
    try {
      const sessionRef = await addDoc(
        collection(db, "teams", state.teamId, "sessions"),
        {
          name,
          iteration: iteration || null,
          status: "active",
          createdByUid: currentUser.uid,
          createdByEmail: normalizeEmail(currentUser.email),
          createdAt: serverTimestamp()
        }
      );

      $("sessionName").value = "";
      $("sessionIteration").value = "";
      closeDialog("sessionDialog");
      localStorage.setItem(`planningPoker.firebase.sessionId.${state.teamId}`, sessionRef.id);
      toast("Сессия создана.", "success");
    } catch (error) {
      handleError(error, target);
    }
  });
}

async function finishSession() {
  if (!isLead() || !state.sessionId) return;

  try {
    await updateDoc(
      doc(db, "teams", state.teamId, "sessions", state.sessionId),
      { status: "finished" }
    );
    toast("Сессия завершена.", "success");
  } catch (error) {
    handleError(error);
  }
}

function startIssuesListener() {
  const issuesRef = collection(
    db,
    "teams", state.teamId,
    "sessions", state.sessionId,
    "issues"
  );

  unsubscribeIssues = onSnapshot(
    issuesRef,
    { includeMetadataChanges: true },
    snapshot => {
      state.issues = snapshot.docs
        .map(issueDoc => ({ id: issueDoc.id, ...issueDoc.data() }))
        .sort((a, b) => {
          const sortDiff = Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
          return sortDiff || timestampValue(a.createdAt) - timestampValue(b.createdAt);
        });

      const previousIssue = state.issue;
      const nextIssueId = state.issues.some(issue => issue.id === state.issueId)
        ? state.issueId
        : state.issues.find(issue => issue.status !== "estimated")?.id
          || state.issues[0]?.id
          || null;

      state.issueId = nextIssueId;
      state.issue = state.issues.find(issue => issue.id === nextIssueId) || null;

      renderIssues();

      if (!state.issue) {
        clearVoteListeners();
        show($("welcomeCard"));
        show($("issueCard"), false);
        return;
      }

      const subscriptionKey = `${state.issue.id}:${state.issue.currentRound}:${state.issue.status}`;
      if (subscriptionKey !== activeVoteSubscriptionKey) {
        startVoteListeners();
      }

      renderIssue();

      if (
        previousIssue &&
        previousIssue.id === state.issue.id &&
        previousIssue.status !== state.issue.status
      ) {
        renderIssue();
      }
    },
    error => handleError(error)
  );
}

function issueStatusText(status) {
  return ({
    pending: "Не начата",
    voting: "Голосование",
    revealed: "Оценки раскрыты",
    estimated: "Оценена"
  })[status] || status;
}

function renderIssues() {
  const root = $("issueList");

  if (!state.issues.length) {
    root.innerHTML = '<div class="empty-state">Нет задач</div>';
    return;
  }

  root.innerHTML = state.issues.map(issue => `
    <div class="item ${issue.id === state.issueId ? "active" : ""}" data-issue-id="${issue.id}">
      <div class="item-title">${escapeHtml(issue.title)}</div>
      <div class="item-meta">
        ${escapeHtml(issueStatusText(issue.status))}
        ${issue.finalEstimate ? ` · ${issue.finalEstimate} ч.д.` : ""}
      </div>
    </div>
  `).join("");

  root.querySelectorAll("[data-issue-id]").forEach(item => {
    item.addEventListener("click", () => selectIssue(item.dataset.issueId));
  });
}

function selectIssue(issueId) {
  state.issueId = issueId;
  state.issue = state.issues.find(issue => issue.id === issueId) || null;
  renderIssues();

  if (state.issue) {
    startVoteListeners();
    renderIssue();
  }
}

async function createIssue() {
  if (!isLead()) return;

  const title = $("newIssueTitle").value.trim();
  const gitlabUrl = $("newIssueUrl").value.trim();
  const description = $("newIssueDescription").value.trim();
  const target = $("issueDialogMessage");

  setFormMessage(target);
  if (!title) return setFormMessage(target, "Укажите название задачи.");

  const maxOrder = state.issues.reduce(
    (maximum, issue) => Math.max(maximum, Number(issue.sortOrder || 0)),
    0
  );

  await withButton($("createIssueBtn"), "Добавление...", async () => {
    try {
      await addDoc(
        collection(
          db,
          "teams", state.teamId,
          "sessions", state.sessionId,
          "issues"
        ),
        {
          title,
          gitlabUrl: gitlabUrl || null,
          description: description || null,
          currentRound: 1,
          status: "pending",
          finalEstimate: null,
          sortOrder: maxOrder + 10,
          createdByUid: currentUser.uid,
          createdByEmail: normalizeEmail(currentUser.email),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );

      $("newIssueTitle").value = "";
      $("newIssueUrl").value = "";
      $("newIssueDescription").value = "";
      closeDialog("issueDialog");
      toast("Задача добавлена.", "success");
    } catch (error) {
      handleError(error, target);
    }
  });
}

function voteDocId(round, uid) {
  return `${round}_${uid}`;
}

function startVoteListeners() {
  clearVoteListeners();

  if (!state.issue) return;

  activeVoteSubscriptionKey =
    `${state.issue.id}:${state.issue.currentRound}:${state.issue.status}`;

  const issueBase = [
    "teams", state.teamId,
    "sessions", state.sessionId,
    "issues", state.issue.id
  ];

  const round = Number(state.issue.currentRound);
  const ownVoteRef = doc(
    db,
    ...issueBase,
    "votes",
    voteDocId(round, currentUser.uid)
  );

  unsubscribeOwnVote = onSnapshot(
    ownVoteRef,
    snapshot => {
      state.myVote = snapshot.exists()
        ? { id: snapshot.id, ...snapshot.data() }
        : null;
      renderIssue();
    },
    error => handleError(error)
  );

  const statusQuery = query(
    collection(db, ...issueBase, "vote_status"),
    where("round", "==", round)
  );

  unsubscribeVoteStatuses = onSnapshot(
    statusQuery,
    snapshot => {
      state.voteStatuses = snapshot.docs.map(statusDoc => ({
        id: statusDoc.id,
        ...statusDoc.data()
      }));
      renderIssue();
    },
    error => handleError(error)
  );

  if (["revealed", "estimated"].includes(state.issue.status)) {
    const votesQuery = query(
      collection(db, ...issueBase, "votes"),
      where("round", "==", round)
    );

    unsubscribeVotes = onSnapshot(
      votesQuery,
      snapshot => {
        state.votes = snapshot.docs
          .map(voteDoc => ({ id: voteDoc.id, ...voteDoc.data() }))
          .sort((a, b) => timestampValue(a.updatedAt) - timestampValue(b.updatedAt));
        renderIssue();
      },
      error => handleError(error)
    );
  }
}

function renderPokerCards() {
  $("pokerCards").innerHTML = SCALE.map(value => `
    <button class="poker-card" type="button" data-vote-value="${value}">
      ${value}
    </button>
  `).join("");

  $("pokerCards").querySelectorAll("[data-vote-value]").forEach(button => {
    button.addEventListener("click", () => castVote(Number(button.dataset.voteValue)));
  });
}

function renderIssue() {
  const issue = state.issue;
  if (!issue) return;

  show($("welcomeCard"), false);
  show($("issueCard"));

  const statusClass = issue.status === "estimated"
    ? "green"
    : issue.status === "voting"
      ? "orange"
      : "";

  $("issueStatus").innerHTML = `
    <span class="status-pill ${statusClass}">
      ${escapeHtml(issueStatusText(issue.status))}
    </span>
  `;

  $("issueTitle").textContent = issue.title;
  $("issueDescription").textContent = issue.description || "";

  show($("gitlabLink"), Boolean(issue.gitlabUrl));
  if (issue.gitlabUrl) $("gitlabLink").href = issue.gitlabUrl;

  $("roundValue").textContent = issue.currentRound;
  $("votesCount").textContent = state.voteStatuses.length;
  $("membersCount").textContent = state.members.length;

  $("voteNotice").textContent = ({
    pending: "Тимлид ещё не открыл голосование.",
    voting: "Выберите оценку. До раскрытия другие участники увидят только факт голосования.",
    revealed: "Оценки раскрыты. Можно зафиксировать итог или начать новый раунд.",
    estimated: `Итоговая оценка: ${issue.finalEstimate} человеко-дней.`
  })[issue.status];

  const canVote = issue.status === "voting" && Boolean(state.role || isLead());

  $("pokerCards").querySelectorAll("[data-vote-value]").forEach(button => {
    const value = Number(button.dataset.voteValue);
    button.disabled = !canVote;
    button.classList.toggle("active", Number(state.myVote?.value) === value);
  });

  $("myVoteMessage").textContent = state.myVote
    ? `Ваш голос принят: ${state.myVote.value} ч.д.`
    : canVote
      ? "Вы ещё не проголосовали."
      : "";

  renderLeadIssueActions();
  renderResults();

  $("finalEstimate").value = issue.finalEstimate || suggestedEstimate() || "";
  $("finalizeBtn").disabled = !isLead() || !["revealed", "estimated"].includes(issue.status);
  $("copyEstimateBtn").disabled = !$("finalEstimate").value;

  setFormMessage(
    $("finalMessage"),
    issue.finalEstimate ? `Зафиксировано: ${issue.finalEstimate} ч.д.` : "",
    "success"
  );
}

function renderLeadIssueActions() {
  const root = $("leadIssueActions");

  if (!isLead() || !state.issue) {
    root.innerHTML = "";
    return;
  }

  const buttons = [];

  if (state.issue.status === "pending") {
    buttons.push('<button class="button primary" type="button" data-issue-action="start">Начать голосование</button>');
  }

  if (state.issue.status === "voting") {
    buttons.push('<button class="button primary" type="button" data-issue-action="reveal">Раскрыть оценки</button>');
  }

  if (state.issue.status === "revealed") {
    buttons.push('<button class="button secondary" type="button" data-issue-action="new-round">Новый раунд</button>');
  }

  if (state.issue.status === "estimated") {
    buttons.push('<button class="button secondary" type="button" data-issue-action="new-round">Переоценить</button>');
  }

  buttons.push('<button class="button danger" type="button" data-issue-action="delete">Удалить задачу</button>');

  root.innerHTML = buttons.join("");

  root.querySelectorAll("[data-issue-action]").forEach(button => {
    button.addEventListener("click", () => issueAction(button.dataset.issueAction));
  });
}

function currentIssueRef() {
  return doc(
    db,
    "teams", state.teamId,
    "sessions", state.sessionId,
    "issues", state.issue.id
  );
}

async function issueAction(action) {
  if (!isLead() || !state.issue) return;

  if (action === "delete") {
    const confirmed = confirm(
      `Удалить задачу «${state.issue.title}»?\n\n` +
      "Будут удалены все раунды и голоса."
    );
    if (!confirmed) return;

    try {
      await deleteIssueRecursive(state.teamId, state.sessionId, state.issue.id);
      toast("Задача удалена.", "success");
    } catch (error) {
      handleError(error);
    }
    return;
  }

  let patch = null;

  if (action === "start") patch = { status: "voting", updatedAt: serverTimestamp() };
  if (action === "reveal") patch = { status: "revealed", updatedAt: serverTimestamp() };
  if (action === "new-round") {
    patch = {
      status: "voting",
      currentRound: Number(state.issue.currentRound) + 1,
      finalEstimate: null,
      updatedAt: serverTimestamp()
    };
  }

  if (!patch) return;

  try {
    await updateDoc(currentIssueRef(), patch);
  } catch (error) {
    handleError(error);
  }
}

async function castVote(value) {
  if (!state.issue || state.issue.status !== "voting") return;

  const round = Number(state.issue.currentRound);
  const id = voteDocId(round, currentUser.uid);

  const issueBase = [
    "teams", state.teamId,
    "sessions", state.sessionId,
    "issues", state.issue.id
  ];

  const voteRef = doc(db, ...issueBase, "votes", id);
  const statusRef = doc(db, ...issueBase, "vote_status", id);
  const batch = writeBatch(db);

  batch.set(voteRef, {
    round,
    userId: currentUser.uid,
    voterEmail: normalizeEmail(currentUser.email),
    value,
    updatedAt: serverTimestamp()
  }, { merge: true });

  batch.set(statusRef, {
    round,
    userId: currentUser.uid,
    voterEmail: normalizeEmail(currentUser.email),
    updatedAt: serverTimestamp()
  }, { merge: true });

  try {
    await batch.commit();
    toast("Голос сохранён.", "success", 1800);
  } catch (error) {
    handleError(error);
  }
}

function voteStats() {
  const values = state.votes
    .map(vote => Number(vote.value))
    .sort((a, b) => a - b);

  if (!values.length) return null;

  const middle = Math.floor(values.length / 2);

  return {
    min: values[0],
    max: values[values.length - 1],
    median: values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2
  };
}

function suggestedEstimate() {
  const stats = voteStats();
  if (!stats) return null;
  return SCALE.find(value => value >= stats.median) || SCALE[SCALE.length - 1];
}

function renderResults() {
  const visible = state.issue &&
    ["revealed", "estimated"].includes(state.issue.status);

  show($("resultsCard"), visible);
  if (!visible) return;

  const memberByEmail = Object.fromEntries(
    state.members.map(member => [member.email, member])
  );

  $("votesList").innerHTML = state.votes.length
    ? state.votes.map(vote => `
        <div class="vote-row">
          <span>${escapeHtml(memberByEmail[vote.voterEmail]?.displayName || vote.voterEmail)}</span>
          <strong>${vote.value} ч.д.</strong>
        </div>
      `).join("")
    : '<div class="empty-state">В этом раунде нет голосов.</div>';

  const stats = voteStats();
  $("minVote").textContent = stats?.min ?? "—";
  $("medianVote").textContent = stats?.median ?? "—";
  $("maxVote").textContent = stats?.max ?? "—";
}

async function finalizeEstimate() {
  if (!isLead() || !state.issue) return;

  const value = Number($("finalEstimate").value);
  const target = $("finalMessage");

  if (!Number.isFinite(value) || value <= 0) {
    return setFormMessage(target, "Укажите итоговую оценку.");
  }

  if (!SCALE.includes(value)) {
    const confirmed = confirm(
      `Оценка ${value} не входит в стандартную шкалу. Всё равно сохранить?`
    );
    if (!confirmed) return;
  }

  try {
    await updateDoc(currentIssueRef(), {
      finalEstimate: value,
      status: "estimated",
      updatedAt: serverTimestamp()
    });
    toast("Итоговая оценка сохранена.", "success");
  } catch (error) {
    handleError(error, target);
  }
}

async function copyEstimate() {
  const value = Number($("finalEstimate").value);
  if (!value) return;

  const command = `/estimate ${value}d`;

  try {
    await navigator.clipboard.writeText(command);
    setFormMessage($("finalMessage"), `Скопировано: ${command}`, "success");
  } catch {
    setFormMessage($("finalMessage"), `Команда GitLab: ${command}`, "success");
  }
}

function openPasswordDialog() {
  clearPasswordForm();
  openDialog("passwordDialog");
  setTimeout(() => $("currentPassword").focus(), 0);
}

function closePasswordDialog() {
  clearPasswordForm();
  closeDialog("passwordDialog");
}

function clearPasswordForm() {
  $("currentPassword").value = "";
  $("newPassword").value = "";
  $("confirmNewPassword").value = "";
  setFormMessage($("passwordMessage"));
}

async function changePassword() {
  const currentPassword = $("currentPassword").value;
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmNewPassword").value;
  const target = $("passwordMessage");

  setFormMessage(target);

  if (!currentPassword) return setFormMessage(target, "Введите текущий пароль.");
  if (newPassword.length < 8) return setFormMessage(target, "Новый пароль должен содержать не менее 8 символов.");
  if (newPassword !== confirmPassword) return setFormMessage(target, "Новые пароли не совпадают.");
  if (currentPassword === newPassword) return setFormMessage(target, "Новый пароль должен отличаться от текущего.");

  await withButton($("savePasswordBtn"), "Сохранение...", async () => {
    try {
      const credential = EmailAuthProvider.credential(
        currentUser.email,
        currentPassword
      );

      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPassword);

      setFormMessage(target, "Пароль успешно изменён.", "success");

      setTimeout(() => {
        closePasswordDialog();
        toast("Пароль изменён.", "success");
      }, 800);
    } catch (error) {
      handleError(error, target);
    }
  });
}

async function deleteRefsInChunks(refs) {
  const chunkSize = 400;

  for (let start = 0; start < refs.length; start += chunkSize) {
    const batch = writeBatch(db);
    refs.slice(start, start + chunkSize).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

async function deleteCollectionRefs(collectionRef) {
  const snapshot = await getDocs(collectionRef);
  await deleteRefsInChunks(snapshot.docs.map(item => item.ref));
}

async function deleteIssueRecursive(teamId, sessionId, issueId) {
  const issueRef = doc(
    db,
    "teams", teamId,
    "sessions", sessionId,
    "issues", issueId
  );

  await deleteCollectionRefs(collection(issueRef, "votes"));
  await deleteCollectionRefs(collection(issueRef, "vote_status"));
  await deleteDoc(issueRef);
}

async function deleteSessionRecursive(teamId, sessionId) {
  const sessionRef = doc(db, "teams", teamId, "sessions", sessionId);
  const issuesSnapshot = await getDocs(collection(sessionRef, "issues"));

  for (const issueDoc of issuesSnapshot.docs) {
    await deleteIssueRecursive(teamId, sessionId, issueDoc.id);
  }

  await deleteDoc(sessionRef);
}

async function deleteTeam() {
  if (!isLead() || !state.teamId) return;

  const team = currentTeam();
  const confirmed = confirm(
    `Удалить команду «${team?.name || ""}»?\n\n` +
    "Будут удалены участники, сессии, задачи и все голоса. Действие необратимо."
  );

  if (!confirmed) return;

  try {
    const sessionsSnapshot = await getDocs(
      collection(db, "teams", state.teamId, "sessions")
    );

    for (const sessionDoc of sessionsSnapshot.docs) {
      await deleteSessionRecursive(state.teamId, sessionDoc.id);
    }

    await deleteCollectionRefs(
      collection(db, "teams", state.teamId, "members")
    );

    await deleteDoc(doc(db, "teams", state.teamId));
    localStorage.removeItem("planningPoker.firebase.teamId");
    toast("Команда удалена.", "success");
  } catch (error) {
    handleError(error);
  }
}

async function deleteSession() {
  if (!isLead() || !state.sessionId) return;

  const session = currentSession();
  const confirmed = confirm(
    `Удалить сессию «${session?.name || ""}»?\n\n` +
    "Будут удалены задачи и все голоса этой сессии."
  );

  if (!confirmed) return;

  try {
    await deleteSessionRecursive(state.teamId, state.sessionId);
    localStorage.removeItem(`planningPoker.firebase.sessionId.${state.teamId}`);
    toast("Сессия удалена.", "success");
  } catch (error) {
    handleError(error);
  }
}

init().catch(error => {
  console.error(error);
  handleError(error);
  show($("loginView"), false);
});
