# Planning Poker + Supabase

Статическое приложение для GitHub Pages. Команды, участники, сессии, задачи и голоса хранятся в Supabase.

## 1. Создайте проект Supabase

1. Откройте Supabase и создайте проект.
2. Дождитесь завершения инициализации базы.
3. Откройте **SQL Editor**.
4. Вставьте содержимое `supabase_setup.sql`.
5. Выполните скрипт целиком.

## 2. Настройте вход по почте

В Supabase откройте:

**Authentication → URL Configuration**

Укажите:

- **Site URL** — адрес приложения на GitHub Pages.
- **Redirect URLs** — тот же полный адрес приложения.

Пример:

```text
https://USERNAME.github.io/REPOSITORY/
```

Вход выполняется через Magic Link на email.

## 3. Заполните config.js

В Supabase откройте:

**Project Settings → API**

Скопируйте:

- Project URL;
- Publishable key.

Вставьте их в `config.js`:

```javascript
window.APP_CONFIG = {
  supabaseUrl: "https://PROJECT.supabase.co",
  supabasePublishableKey: "sb_publishable_..."
};
```

Никогда не помещайте в HTML или `config.js` ключ `service_role`.

## 4. Опубликуйте на GitHub Pages

Положите в корень репозитория:

```text
index.html
config.js
```

Файл `supabase_setup.sql` на сайте не требуется. Его можно оставить в репозитории или удалить после настройки.

Затем:

1. Repository → Settings → Pages.
2. Source: **Deploy from a branch**.
3. Branch: `main`.
4. Folder: `/root`.
5. Откройте выданный GitHub Pages URL.

## Как пользоваться

1. Тимлид входит по рабочей почте.
2. Создаёт команду.
3. Добавляет участников по email.
4. Участники входят по тем же email.
5. Тимлид создаёт сессию и добавляет задачи.
6. Тимлид открывает голосование.
7. Каждый участник голосует со своего компьютера.
8. Тимлид раскрывает оценки.
9. При необходимости запускает новый раунд.
10. Фиксирует итоговую оценку и копирует `/estimate Nd` для GitLab.

## Доступы

- Тимлид может управлять командой, сессиями и задачами.
- Участник может просматривать свои команды и голосовать.
- Значения чужих голосов недоступны через API до раскрытия оценок.
- Доступ ограничен политиками Row Level Security.

## Важно

Состав команды определяется по email. Участник должен войти именно под тем адресом, который тимлид добавил в команду.
