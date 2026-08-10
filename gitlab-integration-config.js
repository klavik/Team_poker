window.GITLAB_CONNECTOR_INTEGRATION = {
  // URL корпоративного GitLab без /api/v4.
  // Пример: "https://gitlab.company.local"
  gitlabBaseUrl: "REPLACE_WITH_CORPORATE_GITLAB_URL",

  // Метка, добавляемая после успешной установки оценки.
  label: "estimate::done",

  // Коллекция заданий внутри каждой команды:
  // teams/{teamId}/gitlab_jobs/{jobId}
  jobsCollection: "gitlab_jobs",

  // Автоматически создавать задание после фиксации оценки.
  enabled: true
};
