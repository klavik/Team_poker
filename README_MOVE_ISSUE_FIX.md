# Team_poker — исправление переноса задачи

## Симптом

Диалог переноса открывался, целевая сессия выбиралась, но нажатие кнопки
«Перенести» ничего не делало.

## Причина

В `bindEvents()` отсутствовал обработчик для кнопки:

```text
confirmMoveIssueBtn
```

Функция `moveIssueToSession()` существовала, но никогда не вызывалась.

## Исправление

Добавлена регистрация обработчика:

```javascript
$("confirmMoveIssueBtn").addEventListener(
  "click",
  moveIssueToSession
);
```

## Установка

Заменить только:

```text
app.js
```

Firestore Rules, `index.html` и `styles.css` менять не требуется.

После публикации:

```text
Cmd + Shift + R
```
