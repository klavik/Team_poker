window.GITLAB_CONNECTOR_INTEGRATION = {
  // Адрес GitLab здесь не публикуется: его знает локальный mac_connector.
  // В заданиях Firestore хост выводится из ссылки на внешнюю задачу.
  // Пустая строка оставлена для совместимости с прежним форматом конфига.
  gitlabBaseUrl: "",

  // Метка, добавляемая после успешной установки оценки.
  label: "estimate::done",

  // Коллекция заданий внутри каждой команды:
  // teams/{teamId}/gitlab_jobs/{jobId}
  jobsCollection: "gitlab_jobs",

  // Автоматически создавать задание после фиксации оценки.
  enabled: true
};
