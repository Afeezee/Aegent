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

export async function uploadMedia(picked: PickedMedia): Promise<MediaRef> {
  const key = newContentKey();
  const encrypted = secretBoxSealBytes(key, picked.bytes);
  const { id, size } = await api.uploadBlob(encrypted, "application/octet-stream");
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

export async function pickFile(file: File): Promise<PickedMedia> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = kindOf(file.type, file.name);
  const base: PickedMedia = { bytes: buf, mime: file.type || "application/octet-stream", kind, filename: file.name };
  if (kind === "image") {
    try {
      const { width, height } = await imageDimensions(file);
      base.width = width; base.height = height;
    } catch { /* ignore */ }
  }
  return base;
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
