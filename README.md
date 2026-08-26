# Aegent

A private messenger where every conversation is genuinely end-to-end encrypted, with an on-device AI agent that can search, retrieve, and act on your own message history — always with your confirmation before anything is sent, forwarded, or shared.

**Live at:** [aegentweb-production-e18e.up.railway.app](https://aegentweb-production-e18e.up.railway.app)
**Repo:** [Afeezee/Aegent](https://github.com/Afeezee/Aegent)
**Android APK:** built from [`build-apk.yml`](.github/workflows/build-apk.yml) on every push to main.

---

## What's in this build

### Messenger
- **1:1 and group conversations**, fully end-to-end encrypted (Curve25519 + XSalsa20-Poly1305 via tweetnacl; groups fan out per recipient).
- **Real-time delivery** over WebSocket, typing indicators, delivered/read receipts (**receipts + presence are user-toggleable, off by default**).
- **Rich media** — photos, videos, documents, voice notes — all encrypted client-side with a fresh per-blob content key before upload; the server sees only opaque bytes.
- **Message actions** — reply, react (quick emoji + long tail), edit, delete-for-everyone, forward with a note, copy — every one delivered as an E2E-encrypted protocol message the server can't read.
- **Contact management** — add by @handle / email / phone / QR / invite link; native phone-contact import on Android via Contact Picker; **save Aegent contact card back to phone** as a vCard.
- **Invites** — QR code, shareable link, native **SMS invite** that prefills your phone's Messages app.
- **Voice notes** — record with waveform + timer, send, play back with scrub. Optional **on-device Whisper transcription** rides along inside the E2E payload (see below).
- **Push notifications** via `@capacitor/local-notifications` for scheduled reminders and backup fires — announces new content without exposing it.
- **Semantic + keyword search across every conversation** (⌘K) with hybrid rerank, chunked embeddings for long messages, and metadata-decorated hits.
- **Dedicated Contacts view** with search + three sort orders (A→Z, recently active, recently added).
- **Onboarding flow**, thoughtful empty states, glassmorphic UI with framer-motion transitions, dark-by-default with light-mode aware.
- **Mobile-responsive** — below 720 px the sidebar and chat pane swap into a single-column layout with a back button; safe-area insets applied so the Android nav bar and notches never clip content.

### AI Agent
Reachable from anywhere via **⌘/Ctrl-J**, the sidebar icon, or the floating button on mobile. Runs entirely on-device by default; when the server has `ANTHROPIC_API_KEY` set, it also drives a real Claude tool-use loop (`/api/agent/turn` is a thin proxy, so the key never enters the client bundle).

**Voice input** — mic button in the agent composer uses the Web Speech API for live-transcribed input (Chrome/Edge/Safari; falls back to typing on Firefox).

**Retrieval tools** (all run silently against your local encrypted store, no confirm needed):

- `search_messages` — hybrid semantic + keyword + gentle recency rerank; filters by peer, sender, media kind, days-ago.
- `search_exact` — verbatim substring for order numbers, links, quoted phrases.
- `search_by_date_range`, `search_by_sender`, `search_by_media_type`, `search_links_and_patterns`.
- `get_thread`, `get_context_around` (N messages surrounding a match), `get_last_message`, `get_message_metadata`.
- `get_unread_count`, `get_shared_media`, `summarize_thread`, `list_reminders`.
- `resolve_target` (fuzzy name → stable id), `contact_profile`.
- `transcribe_voice` — runs on-device Whisper against a voice-note message (see Voice notes below).

**General-assistant tools** — `calculate` (safe arithmetic).

**Write tools** (every one stages a preview card and waits for explicit user confirmation before executing):

- `draft_message`, `reply_to_message`, `forward_message`, `tone_adjust` (read-only rewriter — you confirm the draft it produces).
- `set_reminder` (with optional `tiedToMessageId` so the notification references the source).
- `schedule_message` (send at a chosen time, up to 24 h ahead).
- `mark_thread_read` (immediate).
- `delete_message` (your own messages only, tombstones for everyone).
- `create_calendar_event` (emits a real `.ics` your phone's calendar imports).
- `create_note`.
- `add_contact_by_handle`, `save_contact_to_phone`.
- `export_to_email` (compile arbitrary messages into an email — warns you it leaves E2E).
- `backup_thread` (whole-thread email backup; media referenced by type only, keys stay on device).
- `schedule_backup` (fires the backup at a chosen time via a local scheduled-backup queue).

### Encrypted backup + multi-device sync
- **Automatic**, throttled to ~1× per hour after messages you send.
- **Server stores only opaque bytes.** The key is derived on the client from the identity private key with a distinct KDF context — the same key deterministically re-appears anywhere you log in with your account password.
- **Restore = login.** Signing into the same account on a new device silently pulls the ciphertext blob, decrypts locally with the freshly re-derived key, and rehydrates the local store. No separate recovery-code prompt needed.
- **Manual snapshot** available in Settings → Encrypted Backup → "Back up now".
- **Agent-driven email backup** stays available via `backup_thread` and `schedule_backup` for out-of-band copies to a user-provided email address (that path leaves E2E — the confirm card warns you).

### On-device voice-note transcription
- Opt-in in Settings → Voice Notes → "Transcribe voice notes on this device".
- First send after opting in downloads the quantised `whisper-tiny.en` (~40 MB) into the browser cache.
- Runs entirely in-WebView via ONNX runtime WASM (~24 MB shipped in the APK for offline availability).
- Transcript rides inside the E2E payload → recipients see it too, without needing to run Whisper themselves.
- Transcripts index into the search tokens + embedding so "find the voice note about the invoice" resolves via `search_messages`.
- Agent tool `transcribe_voice(messageId)` for on-demand transcription of voice notes sent before the sender opted in.

### Privacy toggles (Settings)
Every one is off by default:
- Send read receipts.
- Share online / last-seen.
- Transcribe voice notes on this device.

---

## Layout

```
server/
  src/db.ts         Dual-backend storage: Postgres via `pg` when
                    DATABASE_URL is set (production), node:sqlite
                    otherwise (local dev). One async API surface.
  src/auth.ts       Argon2id (hash-wasm) + JWT; handles + phone
                    directory; privacy toggles.
  src/groups.ts     Group membership routing (server only knows the
                    graph; message contents remain E2E).
  src/blobs.ts      Encrypted media blob storage.
  src/backups.ts    Ciphertext-only per-user backup (one row per
                    user; latest overwrites prior).
  src/agent.ts      LLM proxy — /api/agent/turn to Anthropic with
                    ANTHROPIC_API_KEY server-side.
  src/index.ts      HTTP + WebSocket relay; CORS permissive (bearer
                    auth); serves the built SPA in production for
                    single-origin deploys.

web/
  src/lib/
    crypto.ts       tweetnacl primitives; Argon2id KDF; base32
                    recovery code; media content keys;
                    backupKeyFromPrivate.
    protocol.ts     Plaintext payload shapes inside every envelope.
    session.ts      register/login/logout, cloud-restore on login,
                    tickAutoBackup, send helpers.
    store.ts        Dexie/IndexedDB local store, encrypted at rest.
    embeddings.ts   Hashed-bigram embeddings with sliding-window
                    chunk pooling for long messages.
    media.ts        Encrypt→upload / download→decrypt pipeline.
    backup.ts       Snapshot + encrypt + upload; auto-backup queue.
    transcribe.ts   Lazy-loaded @huggingface/transformers
                    Whisper pipeline (opt-in).
    retry.ts        Shared retry+timeout+jittered-backoff for fetch.
    api.ts, socket.ts, contacts-integration.ts, speech.ts

  src/components/
    Chat.tsx, MessageBubble.tsx, Composer.tsx, MediaView.tsx,
    ThreadList.tsx, ComposeOverlay.tsx, GlobalSearch.tsx,
    ForwardSheet.tsx, Contacts.tsx, Settings.tsx, Agent.tsx,
    ui.tsx (Button, Glass, Modal, Toast, Avatar, Icon,
    ErrorBoundary, Stagger, FadeIn).

  src/pages/       Onboarding, Auth, Home.
  src/agent/       tools.ts (34 tools), llm.ts (Claude tool-use loop
                    with schemas), loop.ts (offline planner + LLM
                    dispatch).
  public/          og.svg + og.png, favicon.svg + favicon-32.png +
                    apple-touch-icon.png, index.html meta tags.

android/           Capacitor 8 Android project (com.aegent.app).
  MainActivity.java overrides WebChromeClient.onPermissionRequest
  so mic + camera prompts route through Android's runtime perms.
  AndroidManifest declares RECORD_AUDIO, CAMERA, READ_CONTACTS,
  WRITE_CONTACTS, POST_NOTIFICATIONS, VIBRATE, MODIFY_AUDIO_SETTINGS.

.github/workflows/build-apk.yml
  On every push to main (and manual dispatch): Node 22 + JDK 21 +
  Android SDK 35 → `npm ci` → build web with VITE_API_URL baked in
  → `npx cap sync android` → `./gradlew assembleDebug` → uploads
  the APK as an artifact.
```

---

## Run locally

```bash
npm install
npm run dev
```

Server: `http://localhost:8787`. Web: `http://localhost:5173`.

Open two browser profiles (or one normal + one incognito), register two accounts, add each other by @handle, chat. No Postgres needed for local dev — the server auto-falls-back to `node:sqlite` at `server/data/aegent.db`.

**Keyboard shortcuts**
- `Ctrl/Cmd + K` — global semantic search
- `Ctrl/Cmd + J` — open the agent
- `Ctrl/Cmd + N` — new chat / new group / invite

**Agent examples** (offline or LLM mode)
- `find the voice note about the invoice`
- `who was I talking to about the pricing draft last week?`
- `reply to Ada's last message saying I'm running late`
- `remind me to call Alice tomorrow at 10am`
- `schedule 'On my way' to Alice at 5pm`
- `backup my chat with Ada to me@example.com`
- `email the last three photos from the Design squad group to alice@x.com`
- `what's 314 * 27?`
- `how many unread do I have with Ada?`

---

## Deploy

Full deployment guide in [DEPLOYMENT.md](DEPLOYMENT.md). Summary:

- **Server**: Docker → Railway. Railway Postgres addon provides `DATABASE_URL`; no persistent volume needed. Set `JWT_SECRET` (64 hex chars). Optional: `ANTHROPIC_API_KEY` to enable LLM-mode agent.
- **Web**: served by the same Node process (single-origin), or standalone on any static host with `VITE_API_URL` pointed at the Railway domain at build time.
- **APK**: automatic via GitHub Actions on push; or local `npm run android:sync && cd android && .\gradlew assembleDebug`.

---

## Verifying the E2E claim yourself

After sending a few messages, from the project root:

```bash
sqlite3 server/data/aegent.db "SELECT sender_id, substr(ciphertext,1,60) FROM messages;"
sqlite3 server/data/aegent.db "SELECT id, mime, byte_size FROM blobs;"
sqlite3 server/data/aegent.db "SELECT user_id, byte_size FROM backups;"
```

Every content column is opaque bytes. No key that opens any of them ever transits the server, either at rest or in transit.

---

## Tech decisions and their reasons

- **`node:sqlite`** for local dev — Node 22.5+ ships it built-in; zero native compile step on Windows. Production uses `pg` against a Railway-managed Postgres.
- **`hash-wasm`** for Argon2id — pure WASM, no native compile.
- **`tweetnacl`** for messaging + secretbox — audited, small, works everywhere. Deliberately not MLS yet (see spec §5.1 risk table); the whole crypto module is a single swap point when you're ready to invest in OpenMLS.
- **Backup key from private key** (not from recovery phrase) — makes restore-on-login automatic. Same 128-bit strength; distinct KDF context prevents key leakage across purposes.
- **StrictMode off in dev** — framer-motion's `AnimatePresence mode="wait"` tangles with StrictMode's double-invoke of state setters. Runtime behavior in production is unchanged.
- **On-device Whisper via `@huggingface/transformers`** — audio never leaves the device; opt-in because of the ~40 MB one-time model download.
- **CORS wide-open (bearer auth, not cookies)** so the Capacitor WebView origin (`https://localhost`) can reach the relay. Production should allowlist explicit origins.

---

## Deferred / honest gaps

- **MLS / OpenMLS** — swap when a leaked device shouldn't expose message history. Localized to `web/src/lib/crypto.ts`.
- **Play Store release AAB** — the `assembleRelease` path signs with the debug keystore for sideloadable release APKs, but a real Play submission needs a genuine keystore in CI secrets.
- **Password-forgotten recovery** — currently "lost password = lost account, re-register". Recovery-phrase-based challenge/response is possible but not wired.
- **Whisper accuracy on your specific voice-note traffic** — the pipeline is real and on-device; but only physical-device testing tells you whether `whisper-tiny.en` is good enough or you need to bump to `whisper-base.en` (~140 MB).
