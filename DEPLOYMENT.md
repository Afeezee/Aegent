# Deploying Aegent

Aegent is two deployables:

1. **Relay server** — a long-running Node process with a WebSocket, an HTTP API, and a small SQLite DB. Needs a persistent disk for the DB and blob storage.
2. **Web client** — a static SPA (`web/dist`) that talks to the relay over HTTPS + WSS.

The E2E guarantee is unchanged in production: the relay never sees plaintext. The two things you *must* get right when going live are (a) protect the server's `JWT_SECRET`, and (b) give the SQLite DB a real persistent volume (not an ephemeral container filesystem).

---

## Pre-flight checklist

- [ ] Set a real `JWT_SECRET` (64+ random bytes) — never leave it as `dev-only-do-not-use-in-production`.
- [ ] Confirm HTTPS + WSS everywhere. The client uses the browser's `crypto`, `WebSocket`, and `IndexedDB` APIs which require a secure context.
- [ ] Configure CORS on the relay for exactly your web origin (see "Locking down CORS" below).
- [ ] Give the SQLite DB a **persistent** volume mount at `server/data/`. Ephemeral disks lose every message on restart.
- [ ] Decide blob storage strategy — the default keeps encrypted media bytes inside SQLite. Fine to a few GB; migrate to object storage above that (S3, R2, GCS). Blobs are already opaque ciphertext, so any bucket works.
- [ ] Set up backups of `server/data/aegent.db` — regular snapshots to a private bucket. Backups only contain ciphertext.
- [ ] If you're enabling LLM mode later, use a zero-data-retention Anthropic endpoint (per spec §5.2 / §8).

---

## Environment variables

**Relay (`server/`)**

```
PORT=8787                             # any port; the platform usually sets this
JWT_SECRET=<64+ random bytes>         # required. openssl rand -hex 64
```

The relay reads `PORT` and `JWT_SECRET` at startup. That's it — no other secrets. The DB path is fixed to `data/aegent.db` under the process CWD; mount your persistent volume there.

**Web (`web/`)**

```
VITE_ANTHROPIC_API_KEY=<optional>     # only if you're enabling LLM agent mode
```

`VITE_*` values are compiled into the bundle at build time — treat them as public. Never put server-only secrets in a `VITE_` variable.

At runtime the web client talks to the relay at:
- `location.origin` in production (same origin as the SPA)
- `http://localhost:8787` in dev

If you host the SPA on a different origin from the relay, edit [web/src/lib/socket.ts](web/src/lib/socket.ts) and [web/vite.config.ts](web/vite.config.ts) to point at your relay host, and update the CORS config on the server.

---

## Build

```bash
npm install
npm run build          # builds both server and web
```

Outputs:

- `server/dist/index.js` — compiled relay
- `web/dist/` — static SPA (index.html + hashed assets)

The relay starts with `npm run start -w server`, which runs `node dist/index.js`. It needs Node **22.5+** because it uses the built-in `node:sqlite`.

---

## Option A — Simple single-VM deploy (recommended for a first launch)

