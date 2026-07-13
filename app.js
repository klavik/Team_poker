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
  myVote: null,
  rounds: [],
  historicalVotes: [],
  directoryUsers: [],
  issueAudit: []
};

let firebaseApp = null;
let auth = null;
let db = null;
let currentUser = null;

let unsubscribeTeams = null;
let unsubscribeMembers = null;
let unsubscribeSessions = null;
let unsubscribeIssues = null;
let unsubscribeIssueAudit = null;
let unsubscribeOwnVote = null;
let unsubscribeVoteStatuses = null;
let unsubscribeVotes = null;
let unsubscribeRounds = null;
let unsubscribeUsers = null;
let activeVoteSubscriptionKey = null;
let editingMemberEmail = null;
let pendingTaskLink = readTaskLinkFromHash();
let taskLinkErrorShown = false;

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
  unsubscribe(unsubscribeRounds);

  unsubscribeOwnVote = null;
  unsubscribeVoteStatuses = null;
  unsubscribeVotes = null;
  unsubscribeRounds = null;
  activeVoteSubscriptionKey = null;

  state.voteStatuses = [];
  state.votes = [];
  state.myVote = null;
  state.rounds = [];
  state.historicalVotes = [];
}

function clearIssueListener() {
  unsubscribe(unsubscribeIssues);
  unsubscribe(unsubscribeIssueAudit);

  unsubscribeIssues = null;
  unsubscribeIssueAudit = null;

  state.issueAudit = [];
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
  unsubscribe(unsubscribeUsers);

  unsubscribeTeams = null;
  unsubscribeUsers = null;

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
      clearAllListeners();

      // Каталог и команды не должны зависеть от успешности записи профиля.
      startTeamsListener();
      startUsersDirectoryListener();

      ensureCurrentUserProfile()
        .catch(error => handleError(error));
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
  $("editTeamBtn").addEventListener("click", openEditTeamDialog);
  $("saveTeamChangesBtn").addEventListener("click", saveTeamChanges);
  $("deleteTeamBtn").addEventListener("click", deleteTeam);
  $("manageMembersBtn").addEventListener("click", openMembersDialog);
  $("addMemberBtn").addEventListener("click", addMember);
  $("memberUserSelect").addEventListener("change", fillSelectedMemberName);

  $("openSessionDialogBtn").addEventListener("click", () => openDialog("sessionDialog"));
  $("createSessionBtn").addEventListener("click", createSession);
  $("editSessionBtn").addEventListener("click", openEditSessionDialog);
  $("saveSessionChangesBtn").addEventListener("click", saveSessionChanges);
  $("finishSessionBtn").addEventListener("click", finishSession);
  $("deleteSessionBtn").addEventListener("click", deleteSession);

  $("openIssueDialogBtn").addEventListener("click", () => openDialog("issueDialog"));
  $("createIssueBtn").addEventListener("click", createIssue);
  $("openIssueAuditBtn").addEventListener("click", openIssueAuditDialog);
  $("saveIssueChangesBtn").addEventListener("click", saveIssueChanges);

  $("finalizeBtn").addEventListener("click", finalizeEstimate);
  $("copyEstimateBtn").addEventListener("click", copyEstimate);
  $("copyIssueLinkBtn").addEventListener("click", copyIssueLink);

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

  window.addEventListener("hashchange", () => {
    pendingTaskLink = readTaskLinkFromHash();
    taskLinkErrorShown = false;
    applyPendingTaskLink();
  });
}

async function ensureCurrentUserProfile() {
  const email = String(currentUser?.email || "").trim();
  if (!currentUser || !email) return;

  await setDoc(
    doc(db, "users", currentUser.uid),
    {
      uid: currentUser.uid,
      email,
      displayName: currentUser.displayName || email,
      active: true,
      lastLoginAt: serverTimestamp()
    },
    { merge: true }
  );
}

function startUsersDirectoryListener() {
  unsubscribe(unsubscribeUsers);

  unsubscribeUsers = onSnapshot(
    collection(db, "users"),
    { includeMetadataChanges: true },
    snapshot => {
      state.directoryUsers = snapshot.docs
        .map(userDoc => ({
          id: userDoc.id,
          ...userDoc.data()
        }))
        .filter(user => user.active !== false && user.email)
        .sort((left, right) => {
          const leftName = left.displayName || left.email;
          const rightName = right.displayName || right.email;
          return String(leftName).localeCompare(String(rightName), "ru");
        });

      renderAvailableUsers();
    },
    error => handleError(error)
  );
}

function availableDirectoryUsers() {
  const memberEmails = new Set(
    state.members.map(member => normalizeEmail(member.email))
  );

  return state.directoryUsers.filter(user => (
    !memberEmails.has(normalizeEmail(user.email))
  ));
}

