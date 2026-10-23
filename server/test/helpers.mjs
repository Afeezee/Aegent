// Test harness for the relay.
//
// Boots the real server — same entry point production runs — on an
// ephemeral port against a throwaway SQLite file, then drives it over
// HTTP and socket.io exactly as a client would. Nothing is stubbed: if a
// test passes here, the wire behaviour is the wire behaviour.
//
// Clients are hand-rolled against tweetnacl rather than importing the
// web bundle, so a test can do things a well-behaved client never would
// — which is the only way to prove the server refuses them.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { argon2id } from "hash-wasm";
import { io } from "socket.io-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "../src/index.ts");
// The relay runs from a throwaway directory so its SQLite file is
// isolated, which means it cannot resolve `tsx` by name from there.
// Resolve the loader here, where node_modules is reachable, and hand the
// child an absolute specifier.
const TSX_LOADER = import.meta.resolve("tsx");

export const b64 = {
  encode: (b) => naclUtil.encodeBase64(b),
  decode: (s) => naclUtil.decodeBase64(s),
};

// Each test file gets its own port and its own database, so files can run
// in any order and leave nothing behind.
//
// The port is taken from the OS rather than guessed. `node --test` runs
// each file in its own process, so a per-process random base collides
// across files often enough to matter — and the failure is confusing
// rather than obvious: the loser's relay exits, the winner's answers
// /healthz, and the second file quietly runs its assertions against the
// first file's database.
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startRelay() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "aegent-test-"));
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, ENTRY],
    {
      cwd: dir,
      env: { ...process.env, PORT: String(port), JWT_SECRET: "test-secret", DATABASE_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`relay exited early (${child.exitCode}):\n${logs.join("")}`);
    }
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`relay never came up:\n${logs.join("")}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const sockets = [];
  return {
    base,
    logs: () => logs.join(""),
    track: (s) => { sockets.push(s); return s; },
    async stop() {
      for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
      // Kill the TREE, not the child. `tsx` runs the server in a
      // grandchild, so killing the wrapper leaves a live relay behind —
      // and orphans accumulate across runs until they start interfering
      // with each other, which surfaces as unrelated tests failing with
      // ECONNRESET rather than as anything that points at the cause.
      if (process.platform === "win32") {
        const { spawnSync } = await import("node:child_process");
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      await new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", r);
        setTimeout(r, 3000);
      });
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    },
  };
}

export async function http(relay, path, { method = "GET", body, token } = {}) {
  const r = await fetch(relay.base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: r.status, ok: r.ok, body: json, text };
}

// A registered account with usable identity keys. The wrapped private key
// is real, so a test can log the account in again if it needs to.
export async function register(relay, name) {
  const id = nacl.box.keyPair();
  const salt = nacl.randomBytes(16);
  const password = `${name} password 123`;
  const wrapKey = await argon2id({
    password: `priv-wrap:${password}`, salt,
    iterations: 3, memorySize: 65536, parallelism: 1,
    hashLength: 32, outputType: "binary",
  });
  const nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(id.secretKey, nonce, wrapKey);
  const wrapped = new Uint8Array(nonce.length + ct.length);
  wrapped.set(nonce); wrapped.set(ct, nonce.length);

  const email = `${name}-${Date.now().toString(36)}@test.local`;
  const r = await http(relay, "/api/register", {
    method: "POST",
    body: {
      email,
      displayName: name, password,
      publicKey: b64.encode(id.publicKey),
      wrappedPriv: b64.encode(wrapped),
      kdfSalt: b64.encode(salt),
      deviceLabel: "test",
    },
  });
  if (!r.ok) throw new Error(`register ${name} failed: ${r.text}`);
  return {
    name, password, email,
    id: r.body.user.id,
    handle: r.body.handle ?? r.body.user.handle,
    token: r.body.token,
    pub: id.publicKey,
    priv: id.secretKey,
  };
}

export function connect(relay, token) {
  return new Promise((res, rej) => {
    const s = io(relay.base, { auth: { token }, transports: ["websocket"] });
    s.on("connect", () => res(relay.track(s)));
    s.on("connect_error", rej);
  });
}

// Emit `send` and resolve with the server's ack.
export function emitSend(socket, payload) {
  return new Promise((res) => socket.emit("send", payload, res));
}

// Resolve with the first `event` seen within `ms`, or null if none came.
// Proving the server stays SILENT needs this as much as proving it speaks.
export function waitForEvent(socket, event, ms = 400) {
  return new Promise((res) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); res(null); }, ms);
    const onEvent = (payload) => { clearTimeout(timer); socket.off(event, onEvent); res(payload); };
    socket.on(event, onEvent);
  });
}

// An opaque ciphertext of the right shape. Content is irrelevant to the
// server, which is the point.
export function sealTo(text, peerPub, myPriv) {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(new TextEncoder().encode(text), nonce, peerPub, myPriv);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce); out.set(ct, nonce.length);
  return b64.encode(out);
}
