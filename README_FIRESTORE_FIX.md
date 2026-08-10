# Исправление инициализации Firestore

## Ошибка

В браузере появлялось:

```text
FirebaseError: initializeFirestore() has already been called with different options
```

## Причина

`app.js` сначала создавал Firebase App, затем ожидал `setPersistence()` для
Firebase Auth. Пока выполнялся `await`, модуль GitLab-интеграции успевал
вызвать `getFirestore()` и инициализировать Firestore с настройками по
умолчанию.

После этого основной `app.js` пытался вызвать `initializeFirestore()` с
persistent local cache, что приводило к конфликту разных настроек.

## Исправление

Firestore теперь инициализируется синхронно до первого `await`.

## Установка

Достаточно заменить:

```text
app.js
```

Остальные файлы менять не требуется.

После публикации:

```text
Cmd + Shift + R
```

При необходимости очистите данные сайта в браузере.
