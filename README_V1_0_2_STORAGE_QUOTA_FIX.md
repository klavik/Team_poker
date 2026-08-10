# Team_poker v1.0.2

Исправление переполнения browser storage / Firestore cache.

Симптом:

```text
QuotaExceededError:
Failed to execute 'setItem' on 'Storage'

FIRESTORE INTERNAL ASSERTION FAILED
```

Причина:
Team_poker по умолчанию использовал `persistentLocalCache` +
`persistentMultipleTabManager`. Firestore shared-client state и
pending mutations использовали browser storage, который в браузере
пользователя достиг quota.

Исправление:
- по умолчанию используется `memoryLocalCache()`;
- persistent cache включается только при явном
  `enablePersistentCache: true`;
- realtime Firestore и сетевое чтение продолжают работать;
- бизнес-логика приложения не изменялась.

После установки v1.0.2 рекомендуется один раз очистить site data
для `klavik.github.io`, чтобы удалить уже накопленные старые ключи
Firestore из Local Storage / IndexedDB.
