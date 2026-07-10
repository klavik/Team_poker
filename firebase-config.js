window.PLANNING_POKER_CONFIG = {
  // Вставьте объект из:
  // Firebase Console → Project settings → General → Your apps → SDK setup and configuration
  firebaseConfig: {
  apiKey: "AIzaSyC2iYEhvlG6Nih1_KBqu5LDfCweMV2SUms",
  authDomain: "team-poker-6c06f.firebaseapp.com",
  projectId: "team-poker-6c06f",
  storageBucket: "team-poker-6c06f.firebasestorage.app",
  messagingSenderId: "690324680961",
  appId: "1:690324680961:web:f85ae8ebaf3bb1d103ab00"
  },

  // Для Planning Poker достаточно базы (default).
  firestoreDatabaseId: "(default)",

  // Сохранять кэш Firestore в браузере между перезапусками.
  enablePersistentCache: true
};
