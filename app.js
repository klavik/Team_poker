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
let resolvingMovedLink = false;
let pendingCreatedIssueId = null;

/*
  Статусы исполнения приходят только из Team_calculator.
  Team_poker не подключается к GitLab и не создаёт второй контур
  синхронизации. Ключ карты — issueId текущей сессии Team_poker.
*/
const calculatorDeliveryStatusByIssueId = new Map();
let calculatorDeliverySyncMeta = {
  state: "idle",
  syncedAt: null,
  error: null
};

/*
  Кэш нужен только на время работы страницы. Он позволяет не перечитывать
  задачи одной и той же сессии при каждом переключении между сессиями.
*/
const sessionIssuesCache = new Map();
let gitlabHistoryRequestId = 0;

/*
  Выбор задач для массового запуска голосования хранится только локально
  и очищается при переходе в другую команду или сессию.
*/
const selectedVotingIssueIds = new Set();
let bulkVotingInProgress = false;

let bulkMoveInProgress = false;

/*
  GitLab-статус фильтруется независимо для активных и оценённых задач.
  "__missing__" означает отсутствие workflow statusLabel в Team_calculator.
*/
const issueGitLabStatusFilters = {
  active: "all",
  estimated: "all"
};

let deliveryStatusRefreshInProgress = false;
let deliveryStatusRefreshUnsubscribe = null;
let deliveryStatusRefreshStage = "idle";
let deliveryStatusRefreshStartedAt = 0;
let deliveryStatusRefreshProgressTimer = null;
let deliveryStatusRefreshSpinnerIndex = 0;

/*
  GitLab discovery работает через metadata_connector.py:
  браузер создаёт отдельный discovery job, коннектор запрашивает GitLab и возвращает кандидатов.
*/
let gitlabDiscoveryUnsubscribe = null;
let gitlabDiscoveryJobRef = null;
let gitlabDiscoveryCandidates = [];
let gitlabDiscoveryExisting = [];
let gitlabDiscoveryConflicts = [];
let gitlabDiscoveryInProgress = false;

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

const DEVELOPMENT_AREAS = Object.freeze({
  backend: "Backend",
  frontend: "Frontend"
});

function isValidDevelopmentArea(value) {
  return Object.prototype.hasOwnProperty.call(
    DEVELOPMENT_AREAS,
    String(value || "")
  );
}

function developmentAreaLabel(value) {
  return isValidDevelopmentArea(value)
    ? DEVELOPMENT_AREAS[value]
    : "Направление не определено";
}

function developmentAreaClass(value) {
  return isValidDevelopmentArea(value)
    ? `area-${value}`
    : "area-unknown";
}

function sessionDevelopmentArea(session = currentSession()) {
  return isValidDevelopmentArea(session?.developmentArea)
    ? session.developmentArea
    : null;
}

function finalizationEstimatedRole(issue = state.issue) {
  return isValidDevelopmentArea(issue?.estimatedRole)
    ? issue.estimatedRole
    : null;
}

function currentTeamSnapshot() {
  const team = currentTeam();

  return {
    id: state.teamId,
    name: team?.name || "",
    developmentArea: isValidDevelopmentArea(team?.developmentArea)
      ? team.developmentArea
      : null
  };
}

function renderDevelopmentAreaBadges() {
  const team = currentTeam();
  const session = currentSession();

  const teamBadge = $("teamDevelopmentArea");
  if (teamBadge) {
    const area = isValidDevelopmentArea(team?.developmentArea)
      ? team.developmentArea
      : null;

    teamBadge.className =
      `area-badge ${developmentAreaClass(area)}`;
    teamBadge.textContent = developmentAreaLabel(area);
  }

  const sessionBadge = $("sessionDevelopmentArea");
  if (sessionBadge) {
    const area = sessionDevelopmentArea(session);

    sessionBadge.className =
      `area-badge ${developmentAreaClass(area)}`;
    sessionBadge.textContent = area
      ? `Направление оценки: ${developmentAreaLabel(area)}`
      : "Направление оценки не определено";
  }
}

const TEAM_ROLES = Object.freeze({
  admin: "Администратор",
  lead: "Тимлид",
  initiator: "Инициатор",
  member: "Участник"
});

function isValidTeamRole(value) {
  return Object.prototype.hasOwnProperty.call(
    TEAM_ROLES,
    String(value || "")
  );
}

function roleLabel(value) {
  return isValidTeamRole(value)
    ? TEAM_ROLES[value]
    : "Нет активной роли";
}

function roleCssClass(value) {
  return isValidTeamRole(value)
    ? `role-${value}`
    : "role-unknown";
}

function effectiveMemberRole(member) {
  const team = currentTeam();
  const memberEmail = normalizeEmail(member?.email);

  // Владелец старой команды автоматически становится администратором.
  // Документ участника и все существующие данные менять не требуется.
  if (
    team &&
    memberEmail &&
    memberEmail === normalizeEmail(team.ownerEmail)
  ) {
    return "admin";
  }

  return isValidTeamRole(member?.role)
    ? member.role
    : null;
}

function currentRole() {
  const email = normalizeEmail(currentUser?.email);
  const team = currentTeam();

  if (!team || !email) return null;

  if (email === normalizeEmail(team.ownerEmail)) {
    return "admin";
  }

  const member = state.members.find(
    item => normalizeEmail(item.email) === email
  );

  return effectiveMemberRole(member);
}

function isAdmin() {
  return currentRole() === "admin";
}

function isTeamLeadRole() {
  return currentRole() === "lead";
}

function canManageEstimation() {
  return ["admin", "lead"].includes(currentRole());
}

function canVote() {
  return ["lead", "member"].includes(currentRole());
}

function canCreateIssue() {
  return ["admin", "lead", "initiator"].includes(currentRole());
}

function ownsIssue(issue = state.issue) {
  if (!issue || !currentUser) return false;

  return issue.createdByUid === currentUser.uid
    || normalizeEmail(issue.createdByEmail)
      === normalizeEmail(currentUser.email);
}

function canEditIssue(issue = state.issue) {
  return Boolean(
    issue &&
    (
      canManageEstimation()
      || (currentRole() === "initiator" && ownsIssue(issue))
    )
  );
}

function canDeleteIssue(issue = state.issue) {
  if (!issue) return false;
  if (canManageEstimation()) return true;

  return currentRole() === "initiator"
    && ownsIssue(issue)
    && issue.status === "pending";
}

