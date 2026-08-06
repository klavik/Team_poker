# Team_poker — статусы выполнения из Team_calculator

## Контур данных

```text
GitLab → существующий Mac connector → Team_calculator → Cloudflare Worker → Team_poker
```

Team_poker не подключается к GitLab напрямую и не создаёт второй polling.

## Что видно в Team_poker

Для оценённых задач отображаются две независимые группы статусов:

- статус оценки Team_poker: «Оценена», «На переоценку» и т. п.;
- статус исполнения Team_calculator: «В общем пуле», «В спринте»,
  «Выполнена», «Перенесена из…»;
- последняя известная метка GitLab, полученная Team_calculator через
  существующий коннектор.

Статусы обновляются при открытии сессии и затем каждые 15 секунд.

## Изменённые файлы

```text
app.js
calculator-integration-status.js
team-calculator-integration-config.js
styles.css
```

Firestore Rules Team_poker менять не требуется.


## Требуемая версия Team_calculator

Для endpoint `/task-statuses` требуется:

```text
Team_calculator v23.4.28
team_calculator_v23_4_28_delivery_status_api
```

Пакет с ошибочным номером v23.4.24 не использовать.
