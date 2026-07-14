window.GITLAB_CONNECTOR_INTEGRATION = {
  // URL корпоративного GitLab без /api/v4.
  // Пример: "https://gitlab.company.local"
  gitlabBaseUrl: "https://git.mars.corp.dev.vtb",

  // Метка, добавляемая после успешной установки оценки.
  label: "estimate::done",

  // Коллекция заданий внутри каждой команды:
  // teams/{teamId}/gitlab_jobs/{jobId}
  jobsCollection: "gitlab_jobs",

  // Автоматически создавать задание после фиксации оценки.
  enabled: true
};
