// Application configuration (Step 2d.0). One place for deployment-dependent constants.
// PRODUCTION_HOST: the hostname of the real app (decision G1). Cloudflare now deploys static assets to
// workers.dev, so that is the primary address. PRODUCTION_HOST_ALIASES are other exact hostnames that are
// equally "the app" (the Pages address, should it ever be used).
// LOCAL_DEV_HOSTS: exact loopback hostnames for local desktop development (isolated browser origin and
// localStorage — never shares storage with the production origin).
// Any other host is a preview build (2a S0): logging allowed, import and restore blocked (2d.1).
// Matching is exact — no wildcards.
export const PRODUCTION_HOST = 'gymlog-tal.talyanai012.workers.dev';
export const PRODUCTION_HOST_ALIASES = Object.freeze(['gymlog-tal.pages.dev']);
export const LOCAL_DEV_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
export const isProductionHost = (hostname) => hostname === PRODUCTION_HOST || PRODUCTION_HOST_ALIASES.includes(hostname);
export const isLocalDevHost = (hostname) => LOCAL_DEV_HOSTS.includes(hostname);
export const APP_VERSION = '2.0.0';
export const SEED_URL = './seed-defaults.json';
export const INPUT_DEBOUNCE_MS = 700; // starting value; tuned from the 2d.8 browser measurements