Best for pilots and closed-circle rollouts (the spec's "small closed circle" first-user strategy).

Any small Linux VM (a $5 droplet is enough for hundreds of users). One process serves both the SPA and the relay.

**1. Serve the SPA from the same origin as the relay.** Add this near the top of [server/src/index.ts](server/src/index.ts):

```ts
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(resolve(__dirname, "../../web/dist")));
app.get(/^(?!\/(api|socket\.io)).*/, (_req, res) => {
  res.sendFile(resolve(__dirname, "../../web/dist/index.html"));
});
```

Then the client's `location.origin` for the WebSocket is correct out of the box.

**2. Run it under a supervisor.** systemd example (`/etc/systemd/system/aegent.service`):

```ini
[Unit]
Description=Aegent relay
After=network.target

[Service]
WorkingDirectory=/opt/aegent/server
ExecStart=/usr/bin/node dist/index.js
Environment=PORT=8787
EnvironmentFile=/etc/aegent.env
Restart=always
RestartSec=3
User=aegent
Group=aegent

[Install]
WantedBy=multi-user.target
```

`/etc/aegent.env` (mode 0600, owned by `aegent`):

```
JWT_SECRET=<paste the openssl output>
```

**3. Front with Caddy or nginx for HTTPS + WebSocket upgrade.** Caddy is one-liner tidy:

```
aegent.example.com {
  reverse_proxy localhost:8787
}
```

Caddy automatically upgrades `/socket.io` because it's a normal HTTP upgrade — nothing special needed. It also fetches a Let's Encrypt cert on first request.

nginx equivalent:

```nginx
server {
  server_name aegent.example.com;
  listen 443 ssl;
  # ssl_certificate + ssl_certificate_key from certbot ...

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
    client_max_body_size 25m;              # >= MAX_BLOB_BYTES + slack
  }
}
```

**4. Persistent SQLite.** The service writes to `/opt/aegent/server/data/aegent.db`. Snapshot it nightly:

```bash
# /etc/cron.daily/aegent-backup
sqlite3 /opt/aegent/server/data/aegent.db ".backup /var/backups/aegent-$(date +%F).db"
```

Rotate + copy off-box to a private bucket. Backups are ciphertext only, so any bucket works.

---

## Option B — Split hosting (Vercel + Railway/Fly)

Recommended when the SPA needs a CDN or you want zero-ops for the frontend. Matches the tech stack in the product spec.

### Web SPA → Vercel

```
cd web
npx vercel deploy --prod
```

`vercel.json` (put in `web/`):

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Set the relay origin at build time by editing [web/src/lib/socket.ts](web/src/lib/socket.ts) to point at your Railway/Fly hostname, or add an `import.meta.env.VITE_RELAY_URL` and read from there.

### Relay → Railway or Fly.io

**Railway** (easiest — one click deploy from the GitHub repo):

1. New project → Deploy from GitHub → pick `Afeezee/Aegent`.
2. Root directory: `server`.
3. Build command: `npm install && npm run build`.
4. Start command: `node dist/index.js`.
5. Add a **Volume** mounted at `/app/server/data` (or wherever your working directory is) — this is where SQLite lives.
6. Variables: `JWT_SECRET=<openssl rand -hex 64>`.
7. Note the generated `*.up.railway.app` hostname; paste that into the web client's `VITE_RELAY_URL` and redeploy the SPA.

**Fly.io** (equivalent, with a `Dockerfile` — see below).

### Locking down CORS

For split hosting you must whitelist the web origin. In [server/src/index.ts](server/src/index.ts) replace:

```ts
app.use(cors());
```

with:

```ts
const allowed = new Set([process.env.WEB_ORIGIN ?? "http://localhost:5173"]);
app.use(cors({ origin: (o, cb) => cb(null, !o || allowed.has(o)) }));
io.engine.opts.cors = { origin: [...allowed], credentials: false };
```

And set `WEB_ORIGIN=https://your-aegent.vercel.app` on the relay.

---

## Option C — Docker (either target)

```dockerfile
# Dockerfile at repo root
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json
WORKDIR /app/server
ENV PORT=8787
VOLUME ["/app/server/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
```

If you use the single-origin serve pattern from Option A, one image serves both SPA and relay. Otherwise strip the `web/dist` COPY and deploy the SPA separately.

---

## First-launch runbook

1. `openssl rand -hex 64` → store as `JWT_SECRET` in your platform's secrets.
2. Provision persistent storage for `server/data/`.
3. `npm install && npm run build`.
4. Start the relay. Watch logs for `[aegent] relay listening on http://localhost:PORT`.
5. Open the SPA URL in a browser. You should see onboarding.
6. Register two accounts in two different browser profiles (or one normal + one incognito).
7. Search each other by @handle and chat.
8. **Verify E2E on the server**:

   ```bash
   sqlite3 /path/to/aegent.db "SELECT sender_id, substr(ciphertext,1,60) FROM messages LIMIT 5;"
   ```

   Every row's ciphertext is opaque. That's the proof the server is not a plaintext participant.

---

## Post-launch operational hygiene

- **Rotate `JWT_SECRET` carefully.** Doing so invalidates every existing session — users have to re-login (unlocking their private key from their password + `wrappedPriv`). This is fine, but announce it.
- **Never log ciphertext or DB rows in production.** They're opaque bytes, but you should still not expose them to log aggregation you don't control.
- **Blob table growth.** Media blobs live in `blobs`. Add a retention policy (e.g. delete blobs older than 90 days with no referring message) once you're above a couple GB.
- **Rate limiting.** For a public-facing deployment add `express-rate-limit` on `/api/register`, `/api/login`, and `/api/blobs`.
- **CSP.** Once behind a real domain, set a Content-Security-Policy header from your reverse proxy. Aegent doesn't load anything external at runtime, so `default-src 'self'; connect-src 'self' wss://<host>;` is enough.

---

## Things you deliberately do NOT need to do

- Configure a mail server or SMTP — email export uses `mailto:` from the user's own client.
- Provision a separate key server or KMS — key material never leaves the device.
- Set up Firebase / APNs to see message content in notifications — the payload is deliberately content-less ("New encrypted message"), which is a feature not a bug.

---

## Upgrades

Aegent's `crypto.ts` is a single-file API surface. Two upgrade paths matter:

- **MLS via OpenMLS**: swap the primitives in `web/src/lib/crypto.ts`. Callers stay the same.
- **Zero-retention LLM agent**: fill in `runWithClaude` in `web/src/agent/loop.ts`; the tool set is already defined and confirm-gated.

Both are scoped and can ship without touching UI or database code.
