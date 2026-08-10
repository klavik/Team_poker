# Team_poker — обновление статусов без GitLab + фильтры

## Кнопка «Обновить статусы»

Кнопка создаёт запрос:

```text
teams/{teamId}/delivery_status_refresh/{requestId}
```

metadata_connector v1.4.8 обрабатывает его так:

```text
Team_poker
  → refresh_delivery_status
  → metadata_connector
  → чтение Team_calculator/taskPool
  → обновление Team_poker/delivery_status
```

GitLab API в этом пути не вызывается.

## Фильтры

В разделах «Активные» и «Оценённые» есть независимые фильтры
по `GitLab statusLabel`.

Доступны:

- все реально загруженные статусы;
- «Все статусы GitLab»;
- «Статус не указан».

Массовая кнопка «Выбрать все» учитывает фильтр активных задач.

## Деплой Team_poker

Заменить:

```text
index.html
app.js
styles.css
firestore.rules
```

Firestore Rules обязательно опубликовать.

## Mac connector

Заменить:

```text
metadata_connector.py
```

config.json не менялся.

После замены перезапустить connector.