function renderAvailableUsers() {
  const select = $("memberUserSelect");
  const status = $("memberDirectoryStatus");

  if (!select) return;

  const previousUid = select.value;
  const memberEmails = new Set(
    state.members.map(member => normalizeEmail(member.email))
  );

  const allUsers = state.directoryUsers;
  const availableUsers = allUsers.filter(
    user => !memberEmails.has(normalizeEmail(user.email))
  );
  const existingCount = allUsers.length - availableUsers.length;

  if (!allUsers.length) {
    select.innerHTML = `
      <option value="">
        Каталог пуст — пользователям нужно войти после обновления
      </option>
    `;
    select.disabled = true;
    $("addMemberBtn").disabled = true;

    if (status) {
      status.textContent =
        "В каталоге пока нет пользователей. Каждый пользователь должен открыть обновлённое приложение и войти хотя бы один раз.";
    }

    fillSelectedMemberName();
    return;
  }

  const options = [
    '<option value="">Выберите пользователя</option>',
    ...allUsers.map(user => {
      const uid = user.uid || user.id;
      const name = user.displayName || user.email;
      const alreadyMember = memberEmails.has(normalizeEmail(user.email));

      return `
        <option
          value="${escapeHtml(uid)}"
          ${alreadyMember ? "disabled" : ""}
        >
          ${escapeHtml(name)} — ${escapeHtml(user.email)}
          ${alreadyMember ? " (уже в команде)" : ""}
        </option>
      `;
    })
  ];

  select.innerHTML = options.join("");
  select.disabled = availableUsers.length === 0;

  if (availableUsers.some(user => (user.uid || user.id) === previousUid)) {
    select.value = previousUid;
  } else {
    select.value = "";
  }

  $("addMemberBtn").disabled = availableUsers.length === 0 || !isLead();

  if (status) {
    status.textContent = availableUsers.length
      ? `В каталоге: ${allUsers.length}. Уже в команде: ${existingCount}. Доступно для добавления: ${availableUsers.length}.`
      : `В каталоге: ${allUsers.length}. Все зарегистрированные пользователи уже состоят в этой команде.`;
  }

  fillSelectedMemberName();
}

function fillSelectedMemberName() {
  const selectedUid = $("memberUserSelect")?.value;
  const user = state.directoryUsers.find(
    item => (item.uid || item.id) === selectedUid
  );

  if (!user) {
    $("memberName").value = "";
    return;
  }

  const currentValue = $("memberName").value.trim();
  const selectedName = user.displayName && user.displayName !== user.email
    ? user.displayName
    : "";

  if (!currentValue || currentValue.includes("@")) {
    $("memberName").value = selectedName;
  }
}

function readTaskLinkFromHash() {
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) return null;

  const params = new URLSearchParams(rawHash);
  const teamId = params.get("team");
  const sessionId = params.get("session");
  const issueId = params.get("issue");

  if (!teamId || !sessionId || !issueId) return null;

  return { teamId, sessionId, issueId };
}

function buildTaskLink(teamId = state.teamId, sessionId = state.sessionId, issueId = state.issueId) {
  if (!teamId || !sessionId || !issueId) return null;

  const url = new URL(window.location.href);
  url.hash = new URLSearchParams({
    team: teamId,
    session: sessionId,
    issue: issueId
  }).toString();

  return url.toString();
}

function syncCurrentTaskLink() {
  if (pendingTaskLink || !state.teamId || !state.sessionId || !state.issueId) {
    return;
  }

  const taskLink = buildTaskLink();
  if (!taskLink) return;

  const nextUrl = new URL(taskLink);
  if (window.location.hash !== nextUrl.hash) {
    window.history.replaceState(null, "", nextUrl.hash);
  }
}

function showTaskLinkError(message) {
  if (taskLinkErrorShown) return;
  taskLinkErrorShown = true;
  toast(message, "error", 7000);
}

function applyPendingTaskLink() {
  if (!pendingTaskLink || !currentUser) return;

  const { teamId, sessionId, issueId } = pendingTaskLink;

  if (state.teamId !== teamId) {
    if (state.teams.some(team => team.id === teamId)) {
      selectTeam(teamId);
    }
    return;
  }

  if (state.sessionId !== sessionId) {
    if (state.sessions.some(session => session.id === sessionId)) {
      selectSession(sessionId);
    }
    return;
  }

  if (state.issueId !== issueId) {
    if (state.issues.some(issue => issue.id === issueId)) {
      selectIssue(issueId, { preserveHash: true });
    }
    return;
  }

  pendingTaskLink = null;
  taskLinkErrorShown = false;
  syncCurrentTaskLink();
}

