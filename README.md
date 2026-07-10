# Planning Poker: GitHub Pages + Firebase

В проекте используются:

- Firebase Authentication — вход по email и паролю;
- Cloud Firestore — команды, участники, сессии, задачи и голоса;
- GitHub Pages — публикация статического приложения.

Письма, Magic Link и собственный backend не используются.

## Файлы

```text
index.html
styles.css
firebase-config.js
app.js
firestore.rules
README.md
```

## 1. Создайте проект Firebase

1. Откройте Firebase Console.
2. Нажмите **Create a project**.
3. Google Analytics для Planning Poker можно не подключать.
4. На странице проекта нажмите значок **Web** `</>`.
5. Зарегистрируйте веб-приложение.
6. Firebase покажет объект `firebaseConfig` — он понадобится позже.

## 2. Включите Authentication

Откройте:

```text
Build → Authentication → Get started
```

Затем:

```text
Sign-in method → Email/Password → Enable
```

Email link включать не нужно.

Добавьте домен GitHub Pages:

```text
Authentication → Settings → Authorized domains
```

Например:

```text
klavik.github.io
```

## 3. Создайте пользователей

Откройте:

```text
Authentication → Users → Add user
```

Для каждого участника укажите:

```text
Email
Password
```

Приложение не содержит самостоятельной регистрации и не отправляет письма.

Пользователь Firebase Auth и участник команды Planning Poker связываются по одинаковому email.

## 4. Создайте Cloud Firestore

Откройте:

```text
Build → Firestore Database → Create database
```

Выберите:

```text
Production mode
```

Выберите ближайший регион. Регион после создания базы изменить нельзя.

## 5. Установите Security Rules

1. Откройте `firestore.rules`.
2. Скопируйте весь файл.
3. В Firebase Console откройте:

```text
Firestore Database → Rules
```

4. Замените текущие правила.
5. Нажмите **Publish**.

Правила обеспечивают:

- пользователь видит только свои команды;
- тимлид управляет командой, сессиями и задачами;
- участник может голосовать;
- до раскрытия участники видят только факт голосования, но не чужие оценки;
- после раскрытия оценки доступны всей команде.

## 6. Заполните firebase-config.js

Откройте:

```text
Project settings → General → Your apps
```

Выберите веб-приложение и найдите:

```text
SDK setup and configuration → Config
```

Скопируйте значения в `firebase-config.js`.

Пример:

```javascript
window.PLANNING_POKER_CONFIG = {
  firebaseConfig: {
    apiKey: "AIza...",
    authDomain: "project-id.firebaseapp.com",
    projectId: "project-id",
    storageBucket: "project-id.firebasestorage.app",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef"
  },

  firestoreDatabaseId: "(default)",
  enablePersistentCache: true
};
```

Firebase Web API key не является серверным секретом. Доступ к данным ограничивается Authentication и Firestore Security Rules.

## 7. Опубликуйте на GitHub Pages

Загрузите в корень репозитория:

```text
index.html
styles.css
firebase-config.js
app.js
```

Файлы `README.md` и `firestore.rules` публиковать необязательно.

В GitHub откройте:

```text
Repository → Settings → Pages
```

Выберите:

```text
Deploy from a branch
Branch: main
Folder: /root
```

После deployment выполните жесткое обновление:

```text
macOS: Cmd + Shift + R
Windows: Ctrl + F5
```

## 8. Первый вход

1. Войдите под пользователем, созданным в Firebase Authentication.
2. Создайте команду.
3. Создатель автоматически станет тимлидом.
4. Добавьте участников команды по их email.
5. Эти email должны совпадать с Firebase Authentication.

## Смена пароля

Пользователь вводит:

```text
текущий пароль
новый пароль
повтор нового пароля
```

Приложение выполняет повторную аутентификацию текущим паролем и только после этого меняет пароль. Письма не используются.

## Устойчивость соединения

Cloud Firestore работает через realtime-подписки и автоматически восстанавливает соединение.

В приложении включён постоянный локальный кэш:

- ранее открытые данные доступны при кратковременном сбое;
- локальные изменения отправляются после восстановления сети;
- всплывающие окна `Failed to fetch` не используются.

Кэш содержит рабочие данные команды на устройстве пользователя. Используйте приложение на доверенных компьютерах.

## Структура Firestore

```text
teams/{teamId}
  members/{email}
  sessions/{sessionId}
    issues/{issueId}
      votes/{round_userId}
      vote_status/{round_userId}
```

`vote_status` хранит только факт голосования. Значение оценки хранится отдельно в `votes` и закрыто правилами до раскрытия.

## Удаление

Firestore не удаляет вложенные коллекции автоматически. Приложение выполняет каскадное удаление самостоятельно:

- команда → участники, сессии, задачи, голоса;
- сессия → задачи и голоса;
- задача → голоса и статусы голосования.

Для ожидаемого небольшого объёма Planning Poker этого достаточно.
