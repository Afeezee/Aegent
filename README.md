# Aegent

A private messenger where every conversation is genuinely end-to-end encrypted — with a long-form **Diary** your contacts see for a day and you keep forever, a public **Discover** feed to meet people beyond your contacts, real **groups** with admin control, an always-there history that follows you to any device, and an on-device AI agent that searches and acts on your own messages, always with your confirmation and never without your consent.

**Live at:** [aegent.onrender.com](https://aegent.cereustechnologies.com)
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
- **Push wake-ups** via FCM: a frozen, backgrounded app is woken by a content-free notification ("New encrypted message") that carries no plaintext — it only tells the app to sync. Local notifications still drive scheduled reminders. (FCM is active only when the relay has `FCM_SERVICE_ACCOUNT` set.)
- **Messages always read in true time order** — the relay stores each message's authored time (clamped, never re-dated by backfill), so sent and received interleave correctly across reloads, re-sync and device change.
- **Semantic + keyword search across every conversation** (⌘K) with hybrid rerank, chunked embeddings for long messages, and metadata-decorated hits.
- **Dedicated Contacts view** with search + three sort orders (A→Z, recently active, recently added).
- **Onboarding flow**, thoughtful empty states, glassmorphic UI with framer-motion transitions, dark-by-default with light-mode aware.
- **Mobile-responsive** — below 720 px the sidebar and chat pane swap into a single-column layout with a back button; safe-area insets applied so the Android nav bar and notches never clip content.

### AI Agent
Reachable from anywhere via **⌘/Ctrl-J**, the sidebar icon, or the floating button on mobile. Runs entirely on-device by default; when the server has `ANTHROPIC_API_KEY` set, it also drives a real Claude tool-use loop (`/api/agent/turn` is a thin proxy, so the key never enters the client bundle).

**Consent and transparency.** The first time you tap the agent it explains, in plain language, that asking it sends only the messages it needs to the AI — and waits for you to turn it on. Every reply carries a "Used N messages ▸" line that expands to exactly what left your phone. Its retrieval is **scope-enforced**, not prompted: it can't read a group whose assistant is switched off, filtered at the data layer rather than trusted to the model. Agent transcripts are sealed at rest like messages.

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

### Diary
A long-form daily page — an upgrade on disappearing "status".
- **You keep it forever; your contacts read each entry for 24 hours.** Expiry is cryptographic, not a flag: each entry is sealed once with a per-entry key, and every viewer holds that key sealed to them with a 24h grant. At expiry the relay deletes the *grant*, so the ciphertext — and diary images, which are ACL-gated the same way — can't be served to them again.
- **Genuine formatting, no markup characters** — a WYSIWYG editor (heading, bold, italics, quote, list, alignment) that stores Markdown and renders it; you never see raw `**stars**`.
- **Multiple images per entry** — a swipeable, zoomable carousel (side-by-side on wide screens), up to 8 photos.
- **Per-entry visibility** — share with contacts, keep an entry just for yourself, or make it **Public** so it also appears in Discover.
- **Reactions and private replies** ride the normal message rail straight to the author (nothing a viewer writes is visible to another viewer, so there's nothing to moderate), plus view counts — names only for viewers who send read receipts.
- **Your own archive is searchable by the agent** and restores on a new device from a bare login.

### Discover
A public feed built from diary entries their authors chose to make public — a way to meet people beyond your contacts.
- **Explicit opt-in per entry.** A post reaches Discover only when the author picks **Public**; it's one of a single image, a voice note, or up to **500 characters** of text (links allowed).
- **Separate from the private path by design.** A public entry keeps its normal end-to-end-sealed diary copy (contacts still read it the encrypted way); the Discover copy is a *separate* cleartext row — "public" and "E2E-sealed to specific keys" are contradictory, so public content honestly leaves the envelope and nothing else is weakened.
- **Slide into DMs.** "Message" on any card auto-adds a non-contact (pulling only their public key, exactly like adding a contact) and opens a **normal end-to-end encrypted** chat — the discovery is public, the conversation is sealed.

### Translation
- **Tap Translate** on any message or voice-note transcript to read it in your language, powered by Google Translate.
- **Never automatic.** Only the message you tap is sent to the service, and the target language lives in Settings. Like email backup, this one trip leaves E2E — and the first use says so.

### Groups
Real groups, enforced at the relay — not just in the UI.
- **Roles** (owner / admin / member); the owner can't be removed, demoted, muted or banned.
- **Invite links** (hashed tokens, with expiry and use limits), **join requests**, and join modes: closed / invite / request.
- **Moderation** — mute (time-boxed), remove, ban; posting policy (everyone / admins only) enforced on the socket path.
- **History on join** — admins choose whether a new member sees everything or only messages from when they joined. Implemented as key distribution over a per-epoch archive rail (removing someone rotates the epoch), so "show history" is a real cryptographic grant, not a server flag.
- **In-group agent, off by default** — switch it on per group and every member sees a "🤖 assistant on" badge; the agent's retrieval is scoped so it can only read groups where it's enabled.

### Always-there history (backup + multi-device sync)
- **Nothing is ever lost.** Every message is replicated to the relay as ciphertext as it's sent; the server's message log — not local storage — is the source of truth. A continuous replication loop drains, reconciles and re-uploads on a timer and on every reconnect.
- **Reconciliation by id.** The client compares the exact set of envelope ids the relay holds against its own ledger and fetches precisely what's missing, so a new or wiped device rebuilds the entire account — and "N messages still syncing" means exactly N, never a phantom.
- **Restore = login.** Sign into the same account anywhere and your whole history comes back; the encryption key is re-derived from the password, so there's nothing to carry.
- **Recovery key.** Your password is your key; an optional recovery key (opt-in from Settings) resets a forgotten password **without losing a single message** — the identity key is wrapped under both, so re-wrapping one never orphans your history.
- **Server stores only opaque bytes** throughout.
- **Agent-driven email backup** stays available via `backup_thread` and `schedule_backup` for out-of-band copies (that path leaves E2E — the confirm card warns you).

### On-device voice-note transcription
- Opt-in in Settings → Voice Notes → "Transcribe voice notes on this device".
- First send after opting in downloads the quantised `whisper-tiny.en` (~40 MB) into the browser cache.
- Runs entirely in-WebView via ONNX runtime WASM (~24 MB shipped in the APK for offline availability).
- Transcript rides inside the E2E payload → recipients see it too, without needing to run Whisper themselves.
- Transcripts index into the search tokens + embedding so "find the voice note about the invoice" resolves via `search_messages`.
- Agent tool `transcribe_voice(messageId)` for on-demand transcription of voice notes sent before the sender opted in.

### Privacy toggles (Settings)
Off by default; each description reflects the toggle's current state ("On: contacts can see when you've opened their messages", etc.):
- Send read receipts.
- Share online / last-seen.
- Transcribe voice notes on this device.
- **Account keys** — view/rotate your recovery key, change your password (re-wraps the identity key without re-encrypting anything).

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

## Security posture (what's fixed, what's accepted, what's deferred)

An external QA pass in Nov 2026 produced a 23-point audit. The findings landed as a prioritised fix plan; this section documents the end state so the trade-offs are explicit rather than hidden in a git log.

### Fixed in the current build

**Account containment**
- **Recovery evicts every pre-reset session.** `applyNewPassword` bumps a per-user `security_version` and hard-revokes every outstanding refresh token. Every JWT carries its issue-time `sv`; the authed middleware rejects tokens whose `sv` is below the user's current value. So within one request round-trip of a recovery (or password change, or sign-out-everywhere), stale access tokens are dead — no "stale 15-minute window" survives.
- **Ordinary logout revokes server-side.** `POST /api/logout` walks the refresh-token rotation chain and revokes the head, so a credential captured just before logout stops working at the relay. The client fires this with `keepalive: true` before wiping localStorage, so a page close doesn't skip it.

**Message integrity**
- **Edits are author-bound.** Incoming `edit` payloads whose envelope sender doesn't match the message's own author are dropped with a warn log. Same guard already existed for `delete` and `transcript`; now consistent across every op that mutates an existing row.
- **Duplicate-id replays are refused.** Incoming `text`/`media` payloads whose `msgId` collides with an existing row written by a different sender are dropped (same-sender collisions still pass through as the normal self-echo dedupe). Dexie's `.put()` upsert can no longer be used to overwrite someone else's message.

**Search + translation correctness**
- **Edits refresh the search index.** `applyEdit` now re-tokenises + re-embeds the new body, so an edited message is findable by its new wording from the next search (not its pre-edit tokens).
- **Edits clear the translation cache.** No more stale pre-edit translation surfacing on the next render.
- **Non-Latin scripts tokenise.** `tokenize()` uses `\p{L}\p{N}` with the `/u` flag — Arabic, Chinese, Japanese, Korean, Devanagari, Cyrillic, Thai, Hebrew all index cleanly. CJK uses a 1-char minimum (each char is a token); everything else uses the old 2-char minimum.

**Transport + browser hardening**
- **Security headers** on every response: `Content-Security-Policy` (scripts `'self'` only; `frame-ancestors 'none'` closes clickjacking regardless of the browser's storage-partitioning behaviour), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **Cache-Control: no-store** on every `/api/*` response except `/api/blobs/*` (blobs are content-addressed and effectively immutable, so caching them is safe and desirable).

**Directory privacy**
- **Handle / phone / id lookups don't leak email or phone.** `GET /api/users/by-handle/:h`, `by-phone/:p`, `/api/users/:id` return `email: ""` and `phone: null` when the lookup resolves to someone OTHER than the caller. `by-email/:e` still echoes the email (the caller already knows it). `POST /api/users/lookup-phones` echoes the phone + email back because the caller supplied the phone (their own contact list).

**Agent quota + checkout**
- **Agent quota counts user messages**, not every tool round-trip. One question with three tools = one of 10/day.
- **PayPal / Paystack errors are translated to actionable prose** inline in the agent chat. Capture preflight catches the "closed the approve tab too early" case with a clear retry message instead of a mute "cancelled".

**UX polish from the same pass**
- **Modal focus trap.** Tab / Shift+Tab stays inside the dialog; Escape closes; focus restores to the triggering element on close.
- **Form labels associated** with inputs via `htmlFor` / `id` — label click focuses the field; screen readers pair them correctly.
- **Session ID stays stable across refresh rotations.** `/api/sessions` returns both the current head `id` AND the chain-root `chainId`. Clients that need to say "this device" compare against `chainId`, so a background refresh doesn't break the labelling.
- **Attachment size shown is the plaintext size**, not ciphertext (subtract 40 bytes of nacl.secretbox overhead).
- **Profile edits that don't touch the status-expiry preserve it** — a name-only edit used to silently clear a one-hour expiry; now `statusUntil` is omitted from the PATCH unless the user actually touched the selector.

### Accepted trade-offs (documented, not bugs)

These behaviours surfaced in the audit and the design decision stays: history availability outranks the local-storage reduction they'd each give you.

- **Message search tokens + translation cache + contact/group metadata survive logout** in the local Dexie store. On sign-in, the password-derived key unseals the archive and you're back where you were without a server round-trip. Sign out on a shared device by signing out of the device itself; don't rely on an app-level logout to erase your chat history.
- **Attachment content keys live in the local store** so a receiver can still open an attachment offline after a message is decrypted. Same availability bias; same guidance about shared devices.
- **The identity private key is wrapped by the Argon2id-derived key**. The *wrapped* bytes sit in localStorage; the *unwrapped* key only lives in memory after unlock, torn down on tab close.
- **Any authenticated user can fetch any attachment blob by exact id** (`/api/blobs/:id`). Blobs are encrypted with the per-blob content key that only the message recipients hold, so the raw ciphertext is useless to a random fetcher. Closing the gap "properly" would need a blob-to-message binding the current encryption model doesn't expose server-side. The code comment in `server/src/blobs.ts` calls this out explicitly; the id is a UUID, not a sequential counter, so enumeration is infeasible.

### Deferred (real but bigger than one PR)

- **JWT access/refresh in localStorage (XSS exposure).** CSP from this pass blunts the practical risk, but the belt-and-braces fix is HttpOnly cookies with CSRF defences. That's a proper refactor — Capacitor WebView origin handling, cookie-domain story across environments, and a CSRF token rail — not a one-line swap.
- **Blob-recipient binding.** Same story as above — would reshape the capability model; deferred rather than hacked.
- **OpenMLS / forward secrecy.** Still the right production target. Localised to `web/src/lib/crypto.ts`.

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
- **Forgotten-password recovery** — done: an opt-in recovery key resets the password without losing history. Lose both the password *and* the recovery key and history is still unrecoverable by design (the relay never holds a key).
- **Rate limiting** — only the agent proxy is throttled; registration, sends and the recovery-challenge endpoint are not yet.
- **Blob GC / quota** — no TTL or reference counting on media blobs yet; storage grows unbounded.
- **iOS** — Capacitor is wired for Android only.
- **Signing keys** — group-archive attribution is server-attested (the live rail's is cryptographic); admin message-delete and cryptographic archive authorship wait on an identity signing key.
- **Whisper accuracy on your specific voice-note traffic** — the pipeline is real and on-device; but only physical-device testing tells you whether `whisper-tiny.en` is good enough or you need to bump to `whisper-base.en` (~140 MB).
