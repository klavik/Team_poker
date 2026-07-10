window.APP_CONFIG = {
  // Supabase Dashboard → Project Settings → API
  supabaseUrl: "https://bhtotueoyxprvzwbjrkd.supabase.co",

  // Используйте только Publishable key (sb_publishable_...).
  // Никогда не размещайте здесь service_role или secret key.
  supabasePublishableKey: "sb_publishable_tN-ME_eGEnfiM2OTon-d0g_-_6RGpp7",

  // Настройки устойчивости сети.
  requestTimeoutMs: 15000,
  requestRetries: 3,
  retryBaseDelayMs: 700,

  // Фоновое обновление данных, миллисекунды.
  pollIntervalMs: 30000
};
