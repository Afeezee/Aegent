import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // Reverse-DNS bundle id. Must match what you sign the release with;
  // change only if you're deploying to Play Store under a different
  // org, since the id is what Play uses to identify the app forever.
  appId: "com.aegent.app",
  appName: "Aegent",

  // The Vite build output — Capacitor packages everything under this
  // folder into the APK as the WebView's assets.
  webDir: "dist",

  // No `server.url` — the WebView loads the bundled SPA from disk. The
  // client's api.ts / socket.ts point at the Railway origin via
  // VITE_API_URL at build time, so all HTTP + WS traffic goes there.
  // (Setting server.url would ship a shell that streams your web app
  // over the network — fine for hot-reload dev, wrong for release.)

  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 800,
      backgroundColor: "#05070d",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      // Match the app's dark aurora background.
      style: "DARK",
      backgroundColor: "#05070d",
      overlaysWebView: false,
    },
    Keyboard: {
      // Ionic-style resize so the composer stays visible above the keyboard.
      resize: "native",
      style: "DARK",
      resizeOnFullScreen: true,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_icon_config_sample",
      iconColor: "#8A7DFF",
    },
  },

  android: {
    // Allow http/https to the Railway origin. Mixed-content is off; the
    // Railway domain terminates TLS so we're always on https anyway.
    allowMixedContent: false,
    // Route back-button hardware key through the WebView so React's
    // history-driven back behavior wins.
    backgroundColor: "#05070d",
  },
};

export default config;
