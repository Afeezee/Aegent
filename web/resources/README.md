# App icon & splash sources

The 1024×1024 `icon.png` here is the source that `@capacitor/assets`
scales into every Android density (mipmap-mdpi through mipmap-xxxhdpi)
plus the Play Store 512×512.

To regenerate everything after touching `web/public/favicon.svg`:

```bash
cd web
npm run og:build      # renders icon.png / icon-foreground.png from favicon.svg
npm run android:assets   # runs @capacitor/assets, writing android/app/src/main/res/mipmap-*
npm run android:sync     # rebuilds the web bundle and copies it into the Android project
```

If you swap in a completely different icon later, keep it 1024×1024 with
a **transparent or solid** background — Android's adaptive icons crop to
a circle / squircle and expect a safe 66% zone in the middle.
