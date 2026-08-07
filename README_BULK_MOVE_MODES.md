# Team_poker — массовый перенос задач

Добавлена кнопка «Массовый перенос».

Два режима:

1. С переоценкой
   - история и голоса сохраняются;
   - текущая оценка становится previousEstimate;
   - в новой сессии status=pending;
   - reestimateRequired=true;
   - создаётся новый раунд при наличии предыдущей активности.

2. Без переоценки
   - берётся текущая finalEstimate;
   - если её нет, используется previousEstimate;
   - finalEstimate, estimatedRole и estimateVersion сохраняются;
   - status=estimated;
   - reestimateRequired=false;
   - сохраняется аудит переиспользования оценки.

Задачи в активном голосовании не переносятся.
Задачи без предыдущей оценки недоступны в режиме «Без переоценки».

Для каждой задачи сохраняется прежняя безопасная схема:
copy → nested collections → verify → redirect/audit → source delete.

После успешного переноса каждая задача отдельно синхронизируется
с Team_calculator с новым session/transfer context.

Деплой:
- index.html
- app.js
- styles.css
- calculator-integration-status.js

Не менялись:
- firestore.rules
- metadata_connector
- Team_calculator