async function copyIssueLink() {
  const link = buildTaskLink();

  if (!link) {
    toast("Сначала выберите задачу.");
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
    toast("Ссылка на задачу скопирована.", "success", 2500);
  } catch {
    window.prompt("Скопируйте ссылку на задачу:", link);
  }
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
    myVote: null,
    rounds: [],
    historicalVotes: [],
    directoryUsers: [],
    issueAudit: []
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
  unsubscribe(unsubscribeTeams);
  unsubscribeTeams = null;
  clearTeamListeners();

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
      const linkedTeamId = pendingTaskLink?.teamId;
      const nextTeamId = linkedTeamId && state.teams.some(team => team.id === linkedTeamId)
        ? linkedTeamId
        : state.teams.some(team => team.id === state.teamId)
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

      if (
        pendingTaskLink?.teamId &&
        !state.teams.some(team => team.id === pendingTaskLink.teamId) &&
        !snapshot.metadata.fromCache
      ) {
        showTaskLinkError("Команда из ссылки не найдена или у вас нет к ней доступа.");
        pendingTaskLink = null;
      } else {
        applyPendingTaskLink();
      }
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
  editingMemberEmail = null;
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
      renderAvailableUsers();
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
  $("editTeamBtn").disabled = !lead || !state.teamId;
  $("deleteTeamBtn").disabled = !lead || !state.teamId;
  $("manageMembersBtn").disabled = !state.teamId;

  $("openIssueDialogBtn").disabled = !lead || !state.sessionId;
  $("editSessionBtn").disabled = !lead || !state.sessionId;
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

function openEditTeamDialog() {
  if (!isLead() || !state.teamId) return;

  const team = currentTeam();
  if (!team) return;

  $("editTeamName").value = team.name || "";
  setFormMessage($("editTeamMessage"));
  openDialog("editTeamDialog");

  setTimeout(() => {
    $("editTeamName").focus();
    $("editTeamName").select();
  }, 0);
}

async function saveTeamChanges() {
  if (!isLead() || !state.teamId) return;

  const name = $("editTeamName").value.trim();
  const target = $("editTeamMessage");

  setFormMessage(target);

  if (!name) {
    return setFormMessage(target, "Укажите название команды.");
  }

  if (name.length > 100) {
    return setFormMessage(target, "Название команды должно быть не длиннее 100 символов.");
  }

  await withButton($("saveTeamChangesBtn"), "Сохранение...", async () => {
    try {
      await updateDoc(
        doc(db, "teams", state.teamId),
        {
          name,
          updatedAt: serverTimestamp()
        }
      );

      closeDialog("editTeamDialog");
      toast("Команда обновлена.", "success", 2500);
    } catch (error) {
      handleError(error, target);
    }
  });
}

function openMembersDialog() {
  editingMemberEmail = null;
  $("memberName").value = "";
  $("memberRole").value = "member";
  setFormMessage($("memberDialogMessage"));

  renderMembers();
  renderAvailableUsers();
  show($("memberEditor"), isLead());
  openDialog("membersDialog");
}

function renderMembers() {
  const root = $("membersList");
  const currentEmail = normalizeEmail(currentUser?.email);

  if (!state.members.length) {
    root.innerHTML = '<div class="empty-state">Участников нет.</div>';
    return;
  }

  root.innerHTML = state.members.map(member => {
    const memberEmail = normalizeEmail(member.email);
    const canEditName = isLead() || memberEmail === currentEmail;
    const canRemove = isLead() && memberEmail !== currentEmail;
    const editing = editingMemberEmail === memberEmail;

    const nameBlock = editing
      ? `
          <div>
            <input
              class="member-name-input"
              data-member-name-input="${escapeHtml(memberEmail)}"
              value="${escapeHtml(member.displayName || "")}"
              maxlength="100"
              aria-label="Удобное имя участника"
            >
            <div class="member-email">${escapeHtml(member.email)}</div>
          </div>
        `
      : `
          <div>
            <strong>${escapeHtml(member.displayName || member.email)}</strong>
            <div class="member-email">${escapeHtml(member.email)}</div>
          </div>
        `;

    const actions = editing
      ? `
          <div class="member-actions">
            <button
              class="button primary member-action-button"
              type="button"
              data-save-member-name="${escapeHtml(memberEmail)}"
              title="Сохранить имя"
            >✓</button>
            <button
              class="button secondary member-action-button"
              type="button"
              data-cancel-member-name="${escapeHtml(memberEmail)}"
              title="Отменить"
            >×</button>
          </div>
        `
      : `
          <div class="member-actions">
            ${
              canEditName
                ? `
                    <button
                      class="button secondary member-action-button"
                      type="button"
                      data-edit-member-name="${escapeHtml(memberEmail)}"
                      title="Изменить удобное имя"
                    >✎</button>
                  `
                : ""
            }
            ${
              canRemove
                ? `
                    <button
                      class="button danger member-action-button"
                      type="button"
                      data-remove-member="${escapeHtml(memberEmail)}"
                      title="Удалить участника"
                    >×</button>
                  `
                : ""
            }
          </div>
        `;

    return `
      <div class="member-row ${editing ? "editing" : ""}">
        ${nameBlock}
        <div class="role-pill ${member.role === "lead" ? "lead" : ""}">
          ${member.role === "lead" ? "Тимлид" : "Участник"}
        </div>
        ${actions}
      </div>
    `;
  }).join("");

  root.querySelectorAll("[data-edit-member-name]").forEach(button => {
    button.addEventListener("click", () => {
      editingMemberEmail = button.dataset.editMemberName;
      renderMembers();

      const input = [...root.querySelectorAll("[data-member-name-input]")]
        .find(item => item.dataset.memberNameInput === editingMemberEmail);

      input?.focus();
      input?.select();
    });
  });

  root.querySelectorAll("[data-cancel-member-name]").forEach(button => {
    button.addEventListener("click", () => {
      editingMemberEmail = null;
      renderMembers();
    });
  });

  root.querySelectorAll("[data-save-member-name]").forEach(button => {
    button.addEventListener("click", () => {
      saveMemberDisplayName(button.dataset.saveMemberName);
    });
  });

  root.querySelectorAll("[data-member-name-input]").forEach(input => {
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveMemberDisplayName(input.dataset.memberNameInput);
      }

      if (event.key === "Escape") {
        event.preventDefault();
        editingMemberEmail = null;
        renderMembers();
      }
    });
  });

  root.querySelectorAll("[data-remove-member]").forEach(button => {
    button.addEventListener("click", () => removeMember(button.dataset.removeMember));
  });
}

async function saveMemberDisplayName(email) {
  const memberEmail = normalizeEmail(email);
  const member = state.members.find(
    item => normalizeEmail(item.email) === memberEmail
  );

  const input = [...$("membersList").querySelectorAll("[data-member-name-input]")]
    .find(item => item.dataset.memberNameInput === memberEmail);

  const displayName = input?.value.trim() || "";
  const currentEmail = normalizeEmail(currentUser?.email);
  const canEditName = isLead() || memberEmail === currentEmail;

  if (!member || !canEditName) {
    toast("Недостаточно прав для изменения имени.");
    return;
  }

  if (!displayName) {
    toast("Удобное имя не может быть пустым.");
    input?.focus();
    return;
  }

  if (displayName.length > 100) {
    toast("Удобное имя должно быть не длиннее 100 символов.");
    input?.focus();
    return;
  }

  try {
    await updateDoc(
      doc(db, "teams", state.teamId, "members", memberEmail),
      {
        displayName,
        updatedAt: serverTimestamp()
      }
    );

    editingMemberEmail = null;
    toast("Удобное имя сохранено.", "success", 2500);
  } catch (error) {
    handleError(error);
  }
}

