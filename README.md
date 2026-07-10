# Planning Poker + Supabase

Полностью статическое приложение для GitHub Pages.

Данные команд, участников, сессий, задач, раундов и голосов хранятся в Supabase.
Вход и смена пароля работают без писем.

## Состав

```text
index.html
styles.css
config.js
retry-fetch.js
app.js
supabase_setup.sql
```

## 1. Создайте или очистите проект Supabase

Откройте:

```text
Supabase Dashboard → SQL Editor → New query
```

Вставьте содержимое `supabase_setup.sql` и нажмите **Run**.

После выполнения в **Table Editor** должны появиться:

```text
teams
team_members
sessions
issues
votes
```

Если вы уже запускали старую версию SQL, новый скрипт можно выполнить повторно.
Он использует `create table if not exists`, `create or replace function` и пересоздаёт политики.

## 2. Настройте авторизацию без писем

Откройте настройки Email provider:

```text
Authentication → Providers → Email
```

Настройте:

```text
Allow new users to sign up: OFF
Confirm email: можно оставить ON
Secure password change / Require current password: ON
```

Критически важно включить **Secure password change / Require current password**.
Тогда Supabase проверит поле `current_password` при смене пароля.

Пользователей создавайте вручную:

```text
Authentication → Users → Add user → Create new user
```

Укажите:

```text
Email
Password
Auto Confirm User: ON
```

Не выбирайте отправку приглашения: приложение не использует письма.

## 3. Заполните config.js

Откройте:

```text
Supabase Dashboard → Project Settings → API
```

Скопируйте:

```text
Project URL
Publishable key
```

Вставьте в `config.js`:

```javascript
window.APP_CONFIG = {
  supabaseUrl: "https://PROJECT_REF.supabase.co",
  supabasePublishableKey: "sb_publishable_...",

  requestTimeoutMs: 15000,
  requestRetries: 3,
  retryBaseDelayMs: 700,
  pollIntervalMs: 30000
};
```

Не используйте:

```text
service_role
secret key
пароль базы
connection string
```

Publishable key допустимо размещать в браузерном приложении. Доступ к данным ограничивается RLS-политиками из SQL-файла.

## 4. Опубликуйте на GitHub Pages

Загрузите в корень репозитория:

```text
index.html
styles.css
config.js
retry-fetch.js
app.js
```

Затем откройте:

```text
Repository → Settings → Pages
```

Выберите:

```text
Deploy from a branch
Branch: main
Folder: /root
```

Для входа по паролю Site URL и Redirect URL настраивать не требуется: приложение не использует Magic Link и OAuth.

## 5. Первый вход

1. Создайте себя в `Authentication → Users`.
2. Откройте приложение и войдите по email и паролю.
3. Создайте команду.
4. Создатель команды автоматически становится тимлидом.
5. Добавьте участников по тем же email, под которыми они созданы в Supabase Auth.

## Возможности

- сохранённые команды;
- роли тимлида и участника;
- создание и удаление команд;
- создание, завершение и удаление сессий;
- очередь задач;
- удаление задач;
- скрытое голосование;
- раскрытие результатов;
- несколько раундов;
- итоговая оценка;
- команда GitLab `/estimate Nd`;
- смена пароля с проверкой текущего;
- автоматические повторы сетевых запросов;
- неблокирующие сообщения вместо `Failed to fetch`;
- фоновое обновление раз в 30 секунд;
- ручная кнопка обновления.

## Поведение при нестабильном Supabase

`retry-fetch.js` повторяет безопасные запросы до трёх раз.

Обычные INSERT-запросы намеренно не повторяются автоматически, чтобы случайно не создать дубликаты. При таком сбое приложение покажет сообщение, после чего действие можно повторить вручную.

## Обновление старой версии

Замените все старые frontend-файлы новыми:

```text
index.html
styles.css
config.js
retry-fetch.js
app.js
```

Удалите старый `network-hotfix.js`: новая версия в нём не нуждается.

После загрузки дождитесь успешного workflow в GitHub Actions и выполните жёсткое обновление:

```text
macOS: Cmd + Shift + R
Windows: Ctrl + F5
```
