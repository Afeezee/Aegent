// Media send / receive pipeline.
//
// Send:
//   1. Read the picked file / recorded blob into bytes.
//   2. Generate a fresh 32-byte content key.
//   3. Encrypt bytes with nacl.secretbox(contentKey).
//   4. Upload ciphertext to /api/blobs → get { id, size }.
//   5. Return a MediaRef holding blobId + contentKey (base64) + metadata.
//      The MediaRef is placed inside a `media` protocol payload and
//      encrypted per-recipient like any other message.
//
// Receive:
//   1. Recipient decrypts the envelope, gets MediaRef.
//   2. Fetches ciphertext bytes from /api/blobs/:id.
//   3. Decrypts with the content key from the ref.
//   4. Wraps into an ObjectURL for local rendering.

import { api } from "./api.js";
import {
  b64,
  newContentKey,
  secretBoxOpenBytes,
  secretBoxSealBytes,
} from "./crypto.js";
import type { MediaRef } from "./store.js";

export type PickedMedia = {
  bytes: Uint8Array;
  mime: string;
  kind: MediaRef["kind"];
  filename?: string;
  durationMs?: number;
  width?: number;
  height?: number;
};

export async function uploadMedia(
  picked: PickedMedia,
  onProgress?: (fraction: number) => void,
): Promise<MediaRef> {
  const key = newContentKey();
  const encrypted = secretBoxSealBytes(key, picked.bytes);
  const { id, size } = await api.uploadBlob(encrypted, "application/octet-stream", onProgress);
  return {
    kind: picked.kind,
    blobId: id,
    mime: picked.mime,
    byteSize: size,
    durationMs: picked.durationMs,
    width: picked.width,
    height: picked.height,
    filename: picked.filename,
    contentKey: b64.encode(key),
  };
}

// In-memory cache so re-renders don't re-download / re-decrypt.
const OBJECT_URLS = new Map<string, string>();

// Drop a decrypted object URL.
//
// The cache is keyed by blob id and was never evicted, which is fine for
// chat media the user keeps — but a diary entry that expires has to take
// its decrypted bytes with it. Deleting the row while the ObjectURL
// still resolves would be cleanup in name only.
export function revokeObjectUrlFor(blobId: string): void {
  const url = OBJECT_URLS.get(blobId);
  if (!url) return;
  OBJECT_URLS.delete(blobId);
  try { URL.revokeObjectURL(url); } catch { /* already gone */ }
}

export async function objectUrlFor(ref: MediaRef): Promise<string> {
  const cacheKey = ref.blobId;
  const hit = OBJECT_URLS.get(cacheKey);
  if (hit) return hit;
  const ciphertext = await api.downloadBlob(ref.blobId);
  const plaintext = secretBoxOpenBytes(b64.decode(ref.contentKey), ciphertext);
  const blob = new Blob([plaintext as BlobPart], { type: ref.mime });
  const url = URL.createObjectURL(blob);
  OBJECT_URLS.set(cacheKey, url);
  return url;
}

// Convenience helpers for common inputs.

// Above this, a photo is worth re-encoding before upload. Below it the
// compression overhead isn't worth it (already small).
const COMPRESS_IMAGE_OVER_BYTES = 350 * 1024;
const MAX_IMAGE_EDGE = 1600;      // long-edge cap for sent photos
const IMAGE_QUALITY = 0.82;

export async function pickFile(file: File): Promise<PickedMedia> {
  const mime = file.type || guessMimeFromName(file.name) || "application/octet-stream";
  const kind = kindOf(mime, file.name);
  const filename = sanitizeFilename(file.name, mime);

  // Low-bandwidth win: shrink large photos before they're encrypted and
  // uploaded. A 6 MB phone photo becomes ~150-400 KB, which is the
  // difference between an instant send and a minute of waiting on a
  // weak connection. GIFs are left alone (re-encoding would kill the
  // animation); PNGs with transparency and everything non-image pass
  // through untouched.
  if (kind === "image" && mime !== "image/gif" && file.size > COMPRESS_IMAGE_OVER_BYTES) {
    try {
      const compressed = await compressImage(file, MAX_IMAGE_EDGE, IMAGE_QUALITY);
      if (compressed && compressed.bytes.byteLength < file.size) {
        return {
          bytes: compressed.bytes, mime: "image/jpeg", kind: "image",
          filename: swapExt(filename, "jpg"),
          width: compressed.width, height: compressed.height,
        };
      }
    } catch { /* fall through to the original bytes */ }
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const base: PickedMedia = { bytes: buf, mime, kind, filename };
  if (kind === "image") {
    try {
      const { width, height } = await imageDimensions(file);
      base.width = width; base.height = height;
    } catch { /* ignore */ }
  }
  return base;
}

// Draw the image onto a canvas scaled so its long edge is <= maxEdge,
// then export JPEG. Returns null if the browser can't decode it.
async function compressImage(file: File, maxEdge: number, quality: number):
  Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close?.(); return null; }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

function swapExt(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + "." + ext;
}

// Some Android WebView flavours hand back a File object whose `name`
// is the calling process (`chrome.exe`, `webview_shell.exe`) instead
// of the real filename — an old Chromium bug that surfaces when the
// file provider strips the path. Sanitize: if the name matches a
// known-junk pattern, or has an executable extension we would never
// actually want to send from a picker, replace with a MIME-derived
// fallback ("document.pdf", "photo.jpg", …).
function sanitizeFilename(name: string, mime: string): string {
  const junk = /^(chrome|webview|firefox|edge|browser)\.(exe|apk|com)$/i;
  const executable = /\.(exe|com|bat|cmd|dll|scr|msi)$/i;
  const stripped = (name || "").trim();
  const bad = !stripped || junk.test(stripped) || executable.test(stripped);
  if (bad) return fallbackNameFor(mime);
  // Also strip any path separators — some pickers slip in "/storage/..."
  return stripped.split(/[/\\]/).pop() || fallbackNameFor(mime);
}

function fallbackNameFor(mime: string): string {
  const base = mime.startsWith("image/") ? "photo"
    : mime.startsWith("video/") ? "video"
    : mime.startsWith("audio/") ? "audio"
    : mime === "application/pdf" ? "document"
    : "file";
  const ext = extForMime(mime);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  return `${base}-${stamp}${ext}`;
}

function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/heic": ".heic", "image/heif": ".heif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/webm": ".webm", "audio/ogg": ".ogg",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md",
    "application/json": ".json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  };
  return map[mime] ?? "";
}

// When a File comes through without a MIME (again, some Android
// pickers), try to guess from the extension of whatever name we DID
// get. Better than "application/octet-stream" for the LLM downstream.
function guessMimeFromName(name: string): string | undefined {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(name);
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext];
}

function kindOf(mime: string, name: string): MediaRef["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return name.toLowerCase().includes("voice") ? "voice" : "audio";
  return "file";
}

function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image_load_failed")); };
    img.src = url;
  });
}
