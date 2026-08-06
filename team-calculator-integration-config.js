window.TEAM_CALCULATOR_INTEGRATION = {
  // Вставьте URL Worker после его публикации.
  // Пример:
  // endpoint: "https://team-poker-team-calculator-integration.example.workers.dev/sync"
  endpoint: "https://team-poker-team-calculator-integration.slavanazin.workers.dev/sync",

  // Read-only endpoint. Он читает уже нормализованные статусы из
  // Team_calculator; прямого подключения Team_poker к GitLab нет.
  statusEndpoint: "https://team-poker-team-calculator-integration.slavanazin.workers.dev/task-statuses",

  // Периодическое обновление статусов задач открытой сессии.
  statusPollIntervalMs: 15000
};
