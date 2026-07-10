(() => {
  "use strict";

  const SCALE = [0.5, 1, 2, 3, 5, 8, 13];
  const cfg = window.APP_CONFIG || {};

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
    votes: [],
    myVote: null,
    progress: null
  };

  let db = null;
  let authUser = null;
  let pollTimer = null;
  let refreshRunning = false;
  let bootstrapping = false;
  let connectionWasDown = false;

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

  function currentTeam() {
    return state.teams.find(team => team.id === state.teamId) || null;
  }

  function isLead() {
    return state.role === "lead" || currentTeam()?.created_by === authUser?.id;
  }

  function isNetworkError(error) {
    const text = String(error?.message || error || "").toLowerCase();
    return [
      "failed to fetch",
      "networkerror",
      "network request failed",
      "load failed",
      "timeout",
      "timed out",
      "aborterror"
    ].some(fragment => text.includes(fragment));
  }

  function friendlyError(error) {
    const message = String(error?.message || error || "Неизвестная ошибка");

    if (isNetworkError(error)) {
      return "Supabase временно не отвечает. Приложение повторит запрос автоматически.";
    }

    const replacements = new Map([
      ["Invalid login credentials", "Неверный email или пароль."],
      ["Email not confirmed", "Email пользователя не подтверждён администратором."],
      ["User not found", "Пользователь не найден."],
      ["Password should be at least 6 characters", "Пароль слишком короткий."],
      ["New password should be different from the old password.", "Новый пароль должен отличаться от текущего."],
      ["Current password is incorrect", "Текущий пароль указан неверно."],
      ["duplicate key value violates unique constraint", "Такая запись уже существует."]
    ]);

    for (const [source, translated] of replacements) {
      if (message.includes(source)) return translated;
    }

    return message;
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

  function showConnectionProblem(text = "Нет связи с Supabase. Повторяем запросы автоматически.") {
    const banner = $("connectionBanner");
    banner.textContent = text;
    banner.className = "connection-banner";
    connectionWasDown = true;
  }

  function hideConnectionProblem() {
    const banner = $("connectionBanner");
    banner.className = "connection-banner hidden";

    if (connectionWasDown) {
      connectionWasDown = false;
      toast("Соединение с Supabase восстановлено.", "success", 3000);
    }
  }

  function handleError(error, target = null) {
    console.error(error);
    const text = friendlyError(error);

    if (isNetworkError(error)) {
      showConnectionProblem(text);
    }

    if (target) {
      setFormMessage(target, text, "error");
    } else if (!isNetworkError(error)) {
      toast(text, "error");
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

  function validConfig() {
    return Boolean(
      cfg.supabaseUrl &&
      cfg.supabasePublishableKey &&
      !cfg.supabaseUrl.includes("YOUR_") &&
      !cfg.supabasePublishableKey.includes("YOUR_")
    );
  }

  async function init() {
    bindEvents();
    renderPokerCards();

    if (!validConfig()) {
      show($("configError"));
      return;
    }

    const resilientFetch = window.createResilientFetch({
      retries: Number(cfg.requestRetries ?? 3),
      timeoutMs: Number(cfg.requestTimeoutMs ?? 15000),
      baseDelayMs: Number(cfg.retryBaseDelayMs ?? 700)
    });

    db = window.supabase.createClient(
      cfg.supabaseUrl,
      cfg.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        },
        global: {
          fetch: resilientFetch
        }
      }
    );

    const { data, error } = await db.auth.getSession();

    if (error) {
      handleError(error);
    }

    authUser = data?.session?.user || null;
    renderAuth();

    db.auth.onAuthStateChange((event, session) => {
      authUser = session?.user || null;
      renderAuth();

      if (event === "SIGNED_IN") {
        queueMicrotask(() => bootstrapApp());
      }

      if (event === "SIGNED_OUT") {
        clearAppState();
      }

      // TOKEN_REFRESHED intentionally does not reload the whole application.
    });

    if (authUser) {
      await bootstrapApp();
    }
  }

  function bindEvents() {
    $("loginBtn").addEventListener("click", login);
    $("logoutBtn").addEventListener("click", logout);
    $("refreshBtn").addEventListener("click", () => refreshCurrent(false));

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

    window.addEventListener("unhandledrejection", event => {
      event.preventDefault();
      handleError(event.reason || new Error("Необработанная ошибка"));
      scheduleRefresh(10000);
    });

    window.addEventListener("online", () => {
      hideConnectionProblem();
      scheduleRefresh(300);
    });

    window.addEventListener("offline", () => {
      showConnectionProblem("Нет подключения к интернету.");
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleRefresh(300);
    });
  }

  function renderAuth() {
    show($("loginView"), !authUser);
    show($("appView"), Boolean(authUser));
    show($("userBox"), Boolean(authUser));

    if (authUser) {
      $("userEmail").textContent = authUser.email || "";
    }
  }

  async function login() {
    const email = normalizeEmail($("loginEmail").value);
    const password = $("loginPassword").value;
    const messageTarget = $("loginMessage");

    setFormMessage(messageTarget);

    if (!email) {
      return setFormMessage(messageTarget, "Укажите email.");
    }

    if (!password) {
      return setFormMessage(messageTarget, "Укажите пароль.");
    }

    await withButton($("loginBtn"), "Вход...", async () => {
      const { error } = await db.auth.signInWithPassword({ email, password });

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      $("loginPassword").value = "";
      setFormMessage(messageTarget);
    });
  }

  async function logout() {
    clearTimeout(pollTimer);

    const { error } = await db.auth.signOut({ scope: "local" });

    if (error) {
      handleError(error);
      return;
    }

    authUser = null;
    renderAuth();
    clearAppState();
  }

  async function bootstrapApp() {
    if (!authUser || bootstrapping) return;

    bootstrapping = true;

    try {
      await loadTeams();
      hideConnectionProblem();
      scheduleRefresh();
    } catch (error) {
      handleError(error);
      scheduleRefresh(10000);
    } finally {
      bootstrapping = false;
    }
  }

  function clearAppState() {
    clearTimeout(pollTimer);

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
      votes: [],
      myVote: null,
      progress: null
    });

    renderTeams();
    renderSessions();
    renderIssues();
    renderTeamControls();
    show($("welcomeCard"));
    show($("issueCard"), false);
  }

  function scheduleRefresh(delay = Number(cfg.pollIntervalMs ?? 30000)) {
    clearTimeout(pollTimer);

    if (!authUser) return;

    pollTimer = setTimeout(() => refreshCurrent(true), delay);
  }

  async function refreshCurrent(silent = true) {
    if (!authUser || refreshRunning) return;

    if (document.hidden) {
      scheduleRefresh();
      return;
    }

    if (!navigator.onLine) {
      showConnectionProblem("Нет подключения к интернету.");
      scheduleRefresh(15000);
      return;
    }

    refreshRunning = true;

    try {
      await loadTeams({ preserveSelection: true, silent: true });
      hideConnectionProblem();

      if (!silent) {
        toast("Данные обновлены.", "success", 2500);
      }
    } catch (error) {
      handleError(error);
    } finally {
      refreshRunning = false;
      scheduleRefresh();
    }
  }

  async function loadTeams(options = {}) {
    const previousId = options.preserveSelection ? state.teamId : null;

    const { data, error } = await db
      .from("teams")
      .select("*")
      .order("name");

    if (error) throw error;

    state.teams = data || [];

    const storedId = localStorage.getItem("planningPoker.teamId");
    const preferredId = previousId || storedId;

    state.teamId = state.teams.some(team => team.id === preferredId)
      ? preferredId
      : state.teams[0]?.id || null;

    renderTeams();

    if (state.teamId) {
      await selectTeam(state.teamId, { preserveSession: options.preserveSelection });
    } else {
      resetTeamDependentState();
    }
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

  async function selectTeam(teamId, options = {}) {
    state.teamId = teamId || null;
    localStorage.setItem("planningPoker.teamId", state.teamId || "");

    if (!options.preserveSession) {
      state.sessionId = null;
      state.issueId = null;
    }

    if (!state.teamId) {
      resetTeamDependentState();
      return;
    }

    // Сначала определяем состав и роль пользователя, затем загружаем сессию.
    // Иначе карточка задачи может отрисоваться до того, как станет известно,
    // что текущий пользователь является тимлидом.
    await loadMembers();
    await loadSessions({ preserveSelection: options.preserveSession });

    renderTeamControls();
    if (state.issue) renderIssue();
  }

  function resetTeamDependentState() {
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

  async function loadMembers() {
    if (!state.teamId) return;

    const { data, error } = await db
      .from("team_members")
      .select("*")
      .eq("team_id", state.teamId)
      .eq("active", true)
      .order("display_name");

    if (error) throw error;

    state.members = data || [];

    const currentEmail = normalizeEmail(authUser?.email);
    state.role = state.members.find(member => member.email === currentEmail)?.role || null;

    renderMembers();
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
    const messageTarget = $("teamDialogMessage");

    setFormMessage(messageTarget);

    if (!name) {
      return setFormMessage(messageTarget, "Укажите название команды.");
    }

    await withButton($("createTeamBtn"), "Создание...", async () => {
      const { data: team, error } = await db
        .from("teams")
        .insert({
          name,
          created_by: authUser.id
        })
        .select()
        .single();

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      const ownerEmail = normalizeEmail(authUser.email);

      const { error: memberError } = await db
        .from("team_members")
        .upsert({
          team_id: team.id,
          email: ownerEmail,
          display_name: authUser.user_metadata?.full_name || ownerEmail,
          role: "lead",
          active: true
        }, {
          onConflict: "team_id,email"
        });

      if (memberError) {
        handleError(memberError, messageTarget);
        return;
      }

      $("newTeamName").value = "";
      closeDialog("teamDialog");

      await loadTeams();
      await selectTeam(team.id);
      toast(`Команда «${name}» создана.`, "success");
    });
  }

  async function deleteTeam() {
    if (!isLead() || !state.teamId) return;

    const team = currentTeam();
    const confirmed = confirm(
      `Удалить команду «${team?.name || ""}»?\n\n` +
      "Будут удалены участники, сессии, задачи, раунды и голоса. Действие необратимо."
    );

    if (!confirmed) return;

    const { error } = await db
      .from("teams")
      .delete()
      .eq("id", state.teamId);

    if (error) {
      handleError(error);
      return;
    }

    state.teamId = null;
    localStorage.removeItem("planningPoker.teamId");
    await loadTeams();
    toast("Команда удалена.", "success");
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
          <strong>${escapeHtml(member.display_name)}</strong>
          <div class="member-email">${escapeHtml(member.email)}</div>
        </div>
        <div class="role-pill ${member.role === "lead" ? "lead" : ""}">
          ${member.role === "lead" ? "Тимлид" : "Участник"}
        </div>
        ${
          isLead() && member.email !== normalizeEmail(authUser.email)
            ? `<button class="button danger icon-button" type="button" data-remove-member="${member.id}" title="Удалить участника">×</button>`
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
    const messageTarget = $("memberDialogMessage");

    setFormMessage(messageTarget);

    if (!displayName || !email) {
      return setFormMessage(messageTarget, "Заполните имя и email.");
    }

    await withButton($("addMemberBtn"), "Добавление...", async () => {
      const { error } = await db
        .from("team_members")
        .upsert({
          team_id: state.teamId,
          email,
          display_name: displayName,
          role,
          active: true
        }, {
          onConflict: "team_id,email"
        });

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      $("memberName").value = "";
      $("memberEmail").value = "";
      $("memberRole").value = "member";

      await loadMembers();
      toast("Участник добавлен.", "success");
    });
  }

  async function removeMember(memberId) {
    const member = state.members.find(item => item.id === memberId);

    if (!member || !confirm(`Удалить ${member.display_name} из команды?`)) {
      return;
    }

    const { error } = await db
      .from("team_members")
      .delete()
      .eq("id", memberId);

    if (error) {
      handleError(error);
      return;
    }

    await loadMembers();
    toast("Участник удалён.", "success");
  }

  async function loadSessions(options = {}) {
    if (!state.teamId) return;

    const previousId = options.preserveSelection ? state.sessionId : null;

    const { data, error } = await db
      .from("sessions")
      .select("*")
      .eq("team_id", state.teamId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    state.sessions = data || [];

    const storedId = localStorage.getItem(`planningPoker.sessionId.${state.teamId}`);
    const preferredId = previousId || storedId;

    state.sessionId = state.sessions.some(session => session.id === preferredId)
      ? preferredId
      : state.sessions.find(session => session.status === "active")?.id
        || state.sessions[0]?.id
        || null;

    renderSessions();

    if (state.sessionId) {
      await selectSession(state.sessionId, { preserveIssue: options.preserveSelection });
    } else {
      state.issues = [];
      state.issueId = null;
      state.issue = null;
      renderIssues();
      show($("welcomeCard"));
      show($("issueCard"), false);
    }
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

  async function selectSession(sessionId, options = {}) {
    state.sessionId = sessionId || null;

    if (state.teamId) {
      localStorage.setItem(`planningPoker.sessionId.${state.teamId}`, state.sessionId || "");
    }

    if (!options.preserveIssue) {
      state.issueId = null;
    }

    if (!state.sessionId) {
      state.issues = [];
      renderIssues();
      show($("welcomeCard"));
      show($("issueCard"), false);
      renderTeamControls();
      return;
    }

    await loadIssues({ preserveSelection: options.preserveIssue });
    renderTeamControls();
  }

  async function createSession() {
    if (!isLead()) return;

    const name = $("sessionName").value.trim();
    const iteration = $("sessionIteration").value.trim();
    const messageTarget = $("sessionDialogMessage");

    setFormMessage(messageTarget);

    if (!name) {
      return setFormMessage(messageTarget, "Укажите название сессии.");
    }

    await withButton($("createSessionBtn"), "Создание...", async () => {
      const { data, error } = await db
        .from("sessions")
        .insert({
          team_id: state.teamId,
          name,
          iteration: iteration || null,
          status: "active",
          created_by: authUser.id
        })
        .select()
        .single();

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      $("sessionName").value = "";
      $("sessionIteration").value = "";
      closeDialog("sessionDialog");

      await loadSessions();
      await selectSession(data.id);
      toast("Сессия создана.", "success");
    });
  }

  async function finishSession() {
    if (!isLead() || !state.sessionId) return;

    const { error } = await db
      .from("sessions")
      .update({ status: "finished" })
      .eq("id", state.sessionId);

    if (error) {
      handleError(error);
      return;
    }

    await loadSessions({ preserveSelection: true });
    toast("Сессия завершена.", "success");
  }

  async function deleteSession() {
    if (!isLead() || !state.sessionId) return;

    const session = state.sessions.find(item => item.id === state.sessionId);
    const confirmed = confirm(
      `Удалить сессию «${session?.name || ""}»?\n\n` +
      "Будут удалены все задачи, раунды и голоса этой сессии."
    );

    if (!confirmed) return;

    const { error } = await db
      .from("sessions")
      .delete()
      .eq("id", state.sessionId);

    if (error) {
      handleError(error);
      return;
    }

    state.sessionId = null;
    state.issueId = null;
    localStorage.removeItem(`planningPoker.sessionId.${state.teamId}`);

    await loadSessions();
    toast("Сессия удалена.", "success");
  }

  async function loadIssues(options = {}) {
    if (!state.sessionId) return;

    const previousId = options.preserveSelection ? state.issueId : null;

    const { data, error } = await db
      .from("issues")
      .select("*")
      .eq("session_id", state.sessionId)
      .order("sort_order")
      .order("created_at");

    if (error) throw error;

    state.issues = data || [];

    const preferredId = previousId;

    state.issueId = state.issues.some(issue => issue.id === preferredId)
      ? preferredId
      : state.issues.find(issue => issue.status !== "estimated")?.id
        || state.issues[0]?.id
        || null;

    renderIssues();

    if (state.issueId) {
      await loadIssue(state.issueId);
    } else {
      state.issue = null;
      show($("welcomeCard"));
      show($("issueCard"), false);
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
          ${issue.final_estimate ? ` · ${issue.final_estimate} ч.д.` : ""}
        </div>
      </div>
    `).join("");

    root.querySelectorAll("[data-issue-id]").forEach(item => {
      item.addEventListener("click", () => loadIssue(item.dataset.issueId));
    });
  }

  async function createIssue() {
    if (!isLead()) return;

    const title = $("newIssueTitle").value.trim();
    const gitlabUrl = $("newIssueUrl").value.trim();
    const description = $("newIssueDescription").value.trim();
    const messageTarget = $("issueDialogMessage");

    setFormMessage(messageTarget);

    if (!title) {
      return setFormMessage(messageTarget, "Укажите название задачи.");
    }

    const maxOrder = state.issues.reduce(
      (maximum, issue) => Math.max(maximum, Number(issue.sort_order || 0)),
      0
    );

    await withButton($("createIssueBtn"), "Добавление...", async () => {
      const { data, error } = await db
        .from("issues")
        .insert({
          session_id: state.sessionId,
          title,
          gitlab_url: gitlabUrl || null,
          description: description || null,
          status: "pending",
          current_round: 1,
          sort_order: maxOrder + 10,
          created_by: authUser.id
        })
        .select()
        .single();

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      $("newIssueTitle").value = "";
      $("newIssueUrl").value = "";
      $("newIssueDescription").value = "";
      closeDialog("issueDialog");

      await loadIssues();
      await loadIssue(data.id);
      toast("Задача добавлена.", "success");
    });
  }

  async function loadIssue(issueId) {
    state.issueId = issueId;

    const { data, error } = await db
      .from("issues")
      .select("*")
      .eq("id", issueId)
      .single();

    if (error) throw error;

    state.issue = data;

    await Promise.all([
      loadVoteProgress(),
      loadMyVote(),
      loadVisibleVotes()
    ]);

    renderIssues();
    renderIssue();
  }

  async function loadVoteProgress() {
    if (!state.issueId) return;

    const { data, error } = await db.rpc("get_vote_progress", {
      p_issue_id: state.issueId
    });

    if (error) throw error;

    state.progress = Array.isArray(data) ? data[0] : data;
  }

  async function loadMyVote() {
    if (!state.issue) return;

    const { data, error } = await db
      .from("votes")
      .select("*")
      .eq("issue_id", state.issue.id)
      .eq("round", state.issue.current_round)
      .eq("user_id", authUser.id)
      .maybeSingle();

    if (error) throw error;

    state.myVote = data || null;
  }

  async function loadVisibleVotes() {
    state.votes = [];

    if (!state.issue || !["revealed", "estimated"].includes(state.issue.status)) {
      return;
    }

    const { data, error } = await db
      .from("votes")
      .select("*")
      .eq("issue_id", state.issue.id)
      .eq("round", state.issue.current_round)
      .order("created_at");

    if (error) throw error;

    state.votes = data || [];
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

    show($("gitlabLink"), Boolean(issue.gitlab_url));
    if (issue.gitlab_url) {
      $("gitlabLink").href = issue.gitlab_url;
    }

    $("roundValue").textContent = issue.current_round;
    $("votesCount").textContent = state.progress?.total_votes ?? "—";
    $("membersCount").textContent = state.progress?.eligible_members ?? state.members.length;

    $("voteNotice").textContent = ({
      pending: "Тимлид ещё не открыл голосование.",
      voting: "Выберите оценку. До раскрытия другие участники не увидят её значение.",
      revealed: "Оценки раскрыты. Можно зафиксировать итог или начать новый раунд.",
      estimated: `Итоговая оценка: ${issue.final_estimate} человеко-дней.`
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

    $("finalEstimate").value = issue.final_estimate || suggestedEstimate() || "";
    $("finalizeBtn").disabled = !isLead() || !["revealed", "estimated"].includes(issue.status);
    $("copyEstimateBtn").disabled = !$("finalEstimate").value;

    setFormMessage(
      $("finalMessage"),
      issue.final_estimate ? `Зафиксировано: ${issue.final_estimate} ч.д.` : "",
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

  async function issueAction(action) {
    if (!isLead() || !state.issue) return;

    if (action === "delete") {
      const confirmed = confirm(
        `Удалить задачу «${state.issue.title}»?\n\n` +
        "Будут удалены все раунды и голоса."
      );

      if (!confirmed) return;

      const { error } = await db
        .from("issues")
        .delete()
        .eq("id", state.issue.id);

      if (error) {
        handleError(error);
        return;
      }

      state.issueId = null;
      state.issue = null;
      await loadIssues();
      toast("Задача удалена.", "success");
      return;
    }

    let patch = null;

    if (action === "start") {
      patch = { status: "voting" };
    }

    if (action === "reveal") {
      patch = { status: "revealed" };
    }

    if (action === "new-round") {
      patch = {
        status: "voting",
        current_round: state.issue.current_round + 1,
        final_estimate: null
      };
    }

    if (!patch) return;

    const { error } = await db
      .from("issues")
      .update(patch)
      .eq("id", state.issue.id);

    if (error) {
      handleError(error);
      return;
    }

    await loadIssue(state.issue.id);
  }

  async function castVote(value) {
    if (!state.issue || state.issue.status !== "voting") return;

    const { error } = await db
      .from("votes")
      .upsert({
        issue_id: state.issue.id,
        round: state.issue.current_round,
        user_id: authUser.id,
        voter_email: normalizeEmail(authUser.email),
        value
      }, {
        onConflict: "issue_id,round,user_id"
      });

    if (error) {
      handleError(error);
      return;
    }

    await loadIssue(state.issue.id);
    toast("Голос сохранён.", "success", 2000);
  }

  function voteStats() {
    const values = state.votes
      .map(vote => Number(vote.value))
      .sort((left, right) => left - right);

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
            <span>${escapeHtml(memberByEmail[vote.voter_email]?.display_name || vote.voter_email)}</span>
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
    const messageTarget = $("finalMessage");

    if (!Number.isFinite(value) || value <= 0) {
      return setFormMessage(messageTarget, "Укажите итоговую оценку.");
    }

    if (!SCALE.includes(value)) {
      const confirmed = confirm(
        `Оценка ${value} не входит в стандартную шкалу. Всё равно сохранить?`
      );

      if (!confirmed) return;
    }

    const { error } = await db
      .from("issues")
      .update({
        final_estimate: value,
        status: "estimated"
      })
      .eq("id", state.issue.id);

    if (error) {
      handleError(error, messageTarget);
      return;
    }

    await loadIssue(state.issue.id);
    toast("Итоговая оценка сохранена.", "success");
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
    if (!authUser?.email) return;

    const currentPassword = $("currentPassword").value;
    const newPassword = $("newPassword").value;
    const confirmPassword = $("confirmNewPassword").value;
    const messageTarget = $("passwordMessage");

    setFormMessage(messageTarget);

    if (!currentPassword) {
      return setFormMessage(messageTarget, "Введите текущий пароль.");
    }

    if (newPassword.length < 8) {
      return setFormMessage(messageTarget, "Новый пароль должен содержать не менее 8 символов.");
    }

    if (newPassword !== confirmPassword) {
      return setFormMessage(messageTarget, "Новые пароли не совпадают.");
    }

    if (currentPassword === newPassword) {
      return setFormMessage(messageTarget, "Новый пароль должен отличаться от текущего.");
    }

    await withButton($("savePasswordBtn"), "Сохранение...", async () => {
      const { error } = await db.auth.updateUser({
        email: authUser.email,
        current_password: currentPassword,
        password: newPassword
      });

      if (error) {
        handleError(error, messageTarget);
        return;
      }

      setFormMessage(messageTarget, "Пароль успешно изменён.", "success");

      setTimeout(() => {
        closePasswordDialog();
        toast("Пароль изменён.", "success");
      }, 800);
    });
  }

  function openDialog(id) {
    const dialog = $(id);
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(id) {
    const dialog = $(id);
    if (dialog.open) dialog.close();
  }

  init().catch(error => {
    handleError(error);
    show($("loginView"), false);
  });
})();
