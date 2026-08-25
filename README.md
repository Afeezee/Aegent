# Aegent

A private messenger where every conversation is genuinely end-to-end encrypted, with an on-device agent that can search, retrieve, and act on your own message history — always with your confirmation before anything is sent, forwarded, or shared.

## What's in this build

**Messenger**
- 1:1 and group conversations, fully end-to-end encrypted (fan-out per recipient)
- Real-time delivery over WebSocket; typing indicators
- Read receipts, presence, and "last seen" — user-toggleable, **off by default**
- Rich media: photos, videos, documents, and voice notes — encrypted with a fresh content key before they leave the device, opaque bytes at rest on the server
- Message actions: reply, react (quick emoji), edit, delete-for-everyone, forward with a note, copy
- Contact management: search by name / @handle / email · QR-code invite · shareable invite link · deep-link handler at `#/i/:handle`
- Groups: create with member picker, name, per-member fan-out
- Push notifications (browser Notification API) — announces new messages without ever revealing content
- Semantic + keyword search **across every conversation** (Cmd/Ctrl-K), and a per-thread jump result
- Reminders that trigger a browser notification when they come due

**Agent (reachable from anywhere via the floating button or Ctrl-J)**
- `search_messages` · `get_thread` · `draft_message` · `forward_message` · `set_reminder` · `export_to_email` · `list_reminders`
- Every *write* action returns a preview card and waits for explicit **Confirm** — send, forward, reminder, or email
- Email export explicitly warns that it leaves the E2E boundary
- Runs entirely on-device; a zero-retention LLM endpoint scaffold is present but off by default

**Design**
- Glassmorphic surfaces throughout (frosted panels, soft depth, live ambient gradient with drift animation)
- Motion via framer-motion: staggered thread list, spring-eased bubbles, animated confirm cards, tab transitions
- Cohesive component system: `Glass`, `Button`, `Modal`, `Avatar`, `Icon`, `Toast`, `Stagger` — one design language across every screen
- 3-card first-run onboarding, skippable, remembered
- Thoughtful empty states everywhere (no chats yet, empty thread, no search hits, offline agent hints)
- Dark by default, light-mode aware
- Mobile-responsive: below 720px the sidebar and chat pane swap into a single-column layout with a Back button

## Layout

```
server/           Node + Socket.io ciphertext relay
  src/db.ts       schema — ciphertext + public directory only
  src/auth.ts     Argon2id (hash-wasm), JWT sessions, handles, privacy toggles
  src/groups.ts   membership routing
  src/blobs.ts    encrypted media blob store
  src/index.ts    HTTP + WS endpoints
web/              Vite + React + TS client
  src/lib/
    crypto.ts     tweetnacl (Curve25519 + XSalsa20-Poly1305), Argon2id KDF,
                  base32 recovery code, media content keys
    protocol.ts   plaintext payload types inside every envelope
    session.ts    register / login / send / receive orchestration
    store.ts      encrypted-at-rest local store (Dexie/IndexedDB)
    embeddings.ts on-device hashed-bigram semantic vectors
    media.ts      encrypt→upload / download→decrypt pipeline
    api.ts, socket.ts
  src/components/ ui.tsx, Chat, MessageBubble, Composer, MediaView,
                  ThreadList, ComposeOverlay, GlobalSearch, ForwardSheet,
                  Settings, Agent
  src/pages/      Onboarding, Auth, Home
  src/agent/      tools.ts, loop.ts (offline planner + LLM scaffold)
```

## Android APK

Aegent ships as a native Android app via Capacitor. The web codebase is
reused as-is inside a native WebView, and native APIs (contacts, share
sheet, local notifications, camera, haptics) are exposed through
Capacitor plugins.

**Get the latest APK** — either from GitHub Actions (last successful
run under Actions → "Android APK" → `aegent-apk` artifact) or, when a
tag is published, from the Releases page.

**Build locally** (needs Android Studio or the Android command-line
tools + JDK 21):

```bash
cd web
# One-time: generate the Android project (already committed, but this
# is how you regenerate after wiping android/).
npm run android:sync
# Then either open in Android Studio and hit Run, or from the command line:
cd android
./gradlew assembleDebug
# APK lands at android/app/build/outputs/apk/debug/app-debug.apk
```

**Build via GitHub Actions** — every push to `main` runs
`.github/workflows/android.yml`, which builds a debug APK pointed at
your Railway relay and uploads it as a downloadable artifact. Change
`DEFAULT_API_URL` in that file to your Railway domain.

**Point the APK at your relay** — the native shell has no origin of
its own, so the client needs an absolute URL at build time:

```bash
# for local builds
VITE_API_URL=https://your-app.up.railway.app npm run android:sync
# for CI, edit .github/workflows/android.yml's DEFAULT_API_URL
```

**Sharing the APK** — copy the file to Google Drive / Dropbox / a
Release, share the link, recipient enables "Install from unknown
sources" once and taps it. For Play Store distribution you'll need a
signed release build and a keystore — see the DEPLOYMENT guide.

## Run it

```bash
cd "C:\Users\DELL\Aegent Messanger"
npm install
npm run dev
```

Open `http://localhost:5173` in two different browser profiles, register two accounts, add each other by @handle in the sidebar search, and chat.

**Keyboard shortcuts**
- `Ctrl/Cmd + K` — global semantic search
- `Ctrl/Cmd + J` — open the agent
- `Ctrl/Cmd + N` — new chat / new group / invite

**Agent, examples that work in offline mode**
- `find the chat about the payment project`
- `remind me to call Alice tomorrow at 10am`
- `send Alice that I'm on my way`
- `forward that to bob saying "for your reference"`
- `email a copy to me@example.com about invoices`

## Verifying the E2E claim

After sending a few messages, from the project root:

```bash
sqlite3 server/data/aegent.db "SELECT sender_id, recipient_id, group_id, length(ciphertext) FROM messages;"
```

Every `ciphertext` is base64 of `nonce || nacl.box(...)`. Blob table:

```bash
sqlite3 server/data/aegent.db "SELECT id, mime, byte_size FROM blobs;"
```

Blob bytes are `nonce || nacl.secretbox(plaintext, contentKey)`. The `contentKey` is delivered inside an already-encrypted envelope; the server never sees it. Try `SELECT ciphertext FROM messages;` — every row is opaque.

## Deliberate deferrals (called out in the code where they matter)

- **Crypto primitive**: tweetnacl + Argon2id today, not MLS. The `crypto.ts` module is the single API surface; the OpenMLS swap is localized to that file.
- **LLM mode**: scaffolded (`web/src/agent/loop.ts::runWithClaude`) but points back at the offline planner. Wire it to a zero-retention endpoint per spec §5.2 / §8.
- **QR scan**: QR-generate for the invite works; scanning is future work (native mobile camera pipeline).
- **Auth**: self-contained email/password. Swap in Clerk when ready.
- **Multi-device sync of the local index**: not in this cut; the store is per-device.

## Tech decisions and their reasons

- **`node:sqlite`** for the server DB — Node 22.5+ has SQLite built in, so nothing native to build on Windows.
- **`hash-wasm`** for Argon2id — pure WASM, no native compile step.
- **`tweetnacl`** for messaging + secretbox — audited, small, works everywhere, no ESM resolution grief.
- **Base32 recovery code** instead of BIP-39 words — same 128-bit strength, no 2048-word dictionary to ship; production would prefer words for typo tolerance.
- **StrictMode off in dev** — framer-motion's `AnimatePresence mode="wait"` tangles with StrictMode's double-invoke of state setters and leaves overlays stuck. Off in dev only; runtime behavior is unchanged in production.
