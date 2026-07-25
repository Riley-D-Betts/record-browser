export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', 'nuxt-auth-utils', '@vueuse/nuxt'],

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // Overridable via NUXT_DATABASE_PATH
    databasePath: '.data/record-browser.db',
    session: {
      // Overridable via NUXT_SESSION_PASSWORD (required, >= 32 chars)
      password: '',
    },
    public: {
      appName: 'Technical Records Browser',
    },
  },

  nitro: {
    // better-sqlite3 is a native addon; keep it out of the bundle.
    externals: {
      external: ['better-sqlite3'],
    },
  },

  typescript: {
    strict: true,
  },
})
