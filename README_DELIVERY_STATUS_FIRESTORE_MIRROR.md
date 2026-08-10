# Team_poker — delivery status через Firestore mirror

Контур:

```text
GitLab
  → metadata_connector
  → Team_calculator taskPool.gitlab
  → Firestore Team_poker
    teams/{teamId}/delivery_status/{issueId}
  → Team_poker realtime listener
```

Team_poker не обращается в GitLab за статусами и больше не
использует `/task-statuses` Cloudflare Worker.

UI badges уже были в `app.js`, поэтому он не менялся.

Для Team_poker опубликовать:

- calculator-integration-status.js
- team-calculator-integration-config.js
- firestore.rules