function votingMembers() {
  return state.members.filter(member =>
    ["lead", "member"].includes(effectiveMemberRole(member))
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

function stopDeliveryStatusRefreshProgressTimer() {
  if (deliveryStatusRefreshProgressTimer) {
    clearInterval(deliveryStatusRefreshProgressTimer);
    deliveryStatusRefreshProgressTimer = null;
  }
}

function startDeliveryStatusRefreshProgressTimer() {
  stopDeliveryStatusRefreshProgressTimer();

  deliveryStatusRefreshProgressTimer = setInterval(
    () => {
      deliveryStatusRefreshSpinnerIndex += 1;
      renderTaskStatusesRefreshButton();
    },
    250
  );
}

function clearDeliveryStatusRefreshListener() {
  unsubscribe(deliveryStatusRefreshUnsubscribe);
  deliveryStatusRefreshUnsubscribe = null;
  deliveryStatusRefreshInProgress = false;
  deliveryStatusRefreshStage = "idle";
  deliveryStatusRefreshStartedAt = 0;
  deliveryStatusRefreshSpinnerIndex = 0;
  stopDeliveryStatusRefreshProgressTimer();
}

function resetIssueGitLabStatusFilters() {
  issueGitLabStatusFilters.active = "all";
  issueGitLabStatusFilters.estimated = "all";
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

  clearDeliveryStatusRefreshListener();
  clearGitLabDiscoveryListener();
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

  /*
    Firestore должен быть инициализирован до первого await.
    Иначе подключаемые модули интеграций успевают вызвать getFirestore()
    с настройками по умолчанию, после чего initializeFirestore()
    с persistent cache завершается ошибкой different options.
  */
  /*
    По умолчанию используем memory cache.

    Persistent multi-tab cache ранее мог переполнить browser storage
    (`QuotaExceededError` в WebStorageSharedClientState) и после этого
    приводил Firestore к INTERNAL ASSERTION FAILED, из-за чего переставали
    загружаться команды/сессии/задачи.

    Persistent cache теперь включается только явно:
      enablePersistentCache: true
  */
  const cache = runtimeConfig.enablePersistentCache === true
    ? persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
    : memoryLocalCache();

  db = initializeFirestore(
    firebaseApp,
    { localCache: cache },
    runtimeConfig.firestoreDatabaseId || "(default)"
  );

  await setPersistence(auth, browserLocalPersistence);

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
  $("discoverGitLabIssuesBtn").addEventListener(
    "click",
    openGitLabDiscoveryDialog
  );
  $("requestGitLabDiscoveryBtn").addEventListener(
    "click",
    requestGitLabDiscovery
  );
  $("importGitLabCandidatesBtn").addEventListener(
    "click",
    importSelectedGitLabCandidates
  );
  $("gitlabDiscoverySelectAll").addEventListener(
    "change",
    toggleAllGitLabDiscoveryCandidates
  );
  $("closeGitLabDiscoveryBtn").addEventListener(
    "click",
    closeGitLabDiscoveryDialog
  );
  $("cancelGitLabDiscoveryBtn").addEventListener(
    "click",
    closeGitLabDiscoveryDialog
  );
  $("refreshTaskStatusesBtn").addEventListener(
    "click",
    requestTaskStatusesRefresh
  );
  $("moveSelectedIssuesBtn").addEventListener(
    "click",
    openBulkMoveIssueDialog
  );
  $("clearSelectedIssuesBtn").addEventListener(
    "click",
    clearSelectedIssues
  );
  $("confirmBulkMoveIssueBtn").addEventListener(
    "click",
    moveSelectedIssuesToSession
  );

  document.querySelectorAll(
    'input[name="bulkMoveMode"]'
  ).forEach(input => {
    input.addEventListener(
      "change",
      handleBulkMoveModeChange
    );
  });

  $("openIssueAuditBtn").addEventListener("click", openIssueAuditDialog);
  $("selectAllVotingIssuesBtn").addEventListener(
    "click",
    toggleSelectAllVotingIssues
  );
  $("startSelectedVotingBtn").addEventListener(
    "click",
    startSelectedVoting
  );
  $("saveIssueChangesBtn").addEventListener("click", saveIssueChanges);
  $("confirmMoveIssueBtn").addEventListener(
    "click",
    moveIssueToSession
  );
  $("saveEstimatedRoleBtn").addEventListener(
    "click",
    assignEstimatedRole
  );

  $("finalizeBtn").addEventListener("click", finalizeEstimate);
  $("copyEstimateBtn").addEventListener("click", copyEstimate);
  $("copyTeamCalendarBtn").addEventListener(
    "click",
    copyTeamCalendarPayload
  );
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

  $("addMemberBtn").disabled = availableUsers.length === 0 || !isAdmin();

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

function issueRedirectId(sessionId, issueId) {
  return `${sessionId}__${issueId}`;
}

function issueRedirectRef(teamId, sessionId, issueId) {
  return doc(
    db,
    "teams", teamId,
    "issue_redirects",
    issueRedirectId(sessionId, issueId)
  );
}

async function resolveMovedIssueLink(link) {
  if (!link || resolvingMovedLink) return false;

  resolvingMovedLink = true;

  try {
    let current = { ...link };
    let moved = false;

    // Поддерживаем цепочку из нескольких переносов одной задачи.
    for (let step = 0; step < 10; step += 1) {
      const redirectSnapshot = await getDoc(
        issueRedirectRef(
          current.teamId,
          current.sessionId,
          current.issueId
        )
      );

      if (!redirectSnapshot.exists()) break;

      const redirect = redirectSnapshot.data();

      current = {
        teamId: current.teamId,
        sessionId: redirect.targetSessionId,
        issueId: redirect.targetIssueId || current.issueId
      };

      moved = true;
    }

    if (!moved) return false;

    pendingTaskLink = current;
    taskLinkErrorShown = false;

    const redirectedUrl = new URL(window.location.href);
    redirectedUrl.hash = new URLSearchParams({
      team: current.teamId,
      session: current.sessionId,
      issue: current.issueId
    }).toString();

    window.history.replaceState(null, "", redirectedUrl.hash);
    applyPendingTaskLink();

    toast(
      "Задача была перенесена. Открыта её текущая сессия.",
      "success",
      4000
    );

    return true;
  } catch (error) {
    handleError(error);
    return false;
  } finally {
    resolvingMovedLink = false;
  }
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

async function synchronize(showSuccess = false) {
  if (!db) return;

  try {
    await disableNetwork(db);
    await enableNetwork(db);
    hideConnectionProblem();

    if (showSuccess) {
      toast("Соединение Firestore переподключено.", "success", 2500);
    }
  } catch (error) {
    handleError(error);
  }
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

  sessionIssuesCache.clear();
  gitlabHistoryRequestId += 1;
  selectedVotingIssueIds.clear();
  bulkVotingInProgress = false;
  bulkMoveInProgress = false;
  clearDeliveryStatusRefreshListener();
  clearGitLabDiscoveryListener();
  resetGitLabDiscoveryState();
  resetIssueGitLabStatusFilters();
  clearCalculatorDeliveryStatuses();

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

  sessionIssuesCache.clear();
  gitlabHistoryRequestId += 1;
  selectedVotingIssueIds.clear();
  bulkVotingInProgress = false;
  bulkMoveInProgress = false;
  clearDeliveryStatusRefreshListener();
  clearGitLabDiscoveryListener();
  resetGitLabDiscoveryState();
  resetIssueGitLabStatusFilters();
  clearCalculatorDeliveryStatuses();

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
      show($("memberEditor"), isAdmin());
      renderTeamControls();
      renderIssues();
      renderIssue();
    },
    error => handleError(error)
  );
}

function renderTeamControls() {
  const role = currentRole();
  const admin = isAdmin();
  const estimationManager = canManageEstimation();

  renderDevelopmentAreaBadges();

  $("teamRole").textContent = state.teamId
    ? `Ваша роль: ${roleLabel(role).toLowerCase()}`
    : "Команда не выбрана.";

  $("openSessionDialogBtn").disabled =
    !estimationManager || !state.teamId;

  $("editTeamBtn").disabled =
    !admin || !state.teamId;

  $("deleteTeamBtn").disabled =
    !admin || !state.teamId;

  $("manageMembersBtn").disabled = !state.teamId;

  $("openIssueDialogBtn").disabled =
    !canCreateIssue() || !state.sessionId;

  $("discoverGitLabIssuesBtn").disabled =
    !estimationManager || !state.sessionId || gitlabDiscoveryInProgress;

  $("editSessionBtn").disabled =
    !estimationManager || !state.sessionId;

  $("finishSessionBtn").disabled =
    !estimationManager || !state.sessionId;

  $("deleteSessionBtn").disabled =
    !estimationManager || !state.sessionId;
}

async function createTeam() {
  const name = $("newTeamName").value.trim();
  const developmentArea = $("newTeamDevelopmentArea").value;
  const target = $("teamDialogMessage");

  setFormMessage(target);
  if (!name) return setFormMessage(target, "Укажите название команды.");

  if (!isValidDevelopmentArea(developmentArea)) {
    return setFormMessage(
      target,
      "Выберите направление разработки: Backend или Frontend."
    );
  }

  await withButton($("createTeamBtn"), "Создание...", async () => {
    try {
      const email = normalizeEmail(currentUser.email);
      const teamRef = await addDoc(collection(db, "teams"), {
        name,
        ownerUid: currentUser.uid,
        ownerEmail: email,
        memberEmails: [email],
        leadEmails: [email],
        developmentArea,
        developmentAreaUpdatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });

      await setDoc(doc(db, "teams", teamRef.id, "members", email), {
        uid: currentUser.uid,
        email,
        displayName: currentUser.displayName || email,
        role: "admin",
        active: true,
        createdAt: serverTimestamp()
      });

      $("newTeamName").value = "";
      $("newTeamDevelopmentArea").value = "";
      closeDialog("teamDialog");
      localStorage.setItem("planningPoker.firebase.teamId", teamRef.id);
      toast(`Команда «${name}» создана.`, "success");
    } catch (error) {
      handleError(error, target);
    }
  });
}

function openEditTeamDialog() {
  if (!isAdmin() || !state.teamId) return;

  const team = currentTeam();
  if (!team) return;

  $("editTeamName").value = team.name || "";
  $("editTeamDevelopmentArea").value =
    isValidDevelopmentArea(team.developmentArea)
      ? team.developmentArea
      : "";
  setFormMessage($("editTeamMessage"));
  openDialog("editTeamDialog");

  setTimeout(() => {
    $("editTeamName").focus();
    $("editTeamName").select();
  }, 0);
}

async function saveTeamChanges() {
  if (!isAdmin() || !state.teamId) return;

  const name = $("editTeamName").value.trim();
  const developmentArea = $("editTeamDevelopmentArea").value;
  const target = $("editTeamMessage");

  setFormMessage(target);

  if (!name) {
    return setFormMessage(target, "Укажите название команды.");
  }

  if (name.length > 100) {
    return setFormMessage(target, "Название команды должно быть не длиннее 100 символов.");
  }

  if (!isValidDevelopmentArea(developmentArea)) {
    return setFormMessage(
      target,
      "Выберите направление разработки: Backend или Frontend."
    );
  }

  await withButton($("saveTeamChangesBtn"), "Сохранение...", async () => {
    try {
      await updateDoc(
        doc(db, "teams", state.teamId),
        {
          name,
          developmentArea,
          developmentAreaUpdatedAt: serverTimestamp(),
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
  show($("memberEditor"), isAdmin());
  openDialog("membersDialog");
}

function renderMembers() {
  const root = $("membersList");
  const currentEmail = normalizeEmail(currentUser?.email);
  const ownerEmail = normalizeEmail(currentTeam()?.ownerEmail);
  const admin = isAdmin();

  if (!state.members.length) {
    root.innerHTML = '<div class="empty-state">Участников нет.</div>';
    return;
  }

  root.innerHTML = state.members.map(member => {
    const memberEmail = normalizeEmail(member.email);
    const effectiveRole = effectiveMemberRole(member);
    const isOwner = memberEmail === ownerEmail;

    const canEditName = admin || memberEmail === currentEmail;
    const canChangeRole = admin && !isOwner;
    const canRemove =
      admin &&
      !isOwner &&
      memberEmail !== currentEmail;

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
            ${
              isOwner
                ? '<div class="member-owner-note">Владелец команды</div>'
                : ""
            }
          </div>
        `;

    const roleBlock = canChangeRole
      ? `
          <select
            class="member-role-select"
            data-member-role="${escapeHtml(memberEmail)}"
            aria-label="Роль участника"
          >
            ${Object.entries(TEAM_ROLES).map(([value, label]) => `
              <option
                value="${escapeHtml(value)}"
                ${effectiveRole === value ? "selected" : ""}
              >
                ${escapeHtml(label)}
              </option>
            `).join("")}
          </select>
        `
      : `
          <div class="role-pill ${roleCssClass(effectiveRole)}">
            ${escapeHtml(roleLabel(effectiveRole))}
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
        ${roleBlock}
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

  root.querySelectorAll("[data-member-role]").forEach(select => {
    select.addEventListener("change", () => {
      changeMemberRole(
        select.dataset.memberRole,
        select.value
      );
    });
  });

  root.querySelectorAll("[data-remove-member]").forEach(button => {
    button.addEventListener(
      "click",
      () => removeMember(button.dataset.removeMember)
    );
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
  const canEditName = isAdmin() || memberEmail === currentEmail;

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

async function changeMemberRole(email, nextRole) {
  if (!isAdmin() || !state.teamId) return;

  const memberEmail = normalizeEmail(email);
  const ownerEmail = normalizeEmail(currentTeam()?.ownerEmail);
  const member = state.members.find(
    item => normalizeEmail(item.email) === memberEmail
  );

  if (!member) {
    toast("Участник не найден.");
    return;
  }

  if (memberEmail === ownerEmail) {
    toast("Роль владельца команды всегда «Администратор».");
    renderMembers();
    return;
  }

  if (!isValidTeamRole(nextRole)) {
    toast("Выбрана неизвестная роль.");
    renderMembers();
    return;
  }

  const previousRole = effectiveMemberRole(member);
  if (previousRole === nextRole) return;

  try {
    const teamRef = doc(db, "teams", state.teamId);
    const memberRef = doc(
      db,
      "teams", state.teamId,
      "members", memberEmail
    );
    const batch = writeBatch(db);

    batch.update(memberRef, {
      role: nextRole,
      roleUpdatedByUid: currentUser.uid,
      roleUpdatedByEmail: normalizeEmail(currentUser.email),
      roleUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    batch.update(teamRef, {
      ...(nextRole === "lead"
        ? { leadEmails: arrayUnion(memberEmail) }
        : { leadEmails: arrayRemove(memberEmail) }),
      updatedAt: serverTimestamp()
    });

    await batch.commit();

    toast(
      `Роль изменена: ${roleLabel(nextRole)}.`,
      "success",
      2500
    );
  } catch (error) {
    handleError(error);
    renderMembers();
  }
}

async function addMember() {
  if (!isAdmin()) return;

  const selectedUid = $("memberUserSelect").value;
  const selectedUser = state.directoryUsers.find(
    user => (user.uid || user.id) === selectedUid
  );

  const displayName = $("memberName").value.trim();
  const role = $("memberRole").value;
  const target = $("memberDialogMessage");

  setFormMessage(target);

  if (!isValidTeamRole(role)) {
    return setFormMessage(target, "Выберите корректную роль.");
  }

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
  if (!isAdmin()) return;

  const memberEmail = normalizeEmail(email);
  const member = state.members.find(
    item => normalizeEmail(item.email) === memberEmail
  );

  if (!member) return;

  if (
    memberEmail === normalizeEmail(currentTeam()?.ownerEmail)
  ) {
    toast("Владельца команды нельзя удалить.");
    return;
  }

  if (!confirm(`Удалить ${member.displayName} из команды?`)) return;

  try {
    const teamRef = doc(db, "teams", state.teamId);
    const memberRef = doc(db, "teams", state.teamId, "members", email);
    const batch = writeBatch(db);

    batch.delete(memberRef);
    batch.update(teamRef, {
      memberEmails: arrayRemove(memberEmail),
      leadEmails: arrayRemove(memberEmail)
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
        const unresolvedLink = { ...pendingTaskLink };

        resolveMovedIssueLink(unresolvedLink).then(resolved => {
          if (!resolved && pendingTaskLink) {
            showTaskLinkError("Сессия из ссылки не найдена или была удалена.");
            pendingTaskLink = null;
          }
        });
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
          ${session.developmentArea
            ? ` · ${escapeHtml(developmentAreaLabel(session.developmentArea))}`
            : ""}
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
  selectedVotingIssueIds.clear();
  bulkVotingInProgress = false;
  bulkMoveInProgress = false;
  clearDeliveryStatusRefreshListener();
  clearGitLabDiscoveryListener();
  resetGitLabDiscoveryState();
  resetIssueGitLabStatusFilters();
  clearCalculatorDeliveryStatuses();

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
  refreshGitlabIssueHistory();
}

async function createSession() {
  if (!canManageEstimation()) return;

  const name = $("sessionName").value.trim();
  const iteration = $("sessionIteration").value.trim();
  const target = $("sessionDialogMessage");
  const teamSnapshot = currentTeamSnapshot();

  setFormMessage(target);
  if (!name) return setFormMessage(target, "Укажите название сессии.");

  if (!isValidDevelopmentArea(teamSnapshot.developmentArea)) {
    return setFormMessage(
      target,
      "Для команды не задано направление разработки. Укажите Backend или Frontend в настройках команды."
    );
  }

  await withButton($("createSessionBtn"), "Создание...", async () => {
    try {
      const sessionRef = await addDoc(
        collection(db, "teams", state.teamId, "sessions"),
        {
          name,
          iteration: iteration || null,
          status: "active",
          developmentArea: teamSnapshot.developmentArea,
          estimatedTeamId: teamSnapshot.id,
          estimatedTeamName: teamSnapshot.name,
          developmentAreaCapturedAt: serverTimestamp(),
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
  if (!canManageEstimation() || !state.sessionId) return;

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
  if (!canManageEstimation() || !state.sessionId) return;

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
  if (!canManageEstimation() || !state.sessionId) return;

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
    deleted: "удалил задачу",
    moved_out: "перенёс задачу в другую сессию",
    moved_in: "перенёс задачу в эту сессию",
    estimated_role_assigned: "указал направление оценки"
  })[action] || action;
}

function issueAuditActionClass(action) {
  return ({
    created: "created",
    edited: "edited",
    deleted: "deleted",
    moved_out: "moved",
    moved_in: "moved",
    estimated_role_assigned: "direction"
  })[action] || "";
}

function syntheticCreationEvents() {
  const auditedIssueIds = new Set(
    state.issueAudit
      .filter(event => event.action === "created")
      .map(event => event.issueId)
  );

  return state.issues
    .filter(
      issue =>
        !auditedIssueIds.has(issue.id) &&
        !issue.movedFromSessionId
    )
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

    const moveDetails = event.action === "moved_out"
      ? `В сессию: ${event.targetSessionName || event.targetSessionId || "—"}`
      : event.action === "moved_in"
        ? `Из сессии: ${event.sourceSessionName || event.sourceSessionId || "—"}`
        : "";

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

          ${
            moveDetails
              ? `
                  <div class="issue-audit-fields">
                    ${escapeHtml(moveDetails)}
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

  const directionAssignerName = issue.estimatedRoleAssignedByEmail
    ? issueActorName(
        issue.estimatedRoleAssignedByEmail,
        issue.estimatedRoleAssignedByDisplayName
      )
    : "";

  const directionAssignedAt = formatHistoryDate(
    issue.estimatedRoleAssignedAt
  );

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

    ${
      directionAssignerName
        ? `
            <span>
              Направление указал:
              <strong>${escapeHtml(directionAssignerName)}</strong>
              ${directionAssignedAt ? ` · ${escapeHtml(directionAssignedAt)}` : ""}
            </span>
          `
        : ""
    }
  `;
}

function sessionIssuesCacheKey(
  teamId,
  sessionId
) {
  return `${teamId || ""}:${sessionId || ""}`;
}

function normalizeGitlabIssueUrl(value) {
  const source = String(value || "").trim();
  if (!source) return "";

  try {
    const url = new URL(source);

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");

    return url.toString().replace(/\/$/, "");
  } catch {
    return source
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

function cachedSessionIssues(
  teamId,
  sessionId
) {
  return sessionIssuesCache.get(
    sessionIssuesCacheKey(teamId, sessionId)
  ) || [];
}

function cacheSessionIssues(
  teamId,
  sessionId,
  issues
) {
  sessionIssuesCache.set(
    sessionIssuesCacheKey(teamId, sessionId),
    issues.map(issue => ({ ...issue }))
  );
}

function occurrenceTimestamp(
  issue,
  session
) {
  return (
    timestampValue(issue?.createdAt)
    || timestampValue(session?.createdAt)
  );
}

function priorGitlabOccurrences(issue) {
  const normalizedUrl = normalizeGitlabIssueUrl(
    issue?.gitlabUrl
  );

  if (!normalizedUrl) return [];

  const currentSessionData = currentSession();
  const currentTimestamp = occurrenceTimestamp(
    issue,
    currentSessionData
  );

  const occurrences = [];

  for (const session of state.sessions) {
    if (session.id === state.sessionId) continue;

    for (
      const previousIssue
      of cachedSessionIssues(
        state.teamId,
        session.id
      )
    ) {
      if (
        normalizeGitlabIssueUrl(
          previousIssue.gitlabUrl
        ) !== normalizedUrl
      ) {
        continue;
      }

      const previousTimestamp = occurrenceTimestamp(
        previousIssue,
        session
      );

      /*
        Если обе даты известны, считаем только действительно более раннюю
        задачу. Для старых документов без createdAt используем порядок
        сессий как безопасный fallback.
      */
      if (
        currentTimestamp
        && previousTimestamp
        && previousTimestamp >= currentTimestamp
      ) {
        continue;
      }

      occurrences.push({
        issueId: previousIssue.id,
        issueTitle: previousIssue.title || "",
        finalEstimate:
          previousIssue.finalEstimate ?? null,
        status: previousIssue.status || "",
        createdAt: previousIssue.createdAt || null,
        sessionId: session.id,
        sessionName:
          session.name
          || session.iteration
          || "Другая сессия",
        sessionCreatedAt: session.createdAt || null
      });
    }
  }

  return occurrences.sort(
    (left, right) =>
      (
        occurrenceTimestamp(
          right,
          { createdAt: right.sessionCreatedAt }
        )
        - occurrenceTimestamp(
          left,
          { createdAt: left.sessionCreatedAt }
        )
      )
  );
}

function priorGitlabTooltip(occurrences) {
  const descriptions = occurrences
    .slice(0, 6)
    .map(occurrence => {
      const estimate = occurrence.finalEstimate
        ? ` · ${occurrence.finalEstimate} ч.д.`
        : "";

      return (
        `${occurrence.sessionName}: `
        + `${occurrence.issueTitle || "задача"}`
        + estimate
      );
    });

  if (occurrences.length > descriptions.length) {
    descriptions.push(
      `и ещё ${occurrences.length - descriptions.length}`
    );
  }

  return (
    "Эта GitLab-ссылка уже встречалась ранее. "
    + descriptions.join("; ")
  );
}

async function refreshGitlabIssueHistory() {
  const requestId = ++gitlabHistoryRequestId;
  const teamId = state.teamId;
  const currentSessionId = state.sessionId;

  if (!teamId || !currentSessionId) {
    renderIssues();
    return;
  }

  const sessionsToLoad = state.sessions.filter(
    session =>
      session.id !== currentSessionId
      && !sessionIssuesCache.has(
        sessionIssuesCacheKey(
          teamId,
          session.id
        )
      )
  );

  if (!sessionsToLoad.length) {
    renderIssues();
    return;
  }

  const results = await Promise.allSettled(
    sessionsToLoad.map(async session => {
      const snapshot = await getDocs(
        collection(
          db,
          "teams", teamId,
          "sessions", session.id,
          "issues"
        )
      );

      const issues = snapshot.docs
        .map(issueDoc => ({
          id: issueDoc.id,
          ...issueDoc.data()
        }))
        .filter(
          issue => issue.moveState !== "copying"
        );

      return {
        sessionId: session.id,
        issues
      };
    })
  );

  if (
    requestId !== gitlabHistoryRequestId
    || teamId !== state.teamId
    || currentSessionId !== state.sessionId
  ) {
    return;
  }

  for (const result of results) {
    if (result.status === "fulfilled") {
      cacheSessionIssues(
        teamId,
        result.value.sessionId,
        result.value.issues
      );
    } else {
      console.warn(
        "Не удалось загрузить задачи одной из "
        + "предыдущих сессий для проверки GitLab-ссылок:",
        result.reason
      );
    }
  }

  renderIssues();
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
        .map(issueDoc => ({
          id: issueDoc.id,
          ...issueDoc.data(),
          _hasPendingWrites:
            issueDoc.metadata.hasPendingWrites === true
        }))
        .filter(
          issue => issue.moveState !== "copying"
        )
        .sort((a, b) => {
          const groupDiff =
            (a.status === "estimated" ? 1 : 0)
            - (b.status === "estimated" ? 1 : 0);

          if (groupDiff) return groupDiff;

          const sortDiff =
            Number(a.sortOrder || 0)
            - Number(b.sortOrder || 0);

          return sortDiff
            || timestampValue(b.createdAt)
              - timestampValue(a.createdAt);
        });

      cacheSessionIssues(
        state.teamId,
        state.sessionId,
        state.issues
      );

      const previousIssue = state.issue;
      const linkedIssueId = (
        pendingTaskLink?.teamId === state.teamId &&
        pendingTaskLink?.sessionId === state.sessionId
      )
        ? pendingTaskLink.issueId
        : null;

      const createdIssueId =
        pendingCreatedIssueId
        && state.issues.some(
          issue => issue.id === pendingCreatedIssueId
        )
          ? pendingCreatedIssueId
          : null;

      const nextIssueId =
        linkedIssueId
        && state.issues.some(
          issue => issue.id === linkedIssueId
        )
          ? linkedIssueId
          : createdIssueId
            ? createdIssueId
            : state.issues.some(
                issue => issue.id === state.issueId
              )
              ? state.issueId
              : state.issues.find(
                  issue => issue.status !== "estimated"
                )?.id
                || state.issues[0]?.id
                || null;

      state.issueId = nextIssueId;
      state.issue = state.issues.find(issue => issue.id === nextIssueId) || null;

      try {
        renderIssues();
      } catch (renderError) {
        renderIssuesFallback(renderError);
      }

      notifyCalculatorIssuesChanged();

      if (
        createdIssueId
        && createdIssueId === state.issueId
      ) {
        focusCreatedIssue(createdIssueId);
        pendingCreatedIssueId = null;
      }

      if (!state.issue) {
        clearVoteListeners();
        show($("welcomeCard"));
        show($("issueCard"), false);
        return;
      }

      const subscriptionKey =
        voteSubscriptionKey(state.issue);

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
        const unresolvedLink = { ...pendingTaskLink };

        resolveMovedIssueLink(unresolvedLink).then(resolved => {
          if (!resolved && pendingTaskLink) {
            showTaskLinkError("Задача из ссылки не найдена или была удалена.");
            pendingTaskLink = null;
          }
        });
      } else {
        applyPendingTaskLink();
      }

      syncCurrentTaskLink();
    },
    error => {
      console.error(
        "Ошибка чтения задач текущей сессии из Firestore",
        error
      );

      const root = $("issueList");

      if (root) {
        root.innerHTML = `
          <div class="message error">
            Не удалось загрузить задачи из Firestore:
            ${escapeHtml(
              error?.message || String(error)
            )}
          </div>
        `;
      }

      handleError(error);
    }
  );
}

function clearCalculatorDeliveryStatuses() {
  calculatorDeliveryStatusByIssueId.clear();
  calculatorDeliverySyncMeta = {
    state: "idle",
    syncedAt: null,
    error: null
  };
}

function calculatorDeliveryStatus(issue) {
  if (!issue?.id) return null;
  return calculatorDeliveryStatusByIssueId.get(issue.id) || null;
}

function calculatorStatusDateLabel(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function calculatorDeliveryToneClass(value) {
  const tone = String(value || "neutral").trim();
  return ["neutral", "info", "success", "warning", "purple"]
    .includes(tone)
      ? `tone-${tone}`
      : "tone-neutral";
}

function calculatorDeliveryTooltip(status) {
  if (!status?.delivery) return "";

  const delivery = status.delivery;
  const parts = [
    delivery.label || "Статус Team_calculator",
    "Источник: Team_calculator"
  ];

  if (delivery.plannedSprintName) {
    parts.push(`Спринт: ${delivery.plannedSprintName}`);
  }

  const updated = calculatorStatusDateLabel(
    delivery.updatedAt || status.syncedAt
  );

  if (updated) {
    parts.push(`Обновлено: ${updated}`);
  }

  return parts.join(". ");
}

function calculatorDeliveryBadgeHtml(
  issue,
  { compact = false } = {}
) {
  const status = calculatorDeliveryStatus(issue);
  const delivery = status?.delivery;

  if (!delivery?.label) return "";

  /*
    Локальная отметка переоценки уже видна рядом с задачей.
    Не дублируем её второй такой же плашкой.
  */
  if (
    delivery.code === "reestimate_required"
    && issue?.reestimateRequired === true
  ) {
    return "";
  }

  return `
    <span
      class="calculator-delivery-badge ${calculatorDeliveryToneClass(
        delivery.tone
      )} ${compact ? "compact" : ""}"
      title="${escapeHtml(calculatorDeliveryTooltip(status))}"
    >
      <span aria-hidden="true">${escapeHtml(delivery.icon || "●")}</span>
      ${escapeHtml(delivery.label)}
    </span>
  `;
}

function calculatorGitLabTooltip(status) {
  const gitlab = status?.gitlab;
  if (!gitlab) return "";

  const parts = [
    "Данные GitLab получены через Team_calculator",
    gitlab.issueState
      ? `Issue: ${gitlab.issueState}`
      : "",
    gitlab.statusLabel
      ? `Статус: ${gitlab.statusLabel}`
      : "",
    Array.isArray(gitlab.auxiliaryStatusLabels)
      && gitlab.auxiliaryStatusLabels.length
        ? `Дополнительно: ${gitlab.auxiliaryStatusLabels.join(", ")}`
        : "",
    gitlab.iterationTitle
      ? `Iteration: ${gitlab.iterationTitle}`
      : "",
    gitlab.syncedAt
      ? `Обновлено: ${calculatorStatusDateLabel(gitlab.syncedAt)}`
      : "",
    gitlab.syncError
      ? `Ошибка последней попытки: ${gitlab.syncError}`
      : ""
  ].filter(Boolean);

  return parts.join(". ");
}

function calculatorGitLabBadgeHtml(
  issue,
  { compact = false } = {}
) {
  const status = calculatorDeliveryStatus(issue);
  const gitlab = status?.gitlab;

  if (!gitlab) return "";

  const label = gitlab.statusLabel
    || (
      gitlab.issueState === "closed"
        ? "Closed"
        : gitlab.issueState === "opened"
          ? "Open"
          : "GitLab"
    );

  const tone = gitlab.issueState === "closed"
    ? "success"
    : gitlab.syncError
      ? "warning"
      : "neutral";

  return `
    <span
      class="calculator-gitlab-badge ${calculatorDeliveryToneClass(
        tone
      )} ${compact ? "compact" : ""}"
      title="${escapeHtml(calculatorGitLabTooltip(status))}"
    >
      GitLab · ${escapeHtml(label)}
    </span>
  `;
}

function applyCalculatorDeliveryStatuses(
  items,
  meta = {}
) {
  const next = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const issueId = String(item?.issueId || "").trim();

    if (!issueId || item?.found !== true) continue;

    next.set(issueId, item);
  }

  const previousFingerprint = JSON.stringify(
    [...calculatorDeliveryStatusByIssueId.entries()]
  );

  const nextFingerprint = JSON.stringify(
    [...next.entries()]
  );

  calculatorDeliveryStatusByIssueId.clear();
  for (const [issueId, item] of next.entries()) {
    calculatorDeliveryStatusByIssueId.set(issueId, item);
  }

  calculatorDeliverySyncMeta = {
    state: String(meta.state || "ok"),
    syncedAt: meta.syncedAt || new Date().toISOString(),
    error: meta.error || null
  };

  if (previousFingerprint !== nextFingerprint) {
    renderIssues();
    if (state.issue) renderIssue();
  }
}

function calculatorDeliveryStatusDescriptors() {
  return state.issues
    .filter(issue =>
      issue
      && isValidDevelopmentArea(issue.estimatedRole)
      && (
        issue.finalEstimate != null
        || issue.status === "estimated"
        || issue.reestimateRequired === true
      )
    )
    .map(issue => ({
      issueId: issue.id,
      taskId: issue.id,
      title: issue.title || "",
      externalTaskUrl: issue.gitlabUrl || null,
      estimatedRole: issue.estimatedRole,
      teamId: state.teamId,
      sessionId: state.sessionId
    }));
}

function notifyCalculatorIssuesChanged() {
  window.dispatchEvent(
    new CustomEvent("team-poker:issues-changed")
  );
}

function renderTaskStatusesRefreshButton() {
  const button = $("refreshTaskStatusesBtn");

  if (!button) return;

  const available = Boolean(
    currentUser
    && state.teamId
    && state.sessionId
  );

  button.disabled =
    !available
    || deliveryStatusRefreshInProgress;

  if (!deliveryStatusRefreshInProgress) {
    button.textContent = "Обновить статусы";
    button.removeAttribute("aria-busy");
    button.title =
      "Обновить статусы из уже сохранённых данных Team_calculator без повторного опроса GitLab";
    return;
  }

  const spinnerFrames = [
    "⠋", "⠙", "⠹", "⠸",
    "⠼", "⠴", "⠦", "⠧",
    "⠇", "⠏"
  ];

  const spinner =
    spinnerFrames[
      deliveryStatusRefreshSpinnerIndex
      % spinnerFrames.length
    ];

  const elapsedSeconds =
    deliveryStatusRefreshStartedAt
      ? Math.max(
          0,
          Math.floor(
            (
              Date.now()
              - deliveryStatusRefreshStartedAt
            ) / 1000
          )
        )
      : 0;

  const elapsedText =
    elapsedSeconds > 0
      ? ` · ${elapsedSeconds}с`
      : "";

  let stageText = "Создание запроса";

  if (deliveryStatusRefreshStage === "pending") {
    stageText = "Ожидает connector";
  } else if (
    deliveryStatusRefreshStage === "processing"
  ) {
    stageText = "Обновление статусов";
  }

  button.textContent =
    `${spinner} ${stageText}${elapsedText}`;

  button.setAttribute("aria-busy", "true");

  button.title =
    deliveryStatusRefreshStage === "processing"
      ? "Connector обновляет статусы задач из Team_calculator"
      : "Запрос поставлен в очередь и ожидает обработки connector";
}

async function requestTaskStatusesRefresh() {
  if (
    !currentUser
    ||!state.teamId
    ||!state.sessionId
    ||deliveryStatusRefreshInProgress
  ) {
    return;
  }

  clearDeliveryStatusRefreshListener();

  deliveryStatusRefreshInProgress = true;
  deliveryStatusRefreshStage = "creating";
  deliveryStatusRefreshStartedAt = Date.now();
  deliveryStatusRefreshSpinnerIndex = 0;
  startDeliveryStatusRefreshProgressTimer();
  renderTaskStatusesRefreshButton();

  const now = new Date().toISOString();

  try {
    const requestRef = await addDoc(
      collection(
        db,
        "teams",
        state.teamId,
        "delivery_status_refresh"
      ),
      {
        schemaVersion: 1,
        type: "refresh_delivery_status",
        status: "pending",
        teamId: state.teamId,
        sessionId: state.sessionId,
        sessionName: currentSession()?.name || "",
        requestedByUid: currentUser.uid,
        requestedByEmail:
          normalizeEmail(currentUser.email),
        requestedByDisplayName:
          currentUser.displayName
          ||currentUser.email
          ||"",
        requestedAt: now,
        updatedAt: now
      }
    );

    toast(
      "Запрос на обновление статусов передан connector.",
      "success",
      2500
    );

    deliveryStatusRefreshUnsubscribe =
      onSnapshot(
        requestRef,
        snapshot => {
          if (!snapshot.exists()) return;

          const data = snapshot.data() || {};
          const status = String(
            data.status || ""
          ).trim();

          if (status === "pending") {
            deliveryStatusRefreshStage = "pending";
            renderTaskStatusesRefreshButton();
            return;
          }

          if (status === "processing") {
            deliveryStatusRefreshStage = "processing";
            renderTaskStatusesRefreshButton();
            return;
          }

          const scannedCount = Number(
            data.scannedCount || 0
          );

          const matchedTaskCount = Number(
            data.matchedTaskCount || 0
          );

          const mirroredCount = Number(
            data.mirroredCount || 0
          );

          clearDeliveryStatusRefreshListener();
          renderTaskStatusesRefreshButton();

          if (status === "succeeded") {
            toast(
              (
                `Статусы обновлены: ${mirroredCount}. `
                + `Найдено задач Team_poker в Team_calculator: ${matchedTaskCount}; `
                + `проверено записей: ${scannedCount}.`
              ),
              "success",
              5000
            );
            return;
          }

          toast(
            String(
              data.error
              ||"Не удалось обновить статусы."
            ),
            "error",
            6000
          );
        },
        error => {
          console.error(
            "Ошибка наблюдения за обновлением статусов",
            error
          );

          clearDeliveryStatusRefreshListener();
          renderTaskStatusesRefreshButton();

          toast(
            "Не удалось получить результат обновления статусов.",
            "error",
            5000
          );
        }
      );
  } catch (error) {
    clearDeliveryStatusRefreshListener();
    renderTaskStatusesRefreshButton();
    const permissionDenied=["permission-denied","firestore/permission-denied"].includes(error?.code);
    if (permissionDenied) {
      toast("Firestore не разрешил запрос обновления статусов. Опубликуйте firestore.rules из текущего релиза Team_poker.","error",7000);
      console.error("delivery_status_refresh denied by Firestore Rules",error);
      return;
    }
    handleError(error);
  }
}

function issueStatusText(status) {
  return ({
    pending: "Не начата",
    voting: "Голосование",
    revealed: "Оценки раскрыты",
    estimated: "Оценена"
  })[status] || status;
}

function issueDisplayStatusText(issue) {
  if (issue?.reestimateRequired === true) {
    return "На переоценку";
  }

  return issueStatusText(issue?.status);
}

function issueGitLabWorkflowStatus(issue) {
  const value = String(
    calculatorDeliveryStatus(issue)
      ?.gitlab
      ?.statusLabel
    ||""
  ).trim();

  return value || "__missing__";
}

function gitLabStatusFilterLabel(value) {
  return value === "__missing__"
    ? "Статус не указан"
    : value;
}

function issueMatchesGitLabStatusFilter(
  issue,
  filterValue
) {
  return (
    !filterValue
    ||filterValue === "all"
    ||issueGitLabWorkflowStatus(issue)
      ===filterValue
  );
}

function gitLabStatusFilterOptions(issues) {
  return [
    ...new Set(
      issues.map(
        issue=>issueGitLabWorkflowStatus(issue)
      )
    )
  ].sort((a,b)=>{
    if(a==="__missing__")return 1;
    if(b==="__missing__")return -1;

    return a.localeCompare(
      b,
      "ru",
      {sensitivity:"base"}
    );
  });
}

function visibleActiveIssues() {
  return state.issues.filter(
    issue =>
      issue.status !== "estimated"
      && issueMatchesGitLabStatusFilter(
        issue,
        issueGitLabStatusFilters.active
      )
  );
}

function visibleEstimatedIssues() {
  return state.issues.filter(
    issue =>
      issue.status === "estimated"
      && issueMatchesGitLabStatusFilter(
        issue,
        issueGitLabStatusFilters.estimated
      )
  );
}

function issueSelectableForBulkActions(issue) {
  return Boolean(
    canManageEstimation()
    && issue
    && issue.moveState !== "copying"
    && issue.status !== "voting"
  );
}

function visibleBulkSelectableIssues() {
  return [
    ...visibleActiveIssues(),
    ...visibleEstimatedIssues()
  ].filter(issueSelectableForBulkActions);
}

function selectedIssues() {
  return state.issues.filter(
    issue => selectedVotingIssueIds.has(issue.id)
  );
}

function selectedPendingIssues() {
  return selectedIssues().filter(
    issue => issue.status === "pending"
  );
}

function selectedTransferableIssues() {
  return selectedIssues().filter(
    issueSelectableForBulkActions
  );
}

function pruneVotingIssueSelection() {
  const selectableIds = new Set(
    visibleBulkSelectableIssues().map(issue => issue.id)
  );

  for (const issueId of selectedVotingIssueIds) {
    if (!selectableIds.has(issueId)) {
      selectedVotingIssueIds.delete(issueId);
    }
  }
}

function renderBulkVotingControls() {
  const controls = $("bulkVotingControls");
  const selectAllButton = $("selectAllVotingIssuesBtn");
  const startButton = $("startSelectedVotingBtn");
  const moveButton = $("moveSelectedIssuesBtn");
  const clearButton = $("clearSelectedIssuesBtn");
  const countElement = $("selectedVotingIssuesCount");

  if (!controls || !selectAllButton || !startButton || !moveButton || !clearButton || !countElement) return;

  pruneVotingIssueSelection();

  const selectableIssues = visibleBulkSelectableIssues();
  const selected = selectedTransferableIssues();
  const selectedCount = selected.length;
  const pendingCount = selected.filter(issue => issue.status === "pending").length;
  const allVisibleSelected = selectableIssues.length > 0 && selectableIssues.every(issue => selectedVotingIssueIds.has(issue.id));
  const visible = canManageEstimation() && Boolean(state.sessionId) && selectableIssues.length > 0;

  show(controls, visible);
  if (!visible) { countElement.textContent = ""; return; }

  selectAllButton.textContent = allVisibleSelected ? "Снять выбор видимых" : "Выбрать все видимые";
  selectAllButton.disabled = bulkVotingInProgress || bulkMoveInProgress || selectableIssues.length === 0;
  countElement.textContent = selectedCount ? `Выбрано: ${selectedCount}` : `Доступно: ${selectableIssues.length}`;
  startButton.textContent = pendingCount ? `Начать голосование · ${pendingCount}` : "Начать голосование";
  startButton.disabled = bulkVotingInProgress || bulkMoveInProgress || pendingCount === 0;
  moveButton.textContent = selectedCount ? `Перенести · ${selectedCount}` : "Перенести";
  moveButton.disabled = bulkVotingInProgress || bulkMoveInProgress || selectedCount === 0;
  clearButton.disabled = bulkVotingInProgress || bulkMoveInProgress || selectedCount === 0;
}

function toggleVotingIssueSelection(issueId, selected) {
  const issue = state.issues.find(item => item.id === issueId);
  if (!issueSelectableForBulkActions(issue)) {
    selectedVotingIssueIds.delete(issueId);
    renderIssues();
    return;
  }
  if (selected) selectedVotingIssueIds.add(issueId); else selectedVotingIssueIds.delete(issueId);
  renderIssues();
}

function toggleSelectAllVotingIssues() {
  if (!canManageEstimation() || bulkVotingInProgress || bulkMoveInProgress) return;
  const selectableIssues = visibleBulkSelectableIssues();
  const allSelected = selectableIssues.length > 0 && selectableIssues.every(issue => selectedVotingIssueIds.has(issue.id));
  for (const issue of selectableIssues) {
    if (allSelected) selectedVotingIssueIds.delete(issue.id); else selectedVotingIssueIds.add(issue.id);
  }
  renderIssues();
}

function clearSelectedIssues() {
  if (bulkVotingInProgress || bulkMoveInProgress) return;
  selectedVotingIssueIds.clear();
  renderIssues();
}

async function startSelectedVoting() {
  if (!canManageEstimation() || bulkVotingInProgress || bulkMoveInProgress) return;
  const issues = selectedPendingIssues();
  if (!issues.length) { renderIssues(); return; }
  bulkVotingInProgress = true;
  renderBulkVotingControls();
  try {
    const chunkSize = 400;
    for (let offset = 0; offset < issues.length; offset += chunkSize) {
      const batch = writeBatch(db);
      const chunk = issues.slice(offset, offset + chunkSize);
      for (const issue of chunk) {
        batch.update(doc(db,"teams",state.teamId,"sessions",state.sessionId,"issues",issue.id),{status:"voting",updatedAt:serverTimestamp()});
      }
      await batch.commit();
    }
    for (const issue of issues) selectedVotingIssueIds.delete(issue.id);
    toast(issues.length===1?"Голосование начато по выбранной задаче.":`Голосование начато по ${issues.length} задачам.`,"success");
  } catch (error) { handleError(error); }
  finally { bulkVotingInProgress=false; renderIssues(); }
}

function issueTransferInfo(
  issue = state.issue,
  context = null
) {
  if (!issue || !issue.movedFromSessionId) {
    return null;
  }

  const targetSessionId = String(
    context?.sessionId
    || state.sessionId
    || ""
  );

  const targetSessionName = String(
    context?.sessionName
    || (
      targetSessionId === state.sessionId
        ? currentSession()?.name
        : ""
    )
    || ""
  );

  return {
    isTransferred: true,
    fromSessionId: String(
      issue.movedFromSessionId || ""
    ),
    fromSessionName: String(
      issue.movedFromSessionName || ""
    ),
    toSessionId: targetSessionId,
    toSessionName: targetSessionName,
    movedAt: timestampToIso(issue.movedAt),
    movedAtLabel: formatHistoryDate(issue.movedAt),
    movedBy: {
      uid: issue.movedByUid || null,
      email: issue.movedByEmail || null,
      displayName:
        issue.movedByDisplayName || null
    }
  };
}

function issueTransferTooltip(issue) {
  const transfer = issueTransferInfo(issue);

  if (!transfer) return "";

  const details = [
    transfer.fromSessionName
      ? `Из сессии «${transfer.fromSessionName}»`
      : "Перенесена из другой сессии",
    transfer.toSessionName
      ? `в сессию «${transfer.toSessionName}»`
      : "",
    transfer.movedAtLabel
      ? `Дата переноса: ${transfer.movedAtLabel}`
      : ""
  ].filter(Boolean);

  return details.join(". ");
}

function issueListItemHtml(issue) {
  const previousOccurrences =
    priorGitlabOccurrences(issue);

  const wasPreviouslySeen =
    previousOccurrences.length > 0;

  const latestPreviousOccurrence =
    previousOccurrences[0] || null;

  const previousTaskLink =
    latestPreviousOccurrence
      ? buildTaskLink(
          state.teamId,
          latestPreviousOccurrence.sessionId,
          latestPreviousOccurrence.issueId
        )
      : null;

  const duplicateBadge =
    wasPreviouslySeen && previousTaskLink
      ? `
          <a
            class="prior-gitlab-badge"
            href="${escapeHtml(previousTaskLink)}"
            title="${escapeHtml(
              "Открыть последнее предыдущее упоминание. "
              + priorGitlabTooltip(
                  previousOccurrences
                )
            )}"
            aria-label="${escapeHtml(
              "Открыть предыдущее упоминание задачи "
              + (
                latestPreviousOccurrence
                  .issueTitle
                || issue.title
              )
            )}"
          >
            Была ранее${
              previousOccurrences.length > 1
                ? ` · ${previousOccurrences.length}`
                : ""
            }
            <span
              class="prior-gitlab-link-icon"
              aria-hidden="true"
            >↗</span>
          </a>
        `
      : "";

  const transferInfo = issueTransferInfo(issue);

  const transferBadge = transferInfo
    ? `
        <span
          class="transferred-issue-badge"
          title="${escapeHtml(issueTransferTooltip(issue))}"
        >
          <span aria-hidden="true">↪</span>
          Перенесена
        </span>
      `
    : "";

  const reestimateBadge =
    issue.reestimateRequired === true
      ? `
          <span
            class="reestimate-issue-badge"
            title="После переноса требуется повторное голосование и новая итоговая оценка."
          >
            <span aria-hidden="true">↻</span>
            На переоценку
          </span>
        `
      : "";

  const issueBadges =
    transferBadge
    || reestimateBadge
    || duplicateBadge
      ? `
          <div class="item-title-badges">
            ${reestimateBadge}
            ${transferBadge}
            ${duplicateBadge}
          </div>
        `
      : "";

  const calculatorStatusBadges = [
    calculatorDeliveryBadgeHtml(issue, { compact: true }),
    calculatorGitLabBadgeHtml(issue, { compact: true })
  ].filter(Boolean).join("");

  let selectableForBulk = false;

  try {
    selectableForBulk = Boolean(
      canManageEstimation()
      && issue
      && issue.moveState !== "copying"
      && issue.status !== "voting"
    );
  } catch (error) {
    console.error(
      "Не удалось определить доступность массовых действий",
      error
    );
  }

  const selectedForBulk =
    selectableForBulk
    && selectedVotingIssueIds.has(issue.id);

  const votingCheckbox = selectableForBulk
    ? `
        <input
          class="issue-voting-checkbox"
          type="checkbox"
          data-voting-issue-id="${issue.id}"
          aria-label="${escapeHtml(
            `Выбрать задачу «${issue.title}» для массовых действий`
          )}"
          ${selectedForBulk ? "checked" : ""}
        >
      `
    : "";

  return `
    <div
      class="item ${
        issue.id === state.issueId ? "active" : ""
      } ${
        wasPreviouslySeen
          ? "has-prior-gitlab"
          : ""
      } ${
        selectedForBulk
          ? "bulk-selected"
          : ""
      }"
      data-issue-id="${issue.id}"
    >
      <div class="item-main-row">
        ${votingCheckbox}

        <div class="item-body">
          <div class="item-title-row">
            <div class="item-title">
              ${escapeHtml(issue.title)}
            </div>
            ${issueBadges}
          </div>

          <div class="item-meta-row">
            <div class="item-meta">
              ${escapeHtml(issueDisplayStatusText(issue))}
              ${
                issue.finalEstimate
                  ? ` · ${issue.finalEstimate} ч.д.`
                  : ""
              }
            </div>
            ${
              calculatorStatusBadges
                ? `<div class="calculator-status-badges">${calculatorStatusBadges}</div>`
                : ""
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderIssueGroup(
  title,
  sourceIssues,
  filteredIssues,
  className,
  filterKey
) {
  if (!sourceIssues.length) return "";

  const options =
    gitLabStatusFilterOptions(sourceIssues);

  let selected =
    issueGitLabStatusFilters[filterKey]
    ||"all";

  if (
    selected !== "all"
    &&!options.includes(selected)
  ) {
    selected = "all";
    issueGitLabStatusFilters[filterKey] =
      "all";
  }

  const filterOptions = [
    '<option value="all">Все статусы GitLab</option>',
    ...options.map(value=>`
      <option
        value="${escapeHtml(value)}"
        ${value===selected ? "selected" : ""}
      >
        ${escapeHtml(
          gitLabStatusFilterLabel(value)
        )}
      </option>
    `)
  ].join("");

  const countText =
    filteredIssues.length === sourceIssues.length
      ?String(sourceIssues.length)
      :`${filteredIssues.length}/${sourceIssues.length}`;

  return `
    <section class="issue-list-group ${className}">
      <div class="issue-list-group-title">
        <div class="issue-list-group-heading">
          <span>${escapeHtml(title)}</span>
          <span class="issue-list-group-count">
            ${escapeHtml(countText)}
          </span>
        </div>

        <select
          class="issue-gitlab-status-filter"
          data-issue-status-filter="${escapeHtml(filterKey)}"
          aria-label="Фильтр ${escapeHtml(title)} по статусу GitLab"
        >
          ${filterOptions}
        </select>
      </div>

      <div class="issue-list-group-items">
        ${
          filteredIssues.length
            ?filteredIssues
              .map(issueListItemHtml)
              .join("")
            :'<div class="issue-filter-empty">Нет задач с выбранным статусом</div>'
        }
      </div>
    </section>
  `;
}

function renderIssues() {
  const root = $("issueList");

  renderTaskStatusesRefreshButton();

  /*
    Основной список задач не должен зависеть от вторичных
    массовых действий. Сначала всегда отображаем задачи.
  */
  if (!state.issues.length) {
    root.innerHTML =
      '<div class="empty-state">Нет задач</div>';
    renderBulkVotingControls();
    return;
  }

  const activeIssues = state.issues.filter(
    issue => issue.status !== "estimated"
  );

  const estimatedIssues = state.issues.filter(
    issue => issue.status === "estimated"
  );

  const filteredActiveIssues =
    activeIssues.filter(
      issue=>issueMatchesGitLabStatusFilter(
        issue,
        issueGitLabStatusFilters.active
      )
    );

  const filteredEstimatedIssues =
    estimatedIssues.filter(
      issue=>issueMatchesGitLabStatusFilter(
        issue,
        issueGitLabStatusFilters.estimated
      )
    );

  root.innerHTML = [
    renderIssueGroup(
      "Активные",
      activeIssues,
      filteredActiveIssues,
      "active-issues",
      "active"
    ),
    renderIssueGroup(
      "Оценённые",
      estimatedIssues,
      filteredEstimatedIssues,
      "estimated-issues",
      "estimated"
    )
  ].join("");

  root.querySelectorAll(
    "[data-issue-status-filter]"
  ).forEach(select=>{
    select.addEventListener(
      "change",
      event=>{
        const key=String(
          event.currentTarget
            .dataset.issueStatusFilter
          ||""
        ).trim();

        if(
          !["active","estimated"].includes(key)
        ){
          return;
        }

        issueGitLabStatusFilters[key]=
          event.currentTarget.value||"all";

        renderIssues();
      }
    );
  });

  root.querySelectorAll(
    "[data-voting-issue-id]"
  ).forEach(checkbox => {
    checkbox.addEventListener(
      "change",
      event => toggleVotingIssueSelection(
        event.currentTarget.dataset.votingIssueId,
        event.currentTarget.checked
      )
    );
  });

  try {
    renderBulkVotingControls();
  } catch (error) {
    console.error(
      "Ошибка панели массовых действий. Список задач продолжает работать.",
      error
    );

    const controls = $("bulkVotingControls");
    if (controls) {
      controls.classList.add("hidden");
    }
  }

  root.querySelectorAll("[data-issue-id]").forEach(item => {
    item.addEventListener(
      "click",
      event => {
        /*
          Ссылки и кнопки внутри карточки выполняют собственное действие
          и не должны сначала открывать текущую задачу.
        */
        if (
          event.target.closest(
            "a, button, input, select, textarea"
          )
        ) {
          return;
        }

        selectIssue(item.dataset.issueId);
      }
    );
  });
}

function renderIssuesFallback(error) {
  const root = $("issueList");

  console.error(
    "Основной renderer списка задач завершился ошибкой. Используется безопасный режим.",
    error
  );

  if (!root) return;

  if (!state.issues.length) {
    root.innerHTML =
      '<div class="empty-state">В этой сессии нет задач.</div>';
    return;
  }

  const activeIssues = state.issues.filter(
    issue => issue.status !== "estimated"
  );

  const estimatedIssues = state.issues.filter(
    issue => issue.status === "estimated"
  );

  const simpleGroup = (title, issues) => {
    if (!issues.length) return "";

    return `
      <section class="issue-list-group">
        <div class="issue-list-group-title">
          <div class="issue-list-group-heading">
            <span>${escapeHtml(title)}</span>
            <span class="issue-list-group-count">
              ${issues.length}
            </span>
          </div>
        </div>

        <div class="issue-list-group-items">
          ${issues.map(issue => `
            <div
              class="item ${
                issue.id === state.issueId
                  ? "active"
                  : ""
              }"
              data-issue-id="${escapeHtml(issue.id)}"
            >
              <div class="item-body">
                <div class="item-title">
                  ${escapeHtml(
                    issue.title || "Задача без названия"
                  )}
                </div>
                <div class="item-meta">
                  ${escapeHtml(
                    issueDisplayStatusText(issue)
                  )}
                  ${
                    issue.finalEstimate
                      ? ` · ${escapeHtml(issue.finalEstimate)} ч.д.`
                      : ""
                  }
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      </section>
    `;
  };

  root.innerHTML = `
    <div class="message warning">
      Задачи загружены, но часть дополнительных элементов интерфейса
      временно не отрисовалась. Основной список доступен.
    </div>
    ${simpleGroup("Активные", activeIssues)}
    ${simpleGroup("Оценённые", estimatedIssues)}
  `;

  root.querySelectorAll(
    "[data-issue-id]"
  ).forEach(item => {
    item.addEventListener(
      "click",
      () => selectIssue(
        item.dataset.issueId
      )
    );
  });
}

function focusCreatedIssue(issueId) {
  requestAnimationFrame(() => {
    const root = $("issueList");
    const item = Array.from(
      root.querySelectorAll("[data-issue-id]")
    ).find(
      element => element.dataset.issueId === issueId
    );

    if (!item) return;

    item.scrollIntoView({
      block: "start",
      behavior: "smooth"
    });

    item.classList.add("just-created");

    window.setTimeout(
      () => item.classList.remove("just-created"),
      1800
    );
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
  if (!canEditIssue()) return;

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
  if (!canEditIssue()) return;

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


function clearGitLabDiscoveryListener() {
  unsubscribe(gitlabDiscoveryUnsubscribe);
  gitlabDiscoveryUnsubscribe = null;
  gitlabDiscoveryJobRef = null;
}

function resetGitLabDiscoveryState() {
  gitlabDiscoveryCandidates = [];
  gitlabDiscoveryExisting = [];
  gitlabDiscoveryConflicts = [];
  gitlabDiscoveryInProgress = false;
}

function gitLabDiscoveryDirection() {
  const session = currentSession();
  const team = currentTeamSnapshot();
  return sessionDevelopmentArea(session) || team.developmentArea || null;
}

function gitLabDiscoveryDirectionLabel(value) {
  return value === "backend" ? "Backend"
    : value === "frontend" ? "Frontend"
      : "—";
}

function gitLabDiscoveryReference(item) {
  const projectPath = String(item?.projectPath || "").trim();
  const iid = Number(item?.issueIid || 0);
  return projectPath && iid ? `${projectPath}#${iid}` : "GitLab issue";
}

function formatGitLabDiscoveryAssignees(item) {
  const names = Array.isArray(item?.assignees) ? item.assignees : [];
  return names.length ? names.join(", ") : "не назначен";
}

function renderGitLabDiscoveryStaticItem(item, reason = "") {
  const url = String(item?.webUrl || "").trim();
  const title = String(item?.title || "Задача без названия");
  const ref = gitLabDiscoveryReference(item);
  const location = String(item?.existingLocation || "").trim();
  const meta = [
    ref,
    gitLabDiscoveryDirectionLabel(item?.direction),
    reason || null,
    location || null
  ].filter(Boolean).join(" · ");

  return `
    <div class="gitlab-discovery-item static">
      <div>
        <div class="gitlab-discovery-item-title">
          ${url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
            : escapeHtml(title)}
        </div>
        <div class="gitlab-discovery-item-meta">${escapeHtml(meta)}</div>
      </div>
    </div>
  `;
}

function selectedGitLabDiscoveryIndexes() {
  return Array.from(
    document.querySelectorAll(
      '#gitlabDiscoveryCandidates input[data-discovery-index]:checked'
    )
  ).map(input => Number(input.dataset.discoveryIndex))
    .filter(index => Number.isInteger(index));
}

function updateGitLabDiscoverySelectionUi() {
  const selected = selectedGitLabDiscoveryIndexes();
  const selectAll = $("gitlabDiscoverySelectAll");
  const total = gitlabDiscoveryCandidates.length;

  $("gitlabDiscoverySelectedCount").textContent = total
    ? `Выбрано ${selected.length} из ${total}`
    : "";

  $("importGitLabCandidatesBtn").disabled =
    !selected.length || gitlabDiscoveryInProgress;

  selectAll.checked = total > 0 && selected.length === total;
  selectAll.indeterminate = selected.length > 0 && selected.length < total;
}

function toggleAllGitLabDiscoveryCandidates(event) {
  const checked = event.target.checked;
  document.querySelectorAll(
    '#gitlabDiscoveryCandidates input[data-discovery-index]'
  ).forEach(input => {
    input.checked = checked;
  });
  updateGitLabDiscoverySelectionUi();
}

function renderGitLabDiscoveryResult(job = {}) {
  gitlabDiscoveryCandidates = Array.isArray(job.candidates)
    ? job.candidates
    : [];
  gitlabDiscoveryExisting = Array.isArray(job.alreadyExisting)
    ? job.alreadyExisting
    : [];
  gitlabDiscoveryConflicts = Array.isArray(job.conflicts)
    ? job.conflicts
    : [];

  const candidateRoot = $("gitlabDiscoveryCandidates");
  const existingRoot = $("gitlabDiscoveryExisting");
  const conflictRoot = $("gitlabDiscoveryConflicts");

  candidateRoot.innerHTML = gitlabDiscoveryCandidates.length
    ? gitlabDiscoveryCandidates.map((item, index) => {
        const url = String(item?.webUrl || "").trim();
        const title = String(item?.title || "Задача без названия");
        const labels = Array.isArray(item?.labels) ? item.labels : [];
        const meta = [
          gitLabDiscoveryReference(item),
          gitLabDiscoveryDirectionLabel(item?.direction),
          `Исполнитель: ${formatGitLabDiscoveryAssignees(item)}`,
          labels.length ? `labels: ${labels.join(", ")}` : null
        ].filter(Boolean).join(" · ");

        return `
          <label class="gitlab-discovery-item">
            <input
              type="checkbox"
              data-discovery-index="${index}"
              checked
            >
            <div>
              <div class="gitlab-discovery-item-title">
                ${url
                  ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escapeHtml(title)}</a>`
                  : escapeHtml(title)}
              </div>
              <div class="gitlab-discovery-item-meta">${escapeHtml(meta)}</div>
            </div>
          </label>
        `;
      }).join("")
    : '<div class="empty-state">Новых задач для оценки не найдено.</div>';

  candidateRoot.querySelectorAll(
    'input[data-discovery-index]'
  ).forEach(input => {
    input.addEventListener("change", updateGitLabDiscoverySelectionUi);
  });

  existingRoot.innerHTML = gitlabDiscoveryExisting
    .map(item => renderGitLabDiscoveryStaticItem(
      item,
      "уже есть в Team_poker"
    ))
    .join("");

  $("gitlabDiscoveryExistingSummary").textContent =
    `Не добавлены — уже есть в Team_poker (${gitlabDiscoveryExisting.length})`;
  show(
    $("gitlabDiscoveryExistingDetails"),
    gitlabDiscoveryExisting.length > 0
  );

  conflictRoot.innerHTML = gitlabDiscoveryConflicts
    .map(item => renderGitLabDiscoveryStaticItem(
      item,
      "конфликт: одновременно Backend и Frontend"
    ))
    .join("");

  $("gitlabDiscoveryConflictsSummary").textContent =
    `Не добавлены — конфликт направления (${gitlabDiscoveryConflicts.length})`;
  show(
    $("gitlabDiscoveryConflictsDetails"),
    gitlabDiscoveryConflicts.length > 0
  );

  show($("gitlabDiscoveryResults"), true);
  show($("gitlabDiscoveryProgress"), false);

  const searchedCount = Number(job.searchedCount || 0);
  const suffix = job.truncated === true
    ? " Результат ограничен лимитом коннектора."
    : "";

  setFormMessage(
    $("gitlabDiscoveryMessage"),
    `Проверено задач GitLab: ${searchedCount}. Новых: ${gitlabDiscoveryCandidates.length}.`
      + suffix,
    "success"
  );

  updateGitLabDiscoverySelectionUi();
}

function closeGitLabDiscoveryDialog() {
  closeDialog("gitlabDiscoveryDialog");
}

function openGitLabDiscoveryDialog() {
  if (!canManageEstimation() || !state.teamId || !state.sessionId) return;

  const direction = gitLabDiscoveryDirection();
  if (!isValidDevelopmentArea(direction)) {
    toast("Для текущей сессии не определено направление разработки.", "error");
    return;
  }

  $("gitlabDiscoveryContext").textContent =
    `Текущая сессия: ${currentSession()?.name || "—"} · ${gitLabDiscoveryDirectionLabel(direction)}`;
  setFormMessage($("gitlabDiscoveryMessage"));
  show($("gitlabDiscoveryResults"), false);
  show($("gitlabDiscoveryProgress"), false);
  $("importGitLabCandidatesBtn").disabled = true;
  $("gitlabDiscoverySelectAll").checked = false;
  $("gitlabDiscoverySelectAll").indeterminate = false;
  openDialog("gitlabDiscoveryDialog");

  requestGitLabDiscovery();
}

async function requestGitLabDiscovery() {
  if (
    gitlabDiscoveryInProgress
    || !canManageEstimation()
    || !state.teamId
    || !state.sessionId
  ) return;

  const direction = gitLabDiscoveryDirection();
  if (!isValidDevelopmentArea(direction)) {
    return setFormMessage(
      $("gitlabDiscoveryMessage"),
      "Для текущей сессии не определено направление разработки."
    );
  }

  clearGitLabDiscoveryListener();
  resetGitLabDiscoveryState();
  gitlabDiscoveryInProgress = true;
  renderTeamControls();

  show($("gitlabDiscoveryResults"), false);
  show($("gitlabDiscoveryProgress"), true);
  $("gitlabDiscoveryProgress").textContent =
    "Запрос поставлен в очередь. Ожидается Mac-коннектор…";
  setFormMessage($("gitlabDiscoveryMessage"));
  $("requestGitLabDiscoveryBtn").disabled = true;
  $("importGitLabCandidatesBtn").disabled = true;

  try {
    const actor = currentActorSnapshot();
    const jobRef = doc(
      collection(db, "teams", state.teamId, "gitlab_discovery_jobs")
    );

    await setDoc(jobRef, {
      schemaVersion: 1,
      type: "discover_estimation_candidates",
      status: "pending",
      teamId: state.teamId,
      sessionId: state.sessionId,
      targetDirection: direction,
      requestedByUid: actor.uid,
      requestedByEmail: actor.email,
      requestedByDisplayName: actor.displayName,
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      attempts: 0
    });

    gitlabDiscoveryJobRef = jobRef;
    const requestTeamId = state.teamId;
    const requestSessionId = state.sessionId;

    gitlabDiscoveryUnsubscribe = onSnapshot(
      jobRef,
      { includeMetadataChanges: true },
      snapshot => {
        if (
          requestTeamId !== state.teamId
          || requestSessionId !== state.sessionId
          || !snapshot.exists()
        ) return;

        const job = snapshot.data() || {};

        if (job.status === "pending") {
          $("gitlabDiscoveryProgress").textContent =
            "Ожидается Mac-коннектор…";
          return;
        }

        if (job.status === "processing") {
          $("gitlabDiscoveryProgress").textContent =
            "Mac-коннектор запрашивает GitLab и сравнивает задачи с Team_poker…";
          return;
        }

        gitlabDiscoveryInProgress = false;
        $("requestGitLabDiscoveryBtn").disabled = false;
        renderTeamControls();

        if (job.status === "succeeded") {
          renderGitLabDiscoveryResult(job);
          return;
        }

        if (job.status === "failed") {
          show($("gitlabDiscoveryProgress"), false);
          setFormMessage(
            $("gitlabDiscoveryMessage"),
            `Ошибка поиска в GitLab: ${job.lastError || "неизвестная ошибка"}`
          );
        }
      },
      error => {
        gitlabDiscoveryInProgress = false;
        $("requestGitLabDiscoveryBtn").disabled = false;
        renderTeamControls();
        show($("gitlabDiscoveryProgress"), false);
        handleError(error, $("gitlabDiscoveryMessage"));
      }
    );
  } catch (error) {
    gitlabDiscoveryInProgress = false;
    $("requestGitLabDiscoveryBtn").disabled = false;
    renderTeamControls();
    show($("gitlabDiscoveryProgress"), false);
    handleError(error, $("gitlabDiscoveryMessage"));
  }
}

async function importSelectedGitLabCandidates() {
  if (!canManageEstimation() || !state.teamId || !state.sessionId) return;

  const indexes = selectedGitLabDiscoveryIndexes();
  const selected = indexes
    .map(index => gitlabDiscoveryCandidates[index])
    .filter(Boolean);

  if (!selected.length) return;

  const direction = gitLabDiscoveryDirection();
  if (!isValidDevelopmentArea(direction)) return;

  const invalidDirection = selected.find(
    item => item.direction !== direction
  );
  if (invalidDirection) {
    return setFormMessage(
      $("gitlabDiscoveryMessage"),
      "В результатах есть задача другого направления. Обновите поиск."
    );
  }

  await withButton(
    $("importGitLabCandidatesBtn"),
    "Добавление...",
    async () => {
      try {
        const actor = currentActorSnapshot();
        const teamSnapshot = currentTeamSnapshot();
        const session = currentSession();
        const existingUrls = new Set(
          state.issues
            .map(issue => normalizeGitlabIssueUrl(issue.gitlabUrl))
            .filter(Boolean)
        );
        const fresh = selected.filter(item => {
          const normalized = normalizeGitlabIssueUrl(item.webUrl);
          return normalized && !existingUrls.has(normalized);
        });

        if (!fresh.length) {
          setFormMessage(
            $("gitlabDiscoveryMessage"),
            "Выбранные задачи уже появились в текущей сессии. Обновите поиск."
          );
          return;
        }

        if (fresh.length > 150) {
          setFormMessage(
            $("gitlabDiscoveryMessage"),
            "За один раз можно добавить не более 150 задач."
          );
          return;
        }

        const minOrder = state.issues.length
          ? state.issues.reduce(
              (minimum, issue) => Math.min(
                minimum,
                Number(issue.sortOrder || 0)
              ),
              Number.POSITIVE_INFINITY
            )
          : 0;

        const batch = writeBatch(db);
        let firstIssueId = null;

        fresh.forEach((item, index) => {
          const issueRef = doc(
            collection(
              db,
              "teams", state.teamId,
              "sessions", state.sessionId,
              "issues"
            )
          );
          const auditRef = createIssueAuditRef();
          if (!firstIssueId) firstIssueId = issueRef.id;

          const title = String(item.title || "Задача без названия").slice(0, 300);
          const gitlabUrl = String(item.webUrl || "").trim();
          const description = String(item.description || "").trim().slice(0, 4000);

          batch.set(issueRef, {
            title,
            gitlabUrl,
            description: description || null,
            currentRound: 1,
            status: "pending",
            finalEstimate: null,
            estimatedRole: direction,
            estimatedTeamId: teamSnapshot.id,
            estimatedTeamName: teamSnapshot.name,
            estimateVersion: 0,
            developmentAreaCapturedAt: serverTimestamp(),
            sortOrder: minOrder - (fresh.length - index) * 10,
            gitlabIssueId: Number(item.issueId || 0) || null,
            gitlabProjectId: Number(item.projectId || 0) || null,
            gitlabProjectPath: String(item.projectPath || "") || null,
            gitlabIssueIid: Number(item.issueIid || 0) || null,
            gitlabImportedAt: serverTimestamp(),
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
                gitlabUrl,
                description: description || null,
                source: "gitlab_discovery"
              }
            })
          );
        });

        if (!isValidDevelopmentArea(session?.developmentArea)) {
          batch.update(
            doc(db, "teams", state.teamId, "sessions", state.sessionId),
            {
              developmentArea: direction,
              estimatedTeamId: teamSnapshot.id,
              estimatedTeamName: teamSnapshot.name,
              developmentAreaCapturedAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            }
          );
        }

        pendingCreatedIssueId = firstIssueId;
        await batch.commit();

        closeGitLabDiscoveryDialog();
        toast(
          `Добавлено задач из GitLab: ${fresh.length}.`,
          "success",
          3500
        );
      } catch (error) {
        handleError(error, $("gitlabDiscoveryMessage"));
      }
    }
  );
}

async function createIssue() {
  if (!canCreateIssue()) return;

  const title = $("newIssueTitle").value.trim();
  const gitlabUrl = $("newIssueUrl").value.trim();
  const description = $("newIssueDescription").value.trim();
  const target = $("issueDialogMessage");
  const session = currentSession();
  const teamSnapshot = currentTeamSnapshot();
  const estimatedRole = sessionDevelopmentArea(session)
    || teamSnapshot.developmentArea;

  setFormMessage(target);
  if (!title) return setFormMessage(target, "Укажите название задачи.");
  if (!isValidExternalUrl(gitlabUrl)) {
    return setFormMessage(target, "Ссылка должна начинаться с http:// или https://.");
  }

  if (!isValidDevelopmentArea(estimatedRole)) {
    return setFormMessage(
      target,
      "Для команды не задано направление разработки. Укажите Backend или Frontend в настройках команды."
    );
  }

  const minOrder = state.issues.length
    ? state.issues.reduce(
        (minimum, issue) =>
          Math.min(
            minimum,
            Number(issue.sortOrder || 0)
          ),
        Number.POSITIVE_INFINITY
      )
    : 0;

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
        estimatedRole,
        estimatedTeamId: teamSnapshot.id,
        estimatedTeamName: teamSnapshot.name,
        estimateVersion: 0,
        developmentAreaCapturedAt: serverTimestamp(),
        sortOrder: minOrder - 10,
        createdByUid: actor.uid,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      if (!isValidDevelopmentArea(session?.developmentArea)) {
        batch.update(
          doc(db, "teams", state.teamId, "sessions", state.sessionId),
          {
            developmentArea: estimatedRole,
            estimatedTeamId: teamSnapshot.id,
            estimatedTeamName: teamSnapshot.name,
            developmentAreaCapturedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }
        );
      }

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

      pendingCreatedIssueId = issueRef.id;
      await batch.commit();

      $("newIssueTitle").value = "";
      $("newIssueUrl").value = "";
      $("newIssueDescription").value = "";
      closeDialog("issueDialog");
      toast("Задача добавлена.", "success");
    } catch (error) {
      pendingCreatedIssueId = null;
      handleError(error, target);
    }
  });
}

function voteDocId(round, uid) {
  return `${round}_${uid}`;
}

function voteSubscriptionKey(issue = state.issue) {
  if (!issue) return null;

  return [
    issue.id,
    Number(issue.currentRound || 0),
    String(issue.status || ""),
    issue._hasPendingWrites === true
      ? "local"
      : "server"
  ].join(":");
}

function isActiveVoteSubscription(key) {
  return Boolean(
    key
    && activeVoteSubscriptionKey === key
    && state.issue
    && voteSubscriptionKey(state.issue) === key
  );
}

function handleVoteSubscriptionError(
  error,
  subscriptionKey,
  source
) {
  if (!isActiveVoteSubscription(subscriptionKey)) {
    console.debug(
      `Игнорируется ошибка устаревшей подписки ${source}`,
      error
    );
    return;
  }

  handleError(error);
}

function startVoteListeners() {
  clearVoteListeners();

  if (!state.issue) return;

  const subscriptionKey =
    voteSubscriptionKey(state.issue);

  activeVoteSubscriptionKey = subscriptionKey;

  /*
    После локальной записи Firestore немедленно присылает optimistic
    snapshot с hasPendingWrites=true. Но security rules на сервере ещё
    могут видеть предыдущее status/currentRound. Если в этот момент
    подписаться на раскрытые/исторические голоса, сервер может законно
    ответить permission-denied и listener больше не восстановится.

    Ждём server-ack. QuerySnapshot issues после подтверждения даст новый
    document snapshot с hasPendingWrites=false; subscription key сменится
    с :local на :server и подписки будут запущены автоматически.
  */
  if (state.issue._hasPendingWrites === true) {
    renderIssue();
    return;
  }

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
      if (!isActiveVoteSubscription(subscriptionKey)) return;

      const voteDoc = snapshot.docs.find(
        item => Number(item.data().round) === round
      );

      state.myVote = voteDoc
        ? { id: voteDoc.id, ...voteDoc.data() }
        : null;

      renderIssue();
    },
    error => handleVoteSubscriptionError(
      error,
      subscriptionKey,
      "own-vote"
    )
  );

  const statusQuery = query(
    collection(db, ...issueBase, "vote_status"),
    where("round", "==", round)
  );

  unsubscribeVoteStatuses = onSnapshot(
    statusQuery,
    snapshot => {
      if (!isActiveVoteSubscription(subscriptionKey)) return;

      state.voteStatuses = snapshot.docs.map(statusDoc => ({
        id: statusDoc.id,
        ...statusDoc.data()
      }));
      renderIssue();
    },
    error => handleVoteSubscriptionError(
      error,
      subscriptionKey,
      "vote-status"
    )
  );

  unsubscribeRounds = onSnapshot(
    collection(db, ...issueBase, "rounds"),
    { includeMetadataChanges: true },
    snapshot => {
      if (!isActiveVoteSubscription(subscriptionKey)) return;

      state.rounds = snapshot.docs
        .map(roundDoc => ({ id: roundDoc.id, ...roundDoc.data() }))
        .sort((a, b) => Number(b.round) - Number(a.round));
      renderRoundHistory();
    },
    error => handleVoteSubscriptionError(
      error,
      subscriptionKey,
      "rounds"
    )
  );

  loadLegacyHistoricalVotes(subscriptionKey).catch(
    error => handleVoteSubscriptionError(
      error,
      subscriptionKey,
      "historical-votes"
    )
  );

  if (["revealed", "estimated"].includes(state.issue.status)) {
    const votesQuery = query(
      collection(db, ...issueBase, "votes"),
      where("round", "==", round)
    );

    unsubscribeVotes = onSnapshot(
      votesQuery,
      snapshot => {
        if (!isActiveVoteSubscription(subscriptionKey)) return;

        state.votes = snapshot.docs
          .map(voteDoc => ({ id: voteDoc.id, ...voteDoc.data() }))
          .sort((a, b) => timestampValue(a.updatedAt) - timestampValue(b.updatedAt));
        renderIssue();
      },
      error => handleVoteSubscriptionError(
        error,
        subscriptionKey,
        "revealed-votes"
      )
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

async function loadLegacyHistoricalVotes(subscriptionKey = activeVoteSubscriptionKey) {
  state.historicalVotes = [];

  const issue = state.issue;
  if (!issue || !isActiveVoteSubscription(subscriptionKey)) {
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
      !isActiveVoteSubscription(subscriptionKey) ||
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

async function buildRoundSnapshot(
  round,
  status,
  finalEstimate = null,
  finalization = {}
) {
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
    estimatedRole:
      finalization.estimatedRole
      ?? existing.estimatedRole
      ?? state.issue?.estimatedRole
      ?? null,
    estimatedTeamId:
      finalization.estimatedTeamId
      ?? existing.estimatedTeamId
      ?? state.issue?.estimatedTeamId
      ?? state.teamId
      ?? null,
    estimatedTeamName:
      finalization.estimatedTeamName
      ?? existing.estimatedTeamName
      ?? state.issue?.estimatedTeamName
      ?? currentTeam()?.name
      ?? null,
    estimateVersion:
      finalization.estimateVersion
      ?? existing.estimateVersion
      ?? state.issue?.estimateVersion
      ?? null,
    revealedAt: existing.revealedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  if (status === "finalized") {
    payload.finalizedAt = serverTimestamp();
    payload.finalizedByUid =
      finalization.finalizedByUid ?? null;
    payload.finalizedByEmail =
      finalization.finalizedByEmail ?? null;
    payload.finalizedByDisplayName =
      finalization.finalizedByDisplayName ?? null;
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

    if (state.issue.estimatedRole) {
      existing.estimatedRole = state.issue.estimatedRole;
    }

    if (state.issue.estimateVersion != null) {
      existing.estimateVersion = state.issue.estimateVersion;
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
    const estimatedRole = isValidDevelopmentArea(item.estimatedRole)
      ? item.estimatedRole
      : null;
    const estimateVersion = Number(item.estimateVersion || 0) || null;

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
            ${
              finalEstimate == null
                ? "Итог не зафиксирован"
                : `${developmentAreaLabel(estimatedRole)} · ${finalEstimate} ч.д.${estimateVersion ? ` · v${estimateVersion}` : ""}`
            }
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

          ${
            finalEstimate != null && !estimatedRole
              ? '<div class="muted small">Направление не определено.</div>'
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

  const estimateDirection = isValidDevelopmentArea(issue.estimatedRole)
    ? issue.estimatedRole
    : finalizationEstimatedRole(issue);

  $("issueStatus").innerHTML = `
    <span class="status-pill ${statusClass}">
      ${escapeHtml(issueDisplayStatusText(issue))}
    </span>
    <span class="area-badge compact ${developmentAreaClass(estimateDirection)}">
      ${escapeHtml(developmentAreaLabel(estimateDirection))}
    </span>
    ${calculatorDeliveryBadgeHtml(issue)}
    ${calculatorGitLabBadgeHtml(issue)}
  `;

  $("issueTitle").textContent = issue.title;

  const transferInfo = issueTransferInfo(issue);
  const transferNotice = $("issueTransferNotice");

  if (transferNotice && transferInfo) {
    const movedBy =
      transferInfo.movedBy.displayName
      || transferInfo.movedBy.email
      || "";

    const previousEstimate =
      issue.previousEstimate?.finalEstimate != null
        ? `${Number(
            issue.previousEstimate.finalEstimate
          )} ч.д.`
        : "";

    transferNotice.innerHTML = `
      <strong>↪ Перенесена из сессии «${escapeHtml(
        transferInfo.fromSessionName || "Без названия"
      )}»</strong>
      ${
        issue.reestimateRequired === true
          ? `<span class="reestimate-notice-line">
              ↻ Требуется переоценка${
                previousEstimate
                  ? ` · прежняя оценка: ${escapeHtml(previousEstimate)}`
                  : ""
              }
            </span>`
          : ""
      }
      ${
        transferInfo.movedAtLabel || movedBy
          ? `<span>${escapeHtml(
              [
                transferInfo.movedAtLabel,
                movedBy ? `перенёс: ${movedBy}` : ""
              ].filter(Boolean).join(" · ")
            )}</span>`
          : ""
      }
    `;
    show(transferNotice);
  } else if (transferNotice) {
    transferNotice.innerHTML = "";
    show(transferNotice, false);
  }

  $("issueDescription").textContent = issue.description || "";
  renderIssueAuthorMeta();

  show($("gitlabLink"), Boolean(issue.gitlabUrl));
  if (issue.gitlabUrl) $("gitlabLink").href = issue.gitlabUrl;

  const eligibleMembers = votingMembers();
  const eligibleEmails = new Set(
    eligibleMembers.map(member => normalizeEmail(member.email))
  );
  const eligibleVoteCount = state.voteStatuses.filter(status =>
    eligibleEmails.has(normalizeEmail(status.voterEmail))
  ).length;

  $("roundValue").textContent = issue.currentRound;
  $("votesCount").textContent = eligibleVoteCount;
  $("membersCount").textContent = eligibleMembers.length;

  const userRole = currentRole();
  const userCanVote = canVote();
  const canVoteNow = issue.status === "voting" && userCanVote;

  const nonVotingNotice = userRole === "admin"
    ? "Вы участвуете как администратор: можете управлять оценкой, но не голосуете."
    : userRole === "initiator"
      ? "Вы участвуете как инициатор: можете работать со своими задачами, но не голосуете."
      : "У вашей роли нет права голосования.";

  $("voteNotice").textContent = ({
    pending: canManageEstimation()
      ? "Голосование ещё не открыто."
      : "Голосование ещё не открыто тимлидом или администратором.",
    voting: userCanVote
      ? "Выберите оценку. До раскрытия другие участники увидят только факт голосования."
      : nonVotingNotice,
    revealed: "Оценки раскрыты. Можно просмотреть результаты.",
    estimated: `Итоговая оценка: ${issue.finalEstimate} человеко-дней.`
  })[issue.status];

  $("pokerCards").querySelectorAll("[data-vote-value]").forEach(button => {
    const value = Number(button.dataset.voteValue);
    button.disabled = !canVoteNow;
    button.classList.toggle(
      "active",
      Number(state.myVote?.value) === value
    );
  });

  $("myVoteMessage").textContent = state.myVote
    ? `Ваш ранее сохранённый голос: ${state.myVote.value} ч.д.`
    : canVoteNow
      ? "Вы ещё не проголосовали."
      : issue.status === "voting" && !userCanVote
        ? "Ваша роль не учитывается среди голосующих."
        : "";

  renderLeadIssueActions();
  renderResults();
  renderRoundHistory();
  syncCurrentTaskLink();

  const estimatedRole = finalizationEstimatedRole(issue);
  const canFinalizeStatus = ["revealed", "estimated"].includes(issue.status);

  $("finalEstimate").value =
    issue.finalEstimate || suggestedEstimate() || "";

  $("finalEstimate").disabled = !canManageEstimation();

  $("finalizeBtn").disabled =
    !canManageEstimation() ||
    !canFinalizeStatus ||
    !isValidDevelopmentArea(estimatedRole);

  $("copyEstimateBtn").disabled = !$("finalEstimate").value;

  $("copyTeamCalendarBtn").disabled =
    issue.finalEstimate == null ||
    !isValidDevelopmentArea(issue.estimatedRole) ||
    !issue.estimateVersion;

  if (!isValidDevelopmentArea(estimatedRole) && canFinalizeStatus) {
    setFormMessage(
      $("finalMessage"),
      isAdmin()
        ? "Для задачи не задано направление оценки. Нажмите «Указать направление»."
        : "Для задачи не задано направление оценки. Обратитесь к администратору команды.",
      "error"
    );
  } else if (issue.finalEstimate != null) {
    setFormMessage(
      $("finalMessage"),
      `Зафиксировано: ${developmentAreaLabel(issue.estimatedRole)} · ${issue.finalEstimate} ч.д. · версия ${issue.estimateVersion || 1}`,
      "success"
    );
  } else {
    setFormMessage($("finalMessage"));
  }
}

function renderLeadIssueActions() {
  const root = $("leadIssueActions");
  const issue = state.issue;

  if (!issue) {
    root.innerHTML = "";
    return;
  }

  const manager = canManageEstimation();
  const editable = canEditIssue(issue);
  const deletable = canDeleteIssue(issue);
  const buttons = [];

  if (editable) {
    buttons.push(
      '<button class="button secondary" type="button" data-issue-action="edit">Редактировать</button>'
    );
  }

  if (isAdmin() && !isValidDevelopmentArea(issue.estimatedRole)) {
    buttons.push(
      '<button class="button direction-button" type="button" data-issue-action="assign-role">Указать направление</button>'
    );
  }

  if (manager) {
    if (issue.status === "voting") {
      buttons.push(
        '<button class="button secondary" type="button" disabled title="Сначала раскройте оценки или завершите раунд">Перенести</button>'
      );
    } else {
      buttons.push(
        '<button class="button secondary" type="button" data-issue-action="move">Перенести</button>'
      );
    }

    if (issue.status === "pending") {
      buttons.push(
        '<button class="button primary" type="button" data-issue-action="start">Начать голосование</button>'
      );
    }

    if (issue.status === "voting") {
      buttons.push(
        '<button class="button primary" type="button" data-issue-action="reveal">Раскрыть оценки</button>'
      );
    }

    if (issue.status === "revealed") {
      buttons.push(
        '<button class="button secondary" type="button" data-issue-action="new-round">Новый раунд</button>'
      );
    }

    if (issue.status === "estimated") {
      buttons.push(
        '<button class="button secondary" type="button" data-issue-action="new-round">Переоценить</button>'
      );
    }
  }

  if (deletable) {
    buttons.push(
      '<button class="button danger" type="button" data-issue-action="delete">Удалить задачу</button>'
    );
  }

  root.innerHTML = buttons.join("");

  root.querySelectorAll("[data-issue-action]").forEach(button => {
    button.addEventListener(
      "click",
      () => issueAction(button.dataset.issueAction)
    );
  });
}

function openAssignEstimatedRoleDialog() {
  const issue = state.issue;

  if (
    !isAdmin() ||
    !issue ||
    isValidDevelopmentArea(issue.estimatedRole)
  ) {
    return;
  }

  const suggestedRole =
    sessionDevelopmentArea()
    || (
      isValidDevelopmentArea(currentTeam()?.developmentArea)
        ? currentTeam().developmentArea
        : ""
    );

  $("assignEstimatedRoleIssueTitle").textContent =
    issue.title || "Задача без названия";

  $("assignEstimatedRoleCurrentEstimate").textContent =
    issue.finalEstimate != null
      ? `${Number(issue.finalEstimate)} ч.д.`
      : "Итоговая оценка ещё не зафиксирована";

  $("assignEstimatedRoleSelect").value = suggestedRole || "";

  setFormMessage(
    $("assignEstimatedRoleMessage"),
    issue.finalEstimate != null
      ? "Будет добавлено только направление. Итоговая оценка, версия и дата фиксации не изменятся."
      : "Направление сохранится в задаче и будет использовано при будущей фиксации оценки.",
    "info"
  );

  openDialog("assignEstimatedRoleDialog");
}

async function assignEstimatedRole() {
  const issue = state.issue;
  const target = $("assignEstimatedRoleMessage");
  const estimatedRole = $("assignEstimatedRoleSelect").value;

  if (!isAdmin() || !issue) return;

  if (isValidDevelopmentArea(issue.estimatedRole)) {
    closeDialog("assignEstimatedRoleDialog");
    toast("Для задачи направление уже задано.", "success", 2500);
    return;
  }

  if (!isValidDevelopmentArea(estimatedRole)) {
    return setFormMessage(
      target,
      "Выберите Backend или Frontend."
    );
  }

  const requestedTeamId = state.teamId;
  const requestedSessionId = state.sessionId;
  const requestedIssueId = issue.id;
  const requestedIssueTitle = issue.title || "Задача без названия";
  const teamSnapshot = currentTeamSnapshot();
  const actor = currentActorSnapshot();

  await withButton(
    $("saveEstimatedRoleBtn"),
    "Сохранение...",
    async () => {
      try {
        setFormMessage(
          target,
          "Проверяем задачу и историю оценок.",
          "info"
        );

        const issueRef = doc(
          db,
          "teams", requestedTeamId,
          "sessions", requestedSessionId,
          "issues", requestedIssueId
        );

        const roundsRef = collection(issueRef, "rounds");

        const [issueSnapshot, roundsSnapshot] = await Promise.all([
          getDoc(issueRef),
          getDocs(roundsRef)
        ]);

        if (!issueSnapshot.exists()) {
          throw new Error("Задача больше не существует.");
        }

        const storedIssue = issueSnapshot.data();

        if (isValidDevelopmentArea(storedIssue.estimatedRole)) {
          throw new Error(
            `Для задачи уже задано направление: ${developmentAreaLabel(storedIssue.estimatedRole)}.`
          );
        }

        const roleFields = {
          estimatedRole,
          estimatedTeamId:
            storedIssue.estimatedTeamId || teamSnapshot.id,
          estimatedTeamName:
            storedIssue.estimatedTeamName || teamSnapshot.name,
          estimatedRoleAssignedByUid: actor.uid,
          estimatedRoleAssignedByEmail: actor.email,
          estimatedRoleAssignedByDisplayName: actor.displayName,
          estimatedRoleAssignedAt: serverTimestamp()
        };

        const roundsToUpdate = roundsSnapshot.docs.filter(roundDoc => {
          const round = roundDoc.data();
          return !isValidDevelopmentArea(round.estimatedRole);
        });

        /*
          Обычно раундов единицы. Ограничение оставляет запас до лимита
          Firestore batch и не допускает частичного изменения задачи.
        */
        if (roundsToUpdate.length > 450) {
          throw new Error(
            "В задаче слишком много раундов для одной безопасной операции."
          );
        }

        const batch = writeBatch(db);

        batch.update(issueRef, {
          ...roleFields,
          updatedAt: serverTimestamp()
        });

        roundsToUpdate.forEach(roundDoc => {
          batch.update(roundDoc.ref, roleFields);
        });

        /*
          В старых задачах отдельного документа текущего раунда могло не быть.
          Создаём его только для уже зафиксированной оценки и переносим
          существующие значения без изменения версии и даты фиксации.
        */
        const currentRound = Number(storedIssue.currentRound || 1);
        const hasCurrentRoundDocument = roundsSnapshot.docs.some(
          roundDoc =>
            roundDoc.id === String(currentRound)
            || Number(roundDoc.data().round) === currentRound
        );

        if (
          storedIssue.finalEstimate != null &&
          !hasCurrentRoundDocument
        ) {
          const legacyRoundPayload = {
            round: currentRound,
            status: "finalized",
            finalEstimate: Number(storedIssue.finalEstimate),
            estimatedRole,
            estimatedTeamId: roleFields.estimatedTeamId,
            estimatedTeamName: roleFields.estimatedTeamName,
            estimatedRoleAssignedByUid: actor.uid,
            estimatedRoleAssignedByEmail: actor.email,
            estimatedRoleAssignedByDisplayName: actor.displayName,
            estimatedRoleAssignedAt: serverTimestamp()
          };

          if (storedIssue.estimateVersion != null) {
            legacyRoundPayload.estimateVersion =
              Number(storedIssue.estimateVersion);
          }

          if (storedIssue.finalizedAt != null) {
            legacyRoundPayload.finalizedAt =
              storedIssue.finalizedAt;
          }

          batch.set(
            doc(roundsRef, String(currentRound)),
            legacyRoundPayload,
            { merge: true }
          );
        }

        batch.set(
          createIssueAuditRef(
            requestedTeamId,
            requestedSessionId
          ),
          buildIssueAuditEvent({
            action: "estimated_role_assigned",
            issueId: requestedIssueId,
            issueTitle: requestedIssueTitle,
            changedFields: ["направление оценки"],
            before: {
              estimatedRole: null
            },
            after: {
              estimatedRole,
              estimatedRoleLabel:
                developmentAreaLabel(estimatedRole),
              finalEstimate:
                storedIssue.finalEstimate ?? null,
              estimateVersion:
                storedIssue.estimateVersion ?? null,
              updatedRounds:
                roundsToUpdate.length
                + (
                  storedIssue.finalEstimate != null
                  && !hasCurrentRoundDocument
                    ? 1
                    : 0
                )
            }
          })
        );

        await batch.commit();

        closeDialog("assignEstimatedRoleDialog");

        toast(
          `Направление указано: ${developmentAreaLabel(estimatedRole)}. Оценка и история сохранены.`,
          "success",
          5000
        );
      } catch (error) {
        handleError(error, target);
      }
    }
  );
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
  if (!state.issue) return;

  if (action === "edit") {
    if (!canEditIssue()) return;
    openEditIssueDialog();
    return;
  }

  if (action === "move") {
    if (!canManageEstimation()) return;
    openMoveIssueDialog();
    return;
  }

  if (action === "assign-role") {
    if (!isAdmin()) return;
    openAssignEstimatedRoleDialog();
    return;
  }

  if (action === "delete") {
    if (!canDeleteIssue()) return;
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

  if (!canManageEstimation()) return;

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
        finalizedAt: null,
        finalizedByUid: null,
        finalizedByEmail: null,
        finalizedByDisplayName: null,
        updatedAt: serverTimestamp()
      });

      await batch.commit();
    }
  } catch (error) {
    handleError(error);
  }
}

function latestIssueEstimateInfo(
  issue,
  sourceSessionId = state.sessionId,
  sourceSessionName = currentSession()?.name || ""
) {
  if (!issue) return null;

  const currentEstimate = Number(issue.finalEstimate);

  if (
    Number.isFinite(currentEstimate)
    && currentEstimate > 0
    && isValidDevelopmentArea(issue.estimatedRole)
  ) {
    return {
      finalEstimate: currentEstimate,
      estimatedRole: issue.estimatedRole,
      estimateVersion: Math.max(
        1,
        Number(issue.estimateVersion) || 1
      ),
      finalizedAt: issue.finalizedAt || null,
      finalizedByUid: issue.finalizedByUid || null,
      finalizedByEmail: issue.finalizedByEmail || null,
      finalizedByDisplayName:
        issue.finalizedByDisplayName || null,
      sourceSessionId: sourceSessionId || null,
      sourceSessionName: sourceSessionName || ""
    };
  }

  const previous =
    issue.previousEstimate
    && typeof issue.previousEstimate === "object"
      ? issue.previousEstimate
      : null;

  const previousValue = Number(
    previous?.finalEstimate
  );

  if (
    Number.isFinite(previousValue)
    && previousValue > 0
    && isValidDevelopmentArea(
      previous?.estimatedRole
      || issue.estimatedRole
    )
  ) {
    return {
      finalEstimate: previousValue,
      estimatedRole:
        previous.estimatedRole || issue.estimatedRole,
      estimateVersion: Math.max(
        1,
        Number(
          previous.estimateVersion
          || issue.estimateVersion
        ) || 1
      ),
      finalizedAt: previous.finalizedAt || null,
      finalizedByUid:
        previous.finalizedByUid || null,
      finalizedByEmail:
        previous.finalizedByEmail || null,
      finalizedByDisplayName:
        previous.finalizedByDisplayName || null,
      sourceSessionId:
        previous.sourceSessionId
        || sourceSessionId
        || null,
      sourceSessionName:
        previous.sourceSessionName
        || sourceSessionName
        || ""
    };
  }

  return null;
}

function bulkMoveMode() {
  return document.querySelector('input[name="bulkMoveMode"]:checked')?.value || "reestimate";
}

function bulkMoveIssueAvailability(issue, mode = bulkMoveMode()) {
  if (!issue) return {available:false,reason:"Задача не найдена"};
  if (issue.moveState === "copying" || issue.status === "voting") return {available:false,reason:issue.status === "voting" ? "Идёт голосование" : "Перенос уже выполняется"};
  if (mode === "reuse" && !latestIssueEstimateInfo(issue)) return {available:false,reason:"Нет зафиксированной оценки"};
  return {available:true,reason:""};
}

function bulkMoveDialogSelection() {
  const mode = bulkMoveMode();
  const selected = selectedTransferableIssues();
  const eligible = selected.filter(issue => bulkMoveIssueAvailability(issue,mode).available);
  const excluded = selected.filter(issue => !bulkMoveIssueAvailability(issue,mode).available);
  return {selected,eligible,excluded};
}

function renderBulkMoveDialogState() {
  const summary=$("bulkMoveSelectedSummary"), hint=$("bulkMoveEligibilityHint"), confirmButton=$("confirmBulkMoveIssueBtn");
  if (!summary || !hint || !confirmButton) return;
  const {selected,eligible,excluded}=bulkMoveDialogSelection();
  const mode=bulkMoveMode();
  summary.textContent=`Выбрано задач: ${selected.length}.`;
  if (mode === "reestimate") {
    hint.className="message info";
    hint.textContent=eligible.length?`Все ${eligible.length} задач будут перенесены на переоценку.`:"Нет задач, доступных для переноса.";
  } else if (excluded.length) {
    hint.className="message warning";
    hint.textContent=`${excluded.length} из ${selected.length} задач не имеют зафиксированной оценки и будут исключены. Будет перенесено: ${eligible.length}.`;
  } else {
    hint.className="message info";
    hint.textContent=`Все ${eligible.length} задач будут перенесены с последней оценкой.`;
  }
  const hasTarget=Boolean($("bulkMoveTargetSession")?.value);
  confirmButton.disabled=bulkMoveInProgress || eligible.length===0 || !hasTarget;
  confirmButton.textContent=bulkMoveInProgress?"Перенос…":eligible.length?`Перенести ${eligible.length} задач`:"Перенести";
}

function handleBulkMoveModeChange() {
  setFormMessage($("bulkMoveIssueMessage"));
  renderBulkMoveDialogState();
}

function openBulkMoveIssueDialog() {
  if (!canManageEstimation() || !state.sessionId) return;
  pruneVotingIssueSelection();
  const selected=selectedTransferableIssues();
  if (!selected.length) { toast("Сначала выберите задачи в списке.","error",3500); return; }
  const targetSessions=state.sessions.filter(session=>session.id!==state.sessionId);
  bulkMoveInProgress=false;
  const reestimateRadio=document.querySelector('input[name="bulkMoveMode"][value="reestimate"]');
  if (reestimateRadio) reestimateRadio.checked=true;
  $("bulkMoveTargetSession").innerHTML=targetSessions.length?targetSessions.map(session=>`<option value="${escapeHtml(session.id)}">${escapeHtml(session.name)}${session.iteration?` — ${escapeHtml(session.iteration)}`:""}${session.status==="finished"?" (завершена)":""}</option>`).join(""):'<option value="">Нет другой сессии в этой команде</option>';
  $("bulkMoveTargetSession").disabled=targetSessions.length===0;
  $("bulkMoveTargetSession").onchange=renderBulkMoveDialogState;
  setFormMessage($("bulkMoveIssueMessage"),targetSessions.length?"":"Сначала создайте ещё одну сессию в этой команде.",targetSessions.length?"info":"error");
  renderBulkMoveDialogState();
  openDialog("bulkMoveIssueDialog");
}

function openMoveIssueDialog() {
  if (!canManageEstimation() || !state.issue) return;

  const targetSessions = state.sessions.filter(
    session => session.id !== state.sessionId
  );

  $("moveIssueTitle").textContent = state.issue.title || "";
  $("moveIssueSourceSession").textContent =
    currentSession()?.name || state.sessionId || "";

  $("moveIssueTargetSession").innerHTML = targetSessions.length
    ? targetSessions.map(session => `
        <option value="${escapeHtml(session.id)}">
          ${escapeHtml(session.name)}
          ${session.iteration ? ` — ${escapeHtml(session.iteration)}` : ""}
          ${session.status === "finished" ? " (завершена)" : ""}
        </option>
      `).join("")
    : '<option value="">Нет другой сессии в этой команде</option>';

  $("moveIssueTargetSession").disabled = targetSessions.length === 0;
  $("confirmMoveIssueBtn").disabled = targetSessions.length === 0;

  setFormMessage(
    $("moveIssueMessage"),
    targetSessions.length
      ? "Будут перенесены задача, все голоса, статусы голосования, история раундов и итоговая оценка. Исходная задача удалится только после проверки копии."
      : "Сначала создайте ещё одну сессию в этой команде.",
    targetSessions.length ? "info" : "error"
  );

  openDialog("moveIssueDialog");
}

async function readCollectionDocuments(collectionRef) {
  const snapshot = await getDocs(collectionRef);

  return snapshot.docs.map(item => ({
    id: item.id,
    data: item.data()
  }));
}

async function writeDocumentsInChunks(collectionRef, documents) {
  const chunkSize = 350;

  for (let start = 0; start < documents.length; start += chunkSize) {
    const batch = writeBatch(db);

    documents.slice(start, start + chunkSize).forEach(item => {
      batch.set(
        doc(collectionRef, item.id),
        item.data
      );
    });

    await batch.commit();
  }
}

async function removeIncompleteMovedCopy(sessionId, issueId) {
  const issueRef = doc(
    db,
    "teams", state.teamId,
    "sessions", sessionId,
    "issues", issueId
  );

  try {
    await deleteCollectionRefs(collection(issueRef, "votes"));
    await deleteCollectionRefs(collection(issueRef, "vote_status"));
    await deleteCollectionRefs(collection(issueRef, "rounds"));
    await deleteDoc(issueRef);
  } catch (error) {
    console.warn("Не удалось полностью очистить незавершённую копию", error);
  }
}

async function verifyMovedCollections(targetIssueRef, expected) {
  const [votes, statuses, rounds] = await Promise.all([
    getDocs(collection(targetIssueRef, "votes")),
    getDocs(collection(targetIssueRef, "vote_status")),
    getDocs(collection(targetIssueRef, "rounds"))
  ]);

  if (
    votes.size !== expected.votes ||
    statuses.size !== expected.statuses ||
    rounds.size !== expected.rounds
  ) {
    throw new Error(
      "Проверка переноса не пройдена: количество вложенных документов не совпало."
    );
  }
}

function setMoveProgressMessage(
  messageTarget,
  text,
  type = "info"
) {
  if (!messageTarget) return;

  setFormMessage(
    messageTarget,
    text,
    type
  );
}

async function syncMovedIssueToTeamCalculator(
  targetIssueRef,
  targetSession
) {
  const api = window.TeamCalculatorIntegration;

  if (
    !api
    || typeof api.syncPayload !== "function"
  ) {
    return {
      ok: false,
      skipped: true,
      error:
        "Модуль интеграции Team_calculator ещё не готов."
    };
  }

  const targetSnapshot =
    await getDoc(targetIssueRef);

  if (!targetSnapshot.exists()) {
    return {
      ok: false,
      skipped: true,
      error:
        "Перенесённая задача не найдена для синхронизации."
    };
  }

  const issue = {
    id: targetIssueRef.id,
    ...targetSnapshot.data()
  };

  const payload =
    buildTeamCalendarEstimatePayload(
      issue,
      {
        sessionId: targetSession.id,
        sessionName: targetSession.name || ""
      }
    );

  if (!payload) {
    return {
      ok: false,
      skipped: true,
      error:
        "Для задачи пока нет данных для Team_calculator."
    };
  }

  return api.syncPayload(payload);
}

async function moveIssueRecordToSession({
  issueId,
  targetSessionId,
  reestimate = true,
  messageTarget = null,
  progressPrefix = ""
}) {
  if (
    !canManageEstimation()
    || !issueId
    || !targetSessionId
  ) {
    throw new Error(
      "Недостаточно данных для переноса задачи."
    );
  }

  const sourceTeamId = state.teamId;
  const sourceSessionId = state.sessionId;
  const sourceSession = currentSession();

  if (
    !sourceTeamId
    || !sourceSessionId
    || targetSessionId === sourceSessionId
  ) {
    throw new Error("Выберите другую сессию.");
  }

  const targetSession = state.sessions.find(
    session => session.id === targetSessionId
  );

  if (!targetSession) {
    throw new Error(
      "Выбранная сессия не найдена."
    );
  }

  const sourceIssueRef = doc(
    db,
    "teams", sourceTeamId,
    "sessions", sourceSessionId,
    "issues", issueId
  );

  const targetIssueRef = doc(
    db,
    "teams", sourceTeamId,
    "sessions", targetSessionId,
    "issues", issueId
  );

  let targetCreated = false;
  let moveStage = "чтение исходной задачи";

  const progress = text =>
    setMoveProgressMessage(
      messageTarget,
      progressPrefix
        ? `${progressPrefix}: ${text}`
        : text,
      "info"
    );

  try {
    progress("читаем задачу и историю");

    const sourceSnapshot =
      await getDoc(sourceIssueRef);

    if (!sourceSnapshot.exists()) {
      throw new Error(
        "Исходная задача больше не существует."
      );
    }

    const sourceData = sourceSnapshot.data();

    if (sourceData.status === "voting") {
      throw new Error(
        "Нельзя переносить задачу во время активного голосования."
      );
    }

    const previousEstimate =
      latestIssueEstimateInfo(
        sourceData,
        sourceSessionId,
        sourceSession?.name || ""
      );

    if (
      !reestimate
      && !previousEstimate
    ) {
      throw new Error(
        "Для переноса без переоценки у задачи должна быть последняя зафиксированная оценка."
      );
    }

    moveStage = "проверка целевой сессии";

    const existingTarget =
      await getDoc(targetIssueRef);

    if (existingTarget.exists()) {
      const existingData =
        existingTarget.data();

      if (
        existingData.moveState === "copying"
        && existingData.movedFromSessionId
          === sourceSessionId
      ) {
        await removeIncompleteMovedCopy(
          targetSessionId,
          issueId
        );
      } else {
        throw new Error(
          "В целевой сессии уже существует задача с таким идентификатором."
        );
      }
    }

    const sourceVotesRef =
      collection(sourceIssueRef, "votes");

    const sourceStatusesRef =
      collection(sourceIssueRef, "vote_status");

    const sourceRoundsRef =
      collection(sourceIssueRef, "rounds");

    moveStage =
      "чтение голосов и истории";

    const [
      votes,
      statuses,
      rounds,
      targetIssuesSnapshot
    ] = await Promise.all([
      readCollectionDocuments(
        sourceVotesRef
      ),
      readCollectionDocuments(
        sourceStatusesRef
      ),
      readCollectionDocuments(
        sourceRoundsRef
      ),
      getDocs(
        collection(
          db,
          "teams", sourceTeamId,
          "sessions", targetSessionId,
          "issues"
        )
      )
    ]);

    const targetSortOrder =
      targetIssuesSnapshot.docs.reduce(
        (maximum, item) =>
          Math.max(
            maximum,
            Number(
              item.data().sortOrder || 0
            )
          ),
        0
      ) + 10;

    const actor =
      currentActorSnapshot();

    const hasPreviousRoundData =
      sourceData.status !== "pending"
      || votes.length > 0
      || statuses.length > 0
      || rounds.length > 0
      || sourceData.finalEstimate != null;

    const reestimateRound =
      hasPreviousRoundData
        ? Number(
            sourceData.currentRound || 1
          ) + 1
        : Number(
            sourceData.currentRound || 1
          );

    const modeFields =
      reestimate
        ? {
            status: "pending",
            currentRound: reestimateRound,
            finalEstimate: null,
            finalizedAt: null,
            finalizedByUid: null,
            finalizedByEmail: null,
            finalizedByDisplayName: null,

            reestimateRequired: true,
            reestimateReason: "transferred",
            reestimateRequestedAt:
              serverTimestamp(),
            reestimateRequestedByUid:
              actor.uid,
            reestimateRequestedByEmail:
              actor.email,
            reestimateRequestedByDisplayName:
              actor.displayName,

            estimateReusedAfterTransfer:
              false
          }
        : {
            status: "estimated",
            currentRound: Number(
              sourceData.currentRound || 1
            ),
            finalEstimate:
              previousEstimate.finalEstimate,
            estimatedRole:
              previousEstimate.estimatedRole,
            estimateVersion:
              previousEstimate.estimateVersion,
            finalizedAt:
              previousEstimate.finalizedAt,
            finalizedByUid:
              previousEstimate.finalizedByUid,
            finalizedByEmail:
              previousEstimate.finalizedByEmail,
            finalizedByDisplayName:
              previousEstimate
                .finalizedByDisplayName,

            reestimateRequired: false,
            reestimateReason: null,
            reestimateRequestedAt: null,
            reestimateRequestedByUid: null,
            reestimateRequestedByEmail: null,
            reestimateRequestedByDisplayName:
              null,

            estimateReusedAfterTransfer: true,
            estimateReusedAt:
              serverTimestamp(),
            estimateReusedByUid:
              actor.uid,
            estimateReusedByEmail:
              actor.email,
            estimateReusedByDisplayName:
              actor.displayName,
            estimateReuseSourceSessionId:
              sourceSessionId,
            estimateReuseSourceSessionName:
              sourceSession?.name || ""
          };

    progress(
      reestimate
        ? "создаём копию на переоценку"
        : "создаём копию с последней оценкой"
    );

    moveStage = "создание копии задачи";

    await setDoc(
      targetIssueRef,
      {
        ...sourceData,
        sortOrder: targetSortOrder,
        ...modeFields,
        previousEstimate,

        moveMode:
          reestimate
            ? "reestimate"
            : "reuse_estimate",
        moveState: "copying",
        movedFromSessionId:
          sourceSessionId,
        movedFromSessionName:
          sourceSession?.name || "",
        movedByUid: actor.uid,
        movedByEmail: actor.email,
        movedByDisplayName:
          actor.displayName,
        moveStartedAt:
          serverTimestamp(),
        updatedAt:
          serverTimestamp()
      }
    );

    targetCreated = true;

    moveStage = "копирование голосов";

    await writeDocumentsInChunks(
      collection(targetIssueRef, "votes"),
      votes
    );

    moveStage =
      "копирование статусов голосования";

    await writeDocumentsInChunks(
      collection(
        targetIssueRef,
        "vote_status"
      ),
      statuses
    );

    moveStage =
      "копирование истории раундов";

    await writeDocumentsInChunks(
      collection(targetIssueRef, "rounds"),
      rounds
    );

    progress("проверяем созданную копию");

    moveStage =
      "проверка созданной копии";

    await verifyMovedCollections(
      targetIssueRef,
      {
        votes: votes.length,
        statuses: statuses.length,
        rounds: rounds.length
      }
    );

    const sourceBeforeFinal =
      await getDoc(sourceIssueRef);

    if (!sourceBeforeFinal.exists()) {
      throw new Error(
        "Исходная задача была удалена во время переноса."
      );
    }

    const currentSourceData =
      sourceBeforeFinal.data();

    if (
      currentSourceData.status
        !== sourceData.status
      || Number(
          currentSourceData.currentRound
        ) !== Number(
          sourceData.currentRound
        )
      || timestampValue(
          currentSourceData.updatedAt
        ) !== timestampValue(
          sourceData.updatedAt
        )
    ) {
      throw new Error(
        "Задача изменилась во время переноса. Исходная задача сохранена; повторите перенос."
      );
    }

    progress("завершаем перенос");

    const redirectRef =
      issueRedirectRef(
        sourceTeamId,
        sourceSessionId,
        issueId
      );

    const sourceAuditRef =
      createIssueAuditRef(
        sourceTeamId,
        sourceSessionId
      );

    const targetAuditRef =
      createIssueAuditRef(
        sourceTeamId,
        targetSessionId
      );

    const finalBatch = writeBatch(db);

    finalBatch.update(
      targetIssueRef,
      {
        moveState: "complete",
        movedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );

    finalBatch.set(
      redirectRef,
      {
        sourceSessionId,
        sourceIssueId: issueId,
        targetSessionId,
        targetIssueId: issueId,
        moveMode:
          reestimate
            ? "reestimate"
            : "reuse_estimate",
        movedByUid: actor.uid,
        movedByEmail: actor.email,
        movedByDisplayName:
          actor.displayName,
        movedAt: serverTimestamp()
      }
    );

    const auditSnapshot = {
      title: sourceData.title || "",
      moveMode:
        reestimate
          ? "reestimate"
          : "reuse_estimate",
      reusedFinalEstimate:
        reestimate
          ? null
          : previousEstimate
            ?.finalEstimate
            ?? null,
      reusedEstimateVersion:
        reestimate
          ? null
          : previousEstimate
            ?.estimateVersion
            ?? null
    };

    finalBatch.set(
      sourceAuditRef,
      {
        ...buildIssueAuditEvent({
          action: "moved_out",
          issueId,
          issueTitle:
            sourceData.title
            || "Задача без названия",
          snapshot: {
            ...auditSnapshot,
            targetSessionId,
            targetSessionName:
              targetSession.name || ""
          }
        }),
        sourceSessionId,
        sourceSessionName:
          sourceSession?.name || "",
        targetSessionId,
        targetSessionName:
          targetSession.name || ""
      }
    );

    finalBatch.set(
      targetAuditRef,
      {
        ...buildIssueAuditEvent({
          action: "moved_in",
          issueId,
          issueTitle:
            sourceData.title
            || "Задача без названия",
          snapshot: {
            ...auditSnapshot,
            sourceSessionId,
            sourceSessionName:
              sourceSession?.name || ""
          }
        }),
        sourceSessionId,
        sourceSessionName:
          sourceSession?.name || "",
        targetSessionId,
        targetSessionName:
          targetSession.name || ""
      }
    );

    finalBatch.delete(sourceIssueRef);

    moveStage =
      "финальное завершение переноса";

    await finalBatch.commit();

    try {
      await deleteCollectionRefs(
        sourceVotesRef
      );
      await deleteCollectionRefs(
        sourceStatusesRef
      );
      await deleteCollectionRefs(
        sourceRoundsRef
      );
    } catch (cleanupError) {
      console.warn(
        "Перенос завершён, но не все технические остатки удалены",
        cleanupError
      );
    }

    let calculatorSync = null;

    try {
      calculatorSync =
        await syncMovedIssueToTeamCalculator(
          targetIssueRef,
          targetSession
        );
    } catch (syncError) {
      calculatorSync = {
        ok: false,
        error: String(
          syncError?.message || syncError
        )
      };

      console.error(
        "Задача перенесена, но не удалось сразу синхронизировать Team_calculator",
        {
          issueId,
          targetSessionId,
          error: syncError
        }
      );
    }

    return {
      issueId,
      issueTitle:
        sourceData.title
        || "Задача без названия",
      targetSession,
      targetIssueRef,
      reestimate,
      previousEstimate,
      calculatorSync
    };
  } catch (error) {
    error.moveStage =
      error.moveStage || moveStage;

    if (targetCreated) {
      await removeIncompleteMovedCopy(
        targetSessionId,
        issueId
      );
    }

    throw error;
  }
}

function movePermissionErrorMessage(
  error,
  moveStage
) {
  const permissionDenied = [
    "permission-denied",
    "firestore/permission-denied"
  ].includes(error?.code);

  if (!permissionDenied) {
    return null;
  }

  return (
    "Firestore отклонил операцию на этапе «"
    + moveStage
    + "». Проверьте актуальные Firestore Rules. "
    + "Исходная задача не удалена."
  );
}

async function moveIssueToSession() {
  if (
    !canManageEstimation()
    || !state.issue
  ) {
    return;
  }

  const targetSessionId =
    $("moveIssueTargetSession").value;

  const messageTarget =
    $("moveIssueMessage");

  if (
    !targetSessionId
    || targetSessionId === state.sessionId
  ) {
    setFormMessage(
      messageTarget,
      "Выберите другую сессию."
    );
    return;
  }

  if (state.issue.status === "voting") {
    setFormMessage(
      messageTarget,
      "Нельзя переносить задачу во время активного голосования. Сначала раскройте оценки.",
      "error"
    );
    return;
  }

  const sourceTeamId = state.teamId;
  const issueId = state.issue.id;

  await withButton(
    $("confirmMoveIssueBtn"),
    "Перенос...",
    async () => {
      try {
        const result =
          await moveIssueRecordToSession({
            issueId,
            targetSessionId,
            reestimate: true,
            messageTarget
          });

        closeDialog("moveIssueDialog");

        pendingTaskLink = {
          teamId: sourceTeamId,
          sessionId: targetSessionId,
          issueId
        };

        const newUrl =
          new URL(window.location.href);

        newUrl.hash =
          new URLSearchParams({
            team: sourceTeamId,
            session: targetSessionId,
            issue: issueId
          }).toString();

        window.history.replaceState(
          null,
          "",
          newUrl.hash
        );

        selectSession(targetSessionId);

        toast(
          `Задача перенесена в сессию «${result.targetSession.name}». Требуется переоценка.`,
          "success",
          6000
        );
      } catch (error) {
        const permissionMessage =
          movePermissionErrorMessage(
            error,
            error.moveStage
            || "неизвестный этап"
          );

        if (permissionMessage) {
          setFormMessage(
            messageTarget,
            permissionMessage,
            "error"
          );

          console.error(
            "Перенос отклонён Firestore Rules",
            error
          );
        } else {
          handleError(
            error,
            messageTarget
          );
        }
      }
    }
  );
}

async function moveSelectedIssuesToSession() {
  if (!canManageEstimation() || bulkMoveInProgress || bulkVotingInProgress) return;
  const targetSessionId=$("bulkMoveTargetSession").value;
  const messageTarget=$("bulkMoveIssueMessage");
  if (!targetSessionId || targetSessionId===state.sessionId) {setFormMessage(messageTarget,"Выберите другую сессию.","error");return;}
  const targetSession=state.sessions.find(session=>session.id===targetSessionId);
  if (!targetSession) {setFormMessage(messageTarget,"Выбранная сессия не найдена.","error");return;}
  const mode=bulkMoveMode(), reestimate=mode!=="reuse";
  const {selected,eligible,excluded}=bulkMoveDialogSelection();
  if (!selected.length) {closeDialog("bulkMoveIssueDialog");renderIssues();return;}
  if (!eligible.length) {setFormMessage(messageTarget,mode==="reuse"?"У выбранных задач нет зафиксированной оценки. Выберите режим «С переоценкой».":"Нет задач, доступных для переноса.","error");return;}
  bulkMoveInProgress=true; renderBulkVotingControls(); renderBulkMoveDialogState();
  let succeeded=0, failed=0, calculatorSyncWarnings=0; const failures=[];
  try {
    for (let index=0; index<eligible.length; index+=1) {
      const issue=eligible[index]; const prefix=`${index+1}/${eligible.length} · ${issue.title}`;
      try {
        const result=await moveIssueRecordToSession({issueId:issue.id,targetSessionId,reestimate,messageTarget,progressPrefix:prefix});
        succeeded+=1; selectedVotingIssueIds.delete(issue.id);
        if (result.calculatorSync && result.calculatorSync.ok===false) calculatorSyncWarnings+=1;
      } catch(error) {
        failed+=1; failures.push({issueId:issue.id,title:issue.title||"Задача без названия",stage:error.moveStage||"неизвестный этап",error:String(error?.message||error)});
        console.error("Ошибка массового переноса",failures[failures.length-1],error);
      }
    }
    closeDialog("bulkMoveIssueDialog");
    const modeLabel=reestimate?"с переоценкой":"с последней оценкой";
    let resultText=`Перенесено ${succeeded} задач в «${targetSession.name}» ${modeLabel}.`;
    if (excluded.length) resultText+=` Исключено без оценки: ${excluded.length}.`;
    if (failed) resultText+=` Ошибок: ${failed}.`;
    if (calculatorSyncWarnings) resultText+=` Team_calculator не обновился сразу для ${calculatorSyncWarnings} задач.`;
    toast(resultText,failed?"error":"success",8000);
    // В целевую сессию автоматически не переключаемся.
    renderIssues();
  } finally { bulkMoveInProgress=false; renderIssues(); }
}


async function castVote(value) {
  if (
    !canVote() ||
    !state.issue ||
    state.issue.status !== "voting"
  ) {
    return;
  }

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
  if (!canManageEstimation() || !state.issue) return;

  const value = Number($("finalEstimate").value);
  const target = $("finalMessage");
  const estimatedRole = finalizationEstimatedRole();
  const teamSnapshot = currentTeamSnapshot();

  if (!Number.isFinite(value) || value <= 0) {
    return setFormMessage(target, "Укажите итоговую оценку.");
  }

  if (!isValidDevelopmentArea(estimatedRole)) {
    return setFormMessage(
      target,
      "Для задачи не задано направление оценки. Администратор должен указать Backend или Frontend."
    );
  }

  if (!SCALE.includes(value)) {
    const confirmed = confirm(
      `Оценка ${value} не входит в стандартную шкалу. Всё равно сохранить?`
    );
    if (!confirmed) return;
  }

  try {
    const round = Number(state.issue.currentRound);
    const nextVersion =
      Number(state.issue.estimateVersion || 0) + 1;
    const actor = currentActorSnapshot();

    const finalization = {
      estimatedRole,
      estimatedTeamId:
        state.issue.estimatedTeamId || teamSnapshot.id,
      estimatedTeamName:
        state.issue.estimatedTeamName || teamSnapshot.name,
      estimateVersion: nextVersion,
      finalizedByUid: actor.uid,
      finalizedByEmail: actor.email,
      finalizedByDisplayName: actor.displayName
    };

    const snapshot = await buildRoundSnapshot(
      round,
      "finalized",
      value,
      finalization
    );

    const batch = writeBatch(db);

    batch.set(
      roundDocumentRef(round),
      snapshot,
      { merge: true }
    );

    batch.update(currentIssueRef(), {
      finalEstimate: value,
      estimatedRole,
      estimatedTeamId: finalization.estimatedTeamId,
      estimatedTeamName: finalization.estimatedTeamName,
      estimateVersion: nextVersion,
      finalizedAt: serverTimestamp(),
      finalizedByUid: actor.uid,
      finalizedByEmail: actor.email,
      finalizedByDisplayName: actor.displayName,
      status: "estimated",

      reestimateRequired: false,
      reestimatedAt:
        state.issue.reestimateRequired === true
          ? serverTimestamp()
          : state.issue.reestimatedAt || null,
      reestimatedByUid:
        state.issue.reestimateRequired === true
          ? actor.uid
          : state.issue.reestimatedByUid || null,
      reestimatedByEmail:
        state.issue.reestimateRequired === true
          ? actor.email
          : state.issue.reestimatedByEmail || null,
      reestimatedByDisplayName:
        state.issue.reestimateRequired === true
          ? actor.displayName
          : state.issue.reestimatedByDisplayName || null,

      updatedAt: serverTimestamp()
    });

    const gitlabJob = buildGitLabEstimateJob({
      issue: state.issue,
      finalEstimate: value,
      estimatedRole,
      estimateVersion: nextVersion,
      finalizedBy: actor
    });

    if (gitlabJob) {
      batch.set(
        doc(
          db,
          "teams", state.teamId,
          gitlabJob.collectionName,
          gitlabJob.id
        ),
        gitlabJob.data
      );
    }

    // Для существующей сессии без снимка направления фиксируем его
    // в момент первой новой оценки.
    if (!isValidDevelopmentArea(currentSession()?.developmentArea)) {
      batch.update(
        doc(db, "teams", state.teamId, "sessions", state.sessionId),
        {
          developmentArea: estimatedRole,
          estimatedTeamId: teamSnapshot.id,
          estimatedTeamName: teamSnapshot.name,
          developmentAreaCapturedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );
    }

    await batch.commit();

    // Явно передаём только что зафиксированную оценку в Team_calculator.
    // Важно: интеграция больше не должна отправлять оценку сама по себе
    // при открытии карточки или по таймеру.
    try {
      const integration =
        window.TeamCalculatorIntegration;

      if (
        integration
        && typeof integration.syncPayload === "function"
      ) {
        const committedSnapshot =
          await getDoc(currentIssueRef());

        if (committedSnapshot.exists()) {
          const committedIssue = {
            id: committedSnapshot.id,
            ...committedSnapshot.data()
          };

          const payload =
            buildTeamCalendarEstimatePayload(
              committedIssue,
              {
                sessionId: state.sessionId,
                sessionName: currentSession()?.name || ""
              }
            );

          if (payload) {
            await integration.syncPayload(payload);
          }
        }
      }
    } catch (integrationError) {
      console.error(
        "Ошибка передачи зафиксированной оценки в Team_calculator",
        integrationError
      );
    }

    toast(
      gitlabJob
        ? `Оценка сохранена и поставлена в очередь GitLab: ${developmentAreaLabel(estimatedRole)} · ${value} ч.д. · версия ${nextVersion}.`
        : `Оценка сохранена: ${developmentAreaLabel(estimatedRole)} · ${value} ч.д. · версия ${nextVersion}.`,
      "success",
      5000
    );
  } catch (error) {
    handleError(error, target);
  }
}


function configuredGitLabIntegration() {
  const config = window.GITLAB_CONNECTOR_INTEGRATION || {};

  if (config.enabled === false) {
    return null;
  }

  const gitlabBaseUrl = String(
    config.gitlabBaseUrl || ""
  ).trim();

  if (
    !gitlabBaseUrl
    || gitlabBaseUrl.includes("REPLACE_")
  ) {
    return null;
  }

  return {
    gitlabBaseUrl: gitlabBaseUrl.replace(/\/+$/, ""),
    label: String(
      config.label || "estimate::done"
    ).trim() || "estimate::done",
    jobsCollection: String(
      config.jobsCollection || "gitlab_jobs"
    ).trim() || "gitlab_jobs"
  };
}

function gitLabEstimateJobId({
  sessionId,
  issueId,
  estimatedRole,
  estimateVersion
}) {
  return [
    sessionId,
    issueId,
    estimatedRole,
    `v${estimateVersion}`
  ].join("__");
}

function buildGitLabEstimateJob({
  issue,
  finalEstimate,
  estimatedRole,
  estimateVersion,
  finalizedBy
}) {
  const config = configuredGitLabIntegration();
  const externalTaskUrl = String(
    issue?.gitlabUrl || ""
  ).trim();

  if (!config || !externalTaskUrl) {
    return null;
  }

  const jobId = gitLabEstimateJobId({
    sessionId: state.sessionId,
    issueId: issue.id,
    estimatedRole,
    estimateVersion
  });

  return {
    id: jobId,
    collectionName: config.jobsCollection,
    data: {
      schemaVersion: 1,
      type: "sync_gitlab_estimate",
      status: "pending",
      idempotencyKey: jobId,

      teamId: state.teamId,
      sessionId: state.sessionId,
      issueId: issue.id,
      issueTitle: issue.title || "",
      externalTaskUrl,

      estimatedRole,
      finalEstimate: Number(finalEstimate),
      estimateVersion: Number(estimateVersion),
      gitlabLabel: config.label,
      gitlabBaseUrl: config.gitlabBaseUrl,

      requestedByUid: finalizedBy.uid,
      requestedByEmail: finalizedBy.email,
      requestedByDisplayName: finalizedBy.displayName,
      requestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      attempts: 0
    }
  };
}

function currentGitLabJobDescriptor(issue = state.issue) {
  if (
    !issue
    || issue.finalEstimate == null
    || !isValidDevelopmentArea(issue.estimatedRole)
    || !issue.estimateVersion
  ) {
    return null;
  }

  const config = configuredGitLabIntegration();
  const externalTaskUrl = String(
    issue.gitlabUrl || ""
  ).trim();

  if (!config || !externalTaskUrl) {
    return null;
  }

  const jobId = gitLabEstimateJobId({
    sessionId: state.sessionId,
    issueId: issue.id,
    estimatedRole: issue.estimatedRole,
    estimateVersion: Number(issue.estimateVersion)
  });

  return {
    id: jobId,
    teamId: state.teamId,
    sessionId: state.sessionId,
    issueId: issue.id,
    collectionName: config.jobsCollection,
    externalTaskUrl,
    estimatedRole: issue.estimatedRole,
    finalEstimate: Number(issue.finalEstimate),
    estimateVersion: Number(issue.estimateVersion)
  };
}

function timestampToIso(value) {
  const milliseconds = timestampValue(value);
  return milliseconds
    ? new Date(milliseconds).toISOString()
    : null;
}

function buildTeamCalendarEstimatePayload(
  issue = state.issue,
  context = null
) {
  if (!issue) return null;
  if (!isValidDevelopmentArea(issue.estimatedRole)) return null;

  const reestimateRequired =
    issue.reestimateRequired === true;

  if (
    !reestimateRequired
    && issue.finalEstimate == null
  ) {
    return null;
  }

  const previousEstimate =
    issue.previousEstimate
    && typeof issue.previousEstimate === "object"
      ? issue.previousEstimate
      : null;

  return {
    integrationSchemaVersion: 3,
    eventType: reestimateRequired
      ? "reestimate_required"
      : "estimate_finalized",

    taskId: issue.id,
    title: issue.title || "",
    externalTaskUrl: issue.gitlabUrl || null,
    estimatedRole: issue.estimatedRole,

    finalEstimate:
      issue.finalEstimate == null
        ? null
        : Number(issue.finalEstimate),

    estimateVersion: Number(
      issue.estimateVersion || 0
    ),

    finalizedAt: timestampToIso(issue.finalizedAt),

    reestimate: reestimateRequired
      ? {
          required: true,
          reason:
            issue.reestimateReason
            || "transferred",
          requestedAt:
            timestampToIso(
              issue.reestimateRequestedAt
            ),
          requestedBy: {
            uid:
              issue.reestimateRequestedByUid
              || null,
            email:
              issue.reestimateRequestedByEmail
              || null,
            displayName:
              issue.reestimateRequestedByDisplayName
              || null
          },
          previousFinalEstimate:
            previousEstimate?.finalEstimate == null
              ? null
              : Number(
                  previousEstimate.finalEstimate
                ),
          previousEstimateVersion:
            Number(
              previousEstimate?.estimateVersion
              || issue.estimateVersion
              || 0
            ),
          previousFinalizedAt:
            timestampToIso(
              previousEstimate?.finalizedAt
            )
        }
      : {
          required: false,
          resolvedAt:
            timestampToIso(
              issue.reestimatedAt
            )
        },

    team: {
      id: issue.estimatedTeamId || state.teamId,
      name: issue.estimatedTeamName || currentTeam()?.name || ""
    },
    session: {
      id:
        context?.sessionId
        || state.sessionId,
      name:
        context?.sessionName
        || (
          context?.sessionId === state.sessionId
            ? currentSession()?.name
            : ""
        )
        || ""
    },
    transfer: issueTransferInfo(
      issue,
      context
    ),
    source: "team_poker"
  };
}

async function copyTeamCalendarPayload() {
  const payload = buildTeamCalendarEstimatePayload();

  if (!payload) {
    setFormMessage(
      $("finalMessage"),
      "Оценку нельзя передать в Team_calendar без зафиксированной оценки и estimatedRole.",
      "error"
    );
    return;
  }

  const json = JSON.stringify(payload, null, 2);

  try {
    await navigator.clipboard.writeText(json);
    setFormMessage(
      $("finalMessage"),
      "Данные для Team_calendar скопированы.",
      "success"
    );
  } catch {
    window.prompt(
      "Скопируйте данные для Team_calendar:",
      json
    );
  }
}

// Точка расширения для будущего прямого вызова интеграции.
window.TeamPokerIntegration = {
  getCurrentEstimatePayload: () =>
    buildTeamCalendarEstimatePayload(),

  getCurrentGitLabJobDescriptor: () =>
    currentGitLabJobDescriptor(),

  canManageCurrentEstimation: () =>
    canManageEstimation(),

  getDeliveryStatusDescriptors: () =>
    calculatorDeliveryStatusDescriptors(),

  setDeliveryStatuses: (items, meta) =>
    applyCalculatorDeliveryStatuses(items, meta),

  getDeliveryStatusSyncMeta: () => ({
    ...calculatorDeliverySyncMeta
  })
};

async function copyEstimate() {
  const value = Number($("finalEstimate").value);
  if (!value) return;

  const commands = [
    `/estimate ${value}d`,
    `/label ~"estimate::done"`
  ].join("\n");

  try {
    await navigator.clipboard.writeText(commands);

    setFormMessage(
      $("finalMessage"),
      "Команды GitLab скопированы в буфер обмена.",
      "success"
    );
  } catch {
    setFormMessage(
      $("finalMessage"),
      `Команды GitLab:\n${commands}`,
      "success"
    );
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
  if (!isAdmin() || !state.teamId) return;

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

    await deleteCollectionRefs(
      collection(db, "teams", state.teamId, "issue_redirects")
    );

    await deleteDoc(doc(db, "teams", state.teamId));
    localStorage.removeItem("planningPoker.firebase.teamId");
    toast("Команда удалена.", "success");
  } catch (error) {
    handleError(error);
  }
}

async function deleteSession() {
  if (!canManageEstimation() || !state.sessionId) return;

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