async function addMember() {
  if (!isLead()) return;

  const selectedUid = $("memberUserSelect").value;
  const selectedUser = state.directoryUsers.find(
    user => (user.uid || user.id) === selectedUid
  );

  const displayName = $("memberName").value.trim();
  const role = $("memberRole").value;
  const target = $("memberDialogMessage");

  setFormMessage(target);

  if (!selectedUser) {
    return setFormMessage(
      target,
      "Выберите пользователя. Пользователь появится в списке после первого входа в приложение."
    );
  }

  const email = normalizeEmail(selectedUser.email);
  const finalDisplayName = displayName || selectedUser.displayName || email;

  await withButton($("addMemberBtn"), "Добавление...", async () => {
    try {
      const teamRef = doc(db, "teams", state.teamId);
      const memberRef = doc(db, "teams", state.teamId, "members", email);
      const batch = writeBatch(db);

      batch.set(memberRef, {
        uid: selectedUser.uid || selectedUser.id,
        email,
        displayName: finalDisplayName,
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
      $("memberRole").value = "member";

      renderAvailableUsers();
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
      const linkedSessionId = pendingTaskLink?.teamId === state.teamId
        ? pendingTaskLink.sessionId
        : null;

      const nextSessionId = linkedSessionId && state.sessions.some(session => session.id === linkedSessionId)
        ? linkedSessionId
        : state.sessions.some(session => session.id === state.sessionId)
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

      if (
        pendingTaskLink?.teamId === state.teamId &&
        pendingTaskLink?.sessionId &&
        !state.sessions.some(session => session.id === pendingTaskLink.sessionId) &&
        !snapshot.metadata.fromCache
      ) {
        showTaskLinkError("Сессия из ссылки не найдена или была удалена.");
        pendingTaskLink = null;
      } else {
        applyPendingTaskLink();
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
  startIssueAuditListener();
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

function openEditSessionDialog() {
  if (!isLead() || !state.sessionId) return;

  const session = currentSession();
  if (!session) return;

  $("editSessionName").value = session.name || "";
  $("editSessionIteration").value = session.iteration || "";
  setFormMessage($("editSessionMessage"));
  openDialog("editSessionDialog");

  setTimeout(() => {
    $("editSessionName").focus();
    $("editSessionName").select();
  }, 0);
}

async function saveSessionChanges() {
  if (!isLead() || !state.sessionId) return;

  const name = $("editSessionName").value.trim();
  const iteration = $("editSessionIteration").value.trim();
  const target = $("editSessionMessage");

  setFormMessage(target);

  if (!name) {
    return setFormMessage(target, "Укажите название сессии.");
  }

  if (name.length > 150) {
    return setFormMessage(target, "Название сессии должно быть не длиннее 150 символов.");
  }

  await withButton($("saveSessionChangesBtn"), "Сохранение...", async () => {
    try {
      await updateDoc(
        doc(db, "teams", state.teamId, "sessions", state.sessionId),
        {
          name,
          iteration: iteration || null,
          updatedAt: serverTimestamp()
        }
      );

      closeDialog("editSessionDialog");
      toast("Сессия обновлена.", "success", 2500);
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

function currentActorSnapshot() {
  const email = normalizeEmail(currentUser?.email);
  const member = state.members.find(
    item => normalizeEmail(item.email) === email
  );

  return {
    uid: currentUser?.uid || "",
    email,
    displayName:
      member?.displayName ||
      currentUser?.displayName ||
      email
  };
}

function issueAuditCollectionRef(
  teamId = state.teamId,
  sessionId = state.sessionId
) {
  return collection(
    db,
    "teams", teamId,
    "sessions", sessionId,
    "issue_audit"
  );
}

function createIssueAuditRef(
  teamId = state.teamId,
  sessionId = state.sessionId
) {
  return doc(issueAuditCollectionRef(teamId, sessionId));
}

function buildIssueAuditEvent({
  action,
  issueId,
  issueTitle,
  changedFields = [],
  before = null,
  after = null,
  snapshot = null
}) {
  const actor = currentActorSnapshot();

  return {
    action,
    issueId,
    issueTitle,
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorDisplayName: actor.displayName,
    changedFields,
    before,
    after,
    snapshot,
    occurredAt: serverTimestamp()
  };
}

function startIssueAuditListener() {
  unsubscribe(unsubscribeIssueAudit);
  unsubscribeIssueAudit = null;
  state.issueAudit = [];

  if (!state.teamId || !state.sessionId) {
    renderIssueAudit();
    return;
  }

  unsubscribeIssueAudit = onSnapshot(
    issueAuditCollectionRef(),
    { includeMetadataChanges: true },
    snapshot => {
      state.issueAudit = snapshot.docs
        .map(auditDoc => ({ id: auditDoc.id, ...auditDoc.data() }))
        .sort(
          (left, right) =>
            timestampValue(right.occurredAt) -
            timestampValue(left.occurredAt)
        );

      renderIssueAudit();
    },
    error => handleError(error)
  );
}

function issueActorName(email, storedName = "") {
  const normalized = normalizeEmail(email);
  const member = state.members.find(
    item => normalizeEmail(item.email) === normalized
  );

  return member?.displayName || storedName || email || "Неизвестный пользователь";
}

function issueAuditActionText(action) {
  return ({
    created: "добавил задачу",
    edited: "отредактировал задачу",
    deleted: "удалил задачу"
  })[action] || action;
}

function issueAuditActionClass(action) {
  return ({
    created: "created",
    edited: "edited",
    deleted: "deleted"
  })[action] || "";
}

function syntheticCreationEvents() {
  const auditedIssueIds = new Set(
    state.issueAudit
      .filter(event => event.action === "created")
      .map(event => event.issueId)
  );

  return state.issues
    .filter(issue => !auditedIssueIds.has(issue.id))
    .map(issue => ({
      id: `legacy-created-${issue.id}`,
      action: "created",
      issueId: issue.id,
      issueTitle: issue.title,
      actorUid: issue.createdByUid || "",
      actorEmail: issue.createdByEmail || "",
      actorDisplayName: "",
      occurredAt: issue.createdAt,
      legacy: true
    }));
}

function combinedIssueAuditEvents() {
  return [...state.issueAudit, ...syntheticCreationEvents()]
    .sort(
      (left, right) =>
        timestampValue(right.occurredAt) -
        timestampValue(left.occurredAt)
    );
}

function renderIssueAudit() {
  const root = $("issueAuditList");
  if (!root) return;

  const events = combinedIssueAuditEvents();

  if (!events.length) {
    root.innerHTML = `
      <div class="empty-state">
        Журнал пока пуст. Новые добавления, редактирования и удаления
        будут сохраняться автоматически.
      </div>
    `;
    return;
  }

  root.innerHTML = events.map(event => {
    const actor = issueActorName(
      event.actorEmail,
      event.actorDisplayName
    );
    const occurredAt = formatHistoryDate(event.occurredAt);
    const fields = Array.isArray(event.changedFields)
      ? event.changedFields
      : [];

    return `
      <div class="issue-audit-entry">
        <div class="issue-audit-marker ${issueAuditActionClass(event.action)}"></div>

        <div class="issue-audit-content">
          <div class="issue-audit-title">
            <strong>${escapeHtml(actor)}</strong>
            ${escapeHtml(issueAuditActionText(event.action))}
          </div>

          <div class="issue-audit-task">
            ${escapeHtml(event.issueTitle || "Задача без названия")}
          </div>

          ${
            fields.length
              ? `
                  <div class="issue-audit-fields">
                    Изменено: ${fields.map(escapeHtml).join(", ")}
                  </div>
                `
              : ""
          }

          <div class="issue-audit-meta">
            ${escapeHtml(event.actorEmail || "")}
            ${occurredAt ? ` · ${escapeHtml(occurredAt)}` : ""}
            ${event.legacy ? " · данные из существующей задачи" : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function openIssueAuditDialog() {
  renderIssueAudit();
  openDialog("issueAuditDialog");
}

function renderIssueAuthorMeta() {
  const root = $("issueAuthorMeta");
  const issue = state.issue;

  if (!root || !issue) {
    if (root) root.innerHTML = "";
    return;
  }

  const creatorName = issueActorName(
    issue.createdByEmail,
    issue.createdByDisplayName
  );
  const createdAt = formatHistoryDate(issue.createdAt);

  const editorName = issue.contentUpdatedByEmail
    ? issueActorName(
        issue.contentUpdatedByEmail,
        issue.contentUpdatedByDisplayName
      )
    : "";

  const editedAt = formatHistoryDate(issue.contentUpdatedAt);

  root.innerHTML = `
    <span>
      Добавил:
      <strong>${escapeHtml(creatorName)}</strong>
      ${createdAt ? ` · ${escapeHtml(createdAt)}` : ""}
    </span>
    ${
      editorName
        ? `
            <span>
              Последнее редактирование:
              <strong>${escapeHtml(editorName)}</strong>
              ${editedAt ? ` · ${escapeHtml(editedAt)}` : ""}
            </span>
          `
        : ""
    }
  `;
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
      const linkedIssueId = (
        pendingTaskLink?.teamId === state.teamId &&
        pendingTaskLink?.sessionId === state.sessionId
      )
        ? pendingTaskLink.issueId
        : null;

      const nextIssueId = linkedIssueId && state.issues.some(issue => issue.id === linkedIssueId)
        ? linkedIssueId
        : state.issues.some(issue => issue.id === state.issueId)
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

      if (
        pendingTaskLink?.teamId === state.teamId &&
        pendingTaskLink?.sessionId === state.sessionId &&
        pendingTaskLink?.issueId &&
        !state.issues.some(issue => issue.id === pendingTaskLink.issueId) &&
        !snapshot.metadata.fromCache
      ) {
        showTaskLinkError("Задача из ссылки не найдена или была удалена.");
        pendingTaskLink = null;
      } else {
        applyPendingTaskLink();
      }

      syncCurrentTaskLink();
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

function selectIssue(issueId, options = {}) {
  state.issueId = issueId;
  state.issue = state.issues.find(issue => issue.id === issueId) || null;
  renderIssues();

  if (state.issue) {
    startVoteListeners();
    renderIssue();

    if (!options.preserveHash) {
      pendingTaskLink = null;
      taskLinkErrorShown = false;
      syncCurrentTaskLink();
    }
  }
}

function isValidExternalUrl(value) {
  if (!value) return true;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function openEditIssueDialog() {
  if (!isLead() || !state.issue) return;

  $("editIssueTitle").value = state.issue.title || "";
  $("editIssueUrl").value = state.issue.gitlabUrl || "";
  $("editIssueDescription").value = state.issue.description || "";
  setFormMessage($("editIssueMessage"));
  openDialog("editIssueDialog");

  setTimeout(() => {
    $("editIssueTitle").focus();
    $("editIssueTitle").select();
  }, 0);
}

async function saveIssueChanges() {
  if (!isLead() || !state.issue) return;

  const title = $("editIssueTitle").value.trim();
  const externalUrl = $("editIssueUrl").value.trim();
  const description = $("editIssueDescription").value.trim();
  const target = $("editIssueMessage");

  setFormMessage(target);

  if (!title) {
    return setFormMessage(target, "Укажите название задачи.");
  }

  if (title.length > 300) {
    return setFormMessage(target, "Название задачи должно быть не длиннее 300 символов.");
  }

  if (!isValidExternalUrl(externalUrl)) {
    return setFormMessage(target, "Ссылка должна начинаться с http:// или https://.");
  }

  const before = {
    title: state.issue.title || "",
    gitlabUrl: state.issue.gitlabUrl || null,
    description: state.issue.description || null
  };

  const after = {
    title,
    gitlabUrl: externalUrl || null,
    description: description || null
  };

  const changedFields = [];

  if (before.title !== after.title) changedFields.push("название");
  if (before.gitlabUrl !== after.gitlabUrl) changedFields.push("внешняя ссылка");
  if (before.description !== after.description) changedFields.push("описание");

  if (!changedFields.length) {
    closeDialog("editIssueDialog");
    toast("Изменений нет.", "success", 2000);
    return;
  }

  await withButton($("saveIssueChangesBtn"), "Сохранение...", async () => {
    try {
      const actor = currentActorSnapshot();
      const auditRef = createIssueAuditRef();
      const batch = writeBatch(db);

      batch.update(currentIssueRef(), {
        title,
        gitlabUrl: externalUrl || null,
        description: description || null,
        contentUpdatedByUid: actor.uid,
        contentUpdatedByEmail: actor.email,
        contentUpdatedByDisplayName: actor.displayName,
        contentUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      batch.set(
        auditRef,
        buildIssueAuditEvent({
          action: "edited",
          issueId: state.issue.id,
          issueTitle: title,
          changedFields,
          before,
          after
        })
      );

      await batch.commit();

      closeDialog("editIssueDialog");
      toast("Задача обновлена.", "success", 2500);
    } catch (error) {
      handleError(error, target);
    }
  });
}

async function createIssue() {
  if (!isLead()) return;

  const title = $("newIssueTitle").value.trim();
  const gitlabUrl = $("newIssueUrl").value.trim();
  const description = $("newIssueDescription").value.trim();
  const target = $("issueDialogMessage");

  setFormMessage(target);
  if (!title) return setFormMessage(target, "Укажите название задачи.");
  if (!isValidExternalUrl(gitlabUrl)) {
    return setFormMessage(target, "Ссылка должна начинаться с http:// или https://.");
  }

  const maxOrder = state.issues.reduce(
    (maximum, issue) => Math.max(maximum, Number(issue.sortOrder || 0)),
    0
  );

  await withButton($("createIssueBtn"), "Добавление...", async () => {
    try {
      const actor = currentActorSnapshot();
      const issueRef = doc(
        collection(
          db,
          "teams", state.teamId,
          "sessions", state.sessionId,
          "issues"
        )
      );
      const auditRef = createIssueAuditRef();
      const batch = writeBatch(db);

      batch.set(issueRef, {
        title,
        gitlabUrl: gitlabUrl || null,
        description: description || null,
        currentRound: 1,
        status: "pending",
        finalEstimate: null,
        sortOrder: maxOrder + 10,
        createdByUid: actor.uid,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      batch.set(
        auditRef,
        buildIssueAuditEvent({
          action: "created",
          issueId: issueRef.id,
          issueTitle: title,
          snapshot: {
            title,
            gitlabUrl: gitlabUrl || null,
            description: description || null
          }
        })
      );

      await batch.commit();

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

  /*
    Нельзя подписываться на конкретный документ votes/{round_uid}.
    Если пользователь ещё не голосовал, документа нет, а правило чтения
    использует resource.data. Для отсутствующего документа Firestore
    возвращает permission-denied.

    Запрос по userId безопасен: правила могут доказать, что приложение
    читает только голоса текущего пользователя. Пустой результат допустим.
  */
  const ownVotesQuery = query(
    collection(db, ...issueBase, "votes"),
    where("userId", "==", currentUser.uid)
  );

  unsubscribeOwnVote = onSnapshot(
    ownVotesQuery,
    snapshot => {
      const voteDoc = snapshot.docs.find(
        item => Number(item.data().round) === round
      );

      state.myVote = voteDoc
        ? { id: voteDoc.id, ...voteDoc.data() }
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

  unsubscribeRounds = onSnapshot(
    collection(db, ...issueBase, "rounds"),
    { includeMetadataChanges: true },
    snapshot => {
      state.rounds = snapshot.docs
        .map(roundDoc => ({ id: roundDoc.id, ...roundDoc.data() }))
        .sort((a, b) => Number(b.round) - Number(a.round));
      renderRoundHistory();
    },
    error => handleError(error)
  );

  loadLegacyHistoricalVotes().catch(error => handleError(error));

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


function issueBasePath(issueId = state.issue?.id) {
  return [
    "teams", state.teamId,
    "sessions", state.sessionId,
    "issues", issueId
  ];
}

function votesCollectionRef(issueId = state.issue?.id) {
  return collection(db, ...issueBasePath(issueId), "votes");
}

function roundDocumentRef(round, issueId = state.issue?.id) {
  return doc(db, ...issueBasePath(issueId), "rounds", String(round));
}

function calculateVoteStats(votes) {
  const values = votes
    .map(vote => Number(vote.value))
    .filter(value => Number.isFinite(value))
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

async function loadLegacyHistoricalVotes() {
  state.historicalVotes = [];

  const issue = state.issue;
  if (!issue) {
    renderRoundHistory();
    return;
  }

  // Фиксируем идентификаторы, чтобы переключение задачи во время запросов
  // не направило следующий запрос в другую коллекцию.
  const requestedTeamId = state.teamId;
  const requestedSessionId = state.sessionId;
  const requestedIssueId = issue.id;
  const currentRound = Number(issue.currentRound);

  if (currentRound <= 1) {
    renderRoundHistory();
    return;
  }

  const historical = [];
  const requestedVotesRef = collection(
    db,
    "teams", requestedTeamId,
    "sessions", requestedSessionId,
    "issues", requestedIssueId,
    "votes"
  );

  for (let round = 1; round < currentRound; round += 1) {
    const snapshot = await getDocs(
      query(
        requestedVotesRef,
        where("round", "==", round)
      )
    );

    snapshot.docs.forEach(voteDoc => {
      historical.push({ id: voteDoc.id, ...voteDoc.data() });
    });

    // Пользователь уже переключился на другую задачу — результат не применяем.
    if (
      state.teamId !== requestedTeamId ||
      state.sessionId !== requestedSessionId ||
      state.issue?.id !== requestedIssueId
    ) {
      return;
    }
  }

  if (
    state.teamId === requestedTeamId &&
    state.sessionId === requestedSessionId &&
    state.issue?.id === requestedIssueId
  ) {
    state.historicalVotes = historical;
    renderRoundHistory();
  }
}

async function buildRoundSnapshot(round, status, finalEstimate = null) {
  const votesSnapshot = await getDocs(
    query(
      votesCollectionRef(),
      where("round", "==", Number(round))
    )
  );

  const votes = votesSnapshot.docs
    .map(voteDoc => ({ id: voteDoc.id, ...voteDoc.data() }))
    .sort((a, b) => timestampValue(a.updatedAt) - timestampValue(b.updatedAt));

  const stats = calculateVoteStats(votes);
  const roundRef = roundDocumentRef(round);
  const existingSnapshot = await getDoc(roundRef);
  const existing = existingSnapshot.exists() ? existingSnapshot.data() : {};

  const payload = {
    round: Number(round),
    status,
    votes: votes.map(vote => ({
      userId: vote.userId,
      voterEmail: vote.voterEmail,
      value: Number(vote.value)
    })),
    voteCount: votes.length,
    min: stats?.min ?? null,
    median: stats?.median ?? null,
    max: stats?.max ?? null,
    finalEstimate: finalEstimate ?? existing.finalEstimate ?? null,
    revealedAt: existing.revealedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  if (status === "finalized") {
    payload.finalizedAt = serverTimestamp();
  }

  return payload;
}

function formatHistoryDate(value) {
  const milliseconds = timestampValue(value);
  if (!milliseconds) return "";

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(milliseconds));
}

function renderRoundHistory() {
  const card = $("historyCard");
  const root = $("roundHistoryList");

  if (!card || !root || !state.issue) {
    if (card) show(card, false);
    return;
  }

  const roundsByNumber = new Map();

  for (const archived of state.rounds) {
    const round = Number(archived.round);
    roundsByNumber.set(round, {
      ...archived,
      round,
      votes: Array.isArray(archived.votes) ? archived.votes : []
    });
  }

  for (const vote of state.historicalVotes) {
    const round = Number(vote.round);
    const item = roundsByNumber.get(round) || {
      round,
      status: "legacy",
      votes: [],
      finalEstimate: null
    };

    if (!item.votes.some(existing => existing.userId === vote.userId)) {
      item.votes.push(vote);
    }

    roundsByNumber.set(round, item);
  }

  if (["revealed", "estimated"].includes(state.issue.status)) {
    const round = Number(state.issue.currentRound);
    const existing = roundsByNumber.get(round) || {
      round,
      status: state.issue.status === "estimated" ? "finalized" : "revealed",
      votes: []
    };

    if (!existing.votes.length && state.votes.length) {
      existing.votes = state.votes;
    }

    if (state.issue.finalEstimate != null) {
      existing.finalEstimate = Number(state.issue.finalEstimate);
    }

    roundsByNumber.set(round, existing);
  }

  const rounds = [...roundsByNumber.values()]
    .filter(item => item.votes.length || item.finalEstimate != null || item.revealedAt)
    .sort((a, b) => b.round - a.round);

  show(card, rounds.length > 0);

  if (!rounds.length) {
    root.innerHTML = "";
    return;
  }

  const memberByEmail = Object.fromEntries(
    state.members.map(member => [member.email, member])
  );

  root.innerHTML = rounds.map((item, index) => {
    const stats = calculateVoteStats(item.votes);
    const finalEstimate = item.finalEstimate != null
      ? Number(item.finalEstimate)
      : null;

    const date = formatHistoryDate(item.finalizedAt || item.revealedAt);
    const votesHtml = item.votes.length
      ? item.votes
          .slice()
          .sort((a, b) => Number(a.value) - Number(b.value))
          .map(vote => {
            const name = memberByEmail[vote.voterEmail]?.displayName || vote.voterEmail;
            return `
              <span class="history-vote">
                ${escapeHtml(name)} — <strong>${Number(vote.value)} ч.д.</strong>
              </span>
            `;
          })
          .join("")
      : '<span class="muted small">Голоса не найдены.</span>';

    return `
      <details class="round-history-item" ${index === 0 ? "open" : ""}>
        <summary>
          <span>
            <strong>Раунд ${item.round}</strong>
            <span class="history-summary">
              ${item.votes.length} голосов
              ${date ? ` · ${escapeHtml(date)}` : ""}
            </span>
          </span>
          <span class="history-final ${finalEstimate == null ? "empty" : ""}">
            ${finalEstimate == null ? "Итог не зафиксирован" : `Итог: ${finalEstimate} ч.д.`}
          </span>
        </summary>

        <div class="round-history-body">
          <div class="history-metrics">
            <div><span>Минимум</span><strong>${stats?.min ?? "—"}</strong></div>
            <div><span>Медиана</span><strong>${stats?.median ?? "—"}</strong></div>
            <div><span>Максимум</span><strong>${stats?.max ?? "—"}</strong></div>
          </div>

          <div class="history-votes">
            ${votesHtml}
          </div>

          ${
            item.status === "legacy"
              ? '<div class="muted small">Раунд создан до появления журнала итоговых оценок.</div>'
              : ""
          }
        </div>
      </details>
    `;
  }).join("");
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
  renderIssueAuthorMeta();

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
  renderRoundHistory();
  syncCurrentTaskLink();

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

  buttons.push('<button class="button secondary" type="button" data-issue-action="edit">Редактировать</button>');

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

  if (action === "edit") {
    openEditIssueDialog();
    return;
  }

  if (action === "delete") {
    const confirmed = confirm(
      `Удалить задачу «${state.issue.title}»?\n\n` +
      "Будут удалены все раунды и голоса."
    );
    if (!confirmed) return;

    try {
      await deleteIssueRecursive(
        state.teamId,
        state.sessionId,
        state.issue.id,
        {
          auditDeletion: true,
          issueSnapshot: {
            title: state.issue.title || "",
            gitlabUrl: state.issue.gitlabUrl || null,
            description: state.issue.description || null,
            status: state.issue.status || null,
            finalEstimate: state.issue.finalEstimate ?? null
          }
        }
      );
      toast("Задача удалена. Запись сохранена в журнале.", "success");
    } catch (error) {
      handleError(error);
    }
    return;
  }

  try {
    if (action === "start") {
      await updateDoc(currentIssueRef(), {
        status: "voting",
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (action === "reveal") {
      const round = Number(state.issue.currentRound);

      // Сначала открываем раунд, чтобы правила разрешили тимлиду прочитать все голоса.
      await updateDoc(currentIssueRef(), {
        status: "revealed",
        updatedAt: serverTimestamp()
      });

      const snapshot = await buildRoundSnapshot(round, "revealed", null);
      await setDoc(roundDocumentRef(round), snapshot, { merge: true });
      return;
    }

    if (action === "new-round") {
      const round = Number(state.issue.currentRound);
      const archiveStatus = state.issue.status === "estimated"
        ? "finalized"
        : "revealed";

      const snapshot = await buildRoundSnapshot(
        round,
        archiveStatus,
        state.issue.finalEstimate ?? null
      );

      const batch = writeBatch(db);
      batch.set(roundDocumentRef(round), snapshot, { merge: true });
      batch.update(currentIssueRef(), {
        status: "voting",
        currentRound: round + 1,
        finalEstimate: null,
        updatedAt: serverTimestamp()
      });

      await batch.commit();
    }
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
  return calculateVoteStats(state.votes);
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
    const round = Number(state.issue.currentRound);
    const snapshot = await buildRoundSnapshot(round, "finalized", value);

    const batch = writeBatch(db);
    batch.set(roundDocumentRef(round), snapshot, { merge: true });
    batch.update(currentIssueRef(), {
      finalEstimate: value,
      status: "estimated",
      updatedAt: serverTimestamp()
    });

    await batch.commit();
    toast("Итоговая оценка и история раунда сохранены.", "success");
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

async function deleteIssueRecursive(
  teamId,
  sessionId,
  issueId,
  options = {}
) {
  const issueRef = doc(
    db,
    "teams", teamId,
    "sessions", sessionId,
    "issues", issueId
  );

  /*
    До раскрытия раунда тимлид не может читать чужие значения голосов.
    Поэтому голоса удаляются по идентификаторам из vote_status.
  */
  const statusSnapshot = await getDocs(
    collection(issueRef, "vote_status")
  );

  const voteRefs = statusSnapshot.docs.map(statusDoc =>
    doc(issueRef, "votes", statusDoc.id)
  );

  const statusRefs = statusSnapshot.docs.map(statusDoc => statusDoc.ref);

  await deleteRefsInChunks(voteRefs);
  await deleteRefsInChunks(statusRefs);
  await deleteCollectionRefs(collection(issueRef, "rounds"));

  const finalBatch = writeBatch(db);

  if (options.auditDeletion && options.issueSnapshot) {
    const auditRef = createIssueAuditRef(teamId, sessionId);

    finalBatch.set(
      auditRef,
      buildIssueAuditEvent({
        action: "deleted",
        issueId,
        issueTitle: options.issueSnapshot.title || "Задача без названия",
        snapshot: options.issueSnapshot
      })
    );
  }

  finalBatch.delete(issueRef);
  await finalBatch.commit();
}

async function deleteSessionRecursive(teamId, sessionId) {
  const sessionRef = doc(db, "teams", teamId, "sessions", sessionId);
  const issuesSnapshot = await getDocs(collection(sessionRef, "issues"));

  for (const issueDoc of issuesSnapshot.docs) {
    await deleteIssueRecursive(teamId, sessionId, issueDoc.id);
  }

  await deleteCollectionRefs(collection(sessionRef, "issue_audit"));
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
