window.TEAM_CALCULATOR_INTEGRATION = {
  // Team_poker → Team_calculator: передача зафиксированной оценки.
  endpoint:
    "https://team-poker-team-calculator-integration.slavanazin.workers.dev/sync",

  // Team_calculator → Team_poker:
  // metadata_connector зеркалит готовые статусы в Firestore Team_poker.
  // Team_poker читает их realtime, без /task-statuses и без GitLab API.
  statusTransport: "firestore",
  statusCollection: "delivery_status"
};
