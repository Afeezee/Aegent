/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANTHROPIC_API_KEY?: string;
  // Absolute origin of the Aegent relay. Set at build time when the
  // client is packaged into a native shell (Capacitor APK), where
  // `location.origin` is `capacitor://localhost` and relative /api
  // paths can't reach a remote server. Leave unset for the web deploy
  // where SPA + relay are same-origin.
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
