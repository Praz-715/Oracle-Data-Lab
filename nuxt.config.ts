// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // Operations console: no SEO needs, every view talks to live Oracle data
  // through the server API, so render client-side only.
  ssr: false,

  modules: ['motion-v/nuxt', '@nuxt/icon', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  components: [{ path: '~/components', pathPrefix: true }],

  app: {
    head: {
      title: 'OracleDB Data Lab',
      htmlAttrs: { lang: 'en' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      script: [
        {
          // Apply the stored theme before first paint to avoid a light/dark flash.
          innerHTML:
            "try{var t=localStorage.getItem('odl-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}",
          tagPosition: 'head',
        },
      ],
    },
    pageTransition: false,
  },

  icon: {
    serverBundle: { collections: ['lucide'] },
    clientBundle: { scan: true },
  },

  runtimeConfig: {
    // All values are server-only. Override with NUXT_* env vars or .env (see .env.example).
    labSecret: '',
    oracle: {
      driverMode: 'thin', // thin | thick
      clientLibDir: '',
      configDir: '',
      poolMax: 8,
      poolMin: 0,
      poolTimeout: 60,
      callTimeoutMs: 120000,
    },
    limits: {
      maxConcurrency: 32,
      maxBenchmarkSeconds: 1800,
      heavyConcurrencyThreshold: 8,
      maxBatchSize: 20000,
      maxRows: 100000000,
      maxConcurrentJobs: 2,
      maxExtensionTables: 300,
    },
    public: {
      appName: 'OracleDB Data Lab',
    },
  },

  nitro: {
    storage: {
      lab: { driver: 'fs', base: './.data/lab' },
    },
    // oracledb loads optional native binaries at runtime; keep it external.
    externals: { external: ['oracledb'] },
  },

  typescript: {
    strict: true,
  },
})
