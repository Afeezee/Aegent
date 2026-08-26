// On-device Whisper transcription for voice notes.
//
// Runs entirely in the browser / WebView — audio bytes never leave
// the device, consistent with the rest of Aegent's privacy model.
//
// Cost: the first call downloads the ONNX-quantised Whisper model
// from Hugging Face (~40 MB for whisper-tiny.en, ~75 MB for the
// multilingual whisper-tiny) into the browser's cache API and then
// stays there. Subsequent calls load in ~2 seconds.
//
// Everything is lazy-imported so users who never opt in to
// transcription don't pay the transformers.js bundle cost at all.
//
// Not a Web Worker for tonight — main thread is warm enough for
// voice-note-length clips (<60 s). If we ship auto-transcribe by
// default later, wrap in a worker so long clips don't hitch the UI.

const DEFAULT_MODEL = "onnx-community/whisper-tiny.en";
const TARGET_SAMPLE_RATE = 16000;

type ProgressCb = (info: { status: string; progress?: number; file?: string; total?: number; loaded?: number }) => void;

// Cached pipeline instance — one-time load per session, model bytes
// come from the HTTP cache after the very first download.
type Pipe = Awaited<ReturnType<typeof loadPipeline>>;
let PIPELINE: Pipe | null = null;
let LOADING: Promise<Pipe> | null = null;

async function loadPipeline(onProgress?: ProgressCb) {
  const { pipeline, env } = await import("@huggingface/transformers");
  // Prefer local cache; never let it write to disk beyond what the
  // browser cache API already does.
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // The ONNX runtime WASM ships in the APK bundle (~24 MB) so
  // transcription still works when the user is offline after their
  // one-time model download. If APK size ever becomes a blocker,
  // switch to a CDN by setting env.backends.onnx.wasm.wasmPaths.
  return pipeline("automatic-speech-recognition", DEFAULT_MODEL, {
    progress_callback: onProgress,
    // dtype="q8" keeps model ~40 MB instead of ~120 MB for float32.
    dtype: "q8",
  });
}

export function isModelCached(): boolean {
  // Best-effort check — the transformers cache uses the Cache API
  // under the key "transformers-cache". If it's present, model likely
  // already downloaded.
  try {
    if (typeof caches === "undefined") return false;
    // Can't synchronously peek at the cache; call site should treat
    // this as "unknown, expect a possibly-long first call".
    return PIPELINE !== null;
  } catch { return false; }
}

// Transcribe raw audio bytes. Accepts anything decodeAudioData can
// parse (WebM/Opus from MediaRecorder is the primary path).
export async function transcribeAudio(
  bytes: Uint8Array,
  opts: { language?: string; onProgress?: ProgressCb } = {},
): Promise<{ text: string; durationMs: number }> {
  // Load pipeline (cached after first call).
  if (!PIPELINE) {
    if (!LOADING) LOADING = loadPipeline(opts.onProgress);
    PIPELINE = await LOADING;
    LOADING = null;
  }
  if (!PIPELINE) throw new Error("pipeline_load_failed");

  // Decode + resample audio to mono Float32 at 16 kHz.
  const t0 = performance.now();
  const audio = await decodeToMono16k(bytes);

  // English-only model (`whisper-tiny.en`) ignores the language arg;
  // the multilingual variants use it. Kept in the call signature so
  // switching models later is a one-line change.
  const result = await PIPELINE(audio, opts.language ? { language: opts.language } : {}) as { text?: string } | Array<{ text?: string }>;
  const text = Array.isArray(result)
    ? result.map((r) => r.text ?? "").join(" ").trim()
    : (result.text ?? "").trim();
  return { text, durationMs: performance.now() - t0 };
}

// ---- audio decode + resample ----

async function decodeToMono16k(bytes: Uint8Array): Promise<Float32Array> {
  // Try an AudioContext at the target rate — most browsers oblige
  // and skip the resample step. Safari sometimes ignores the hint
  // and we resample manually below.
  const AudioCtxCtor: typeof AudioContext =
    (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  let ctx: AudioContext;
  try {
    ctx = new AudioCtxCtor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    ctx = new AudioCtxCtor();
  }

  // decodeAudioData expects a copy — WebKit is strict about detached buffers.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = await ctx.decodeAudioData(buf as ArrayBuffer);

  // Down-mix to mono if needed.
  let mono: Float32Array;
  if (decoded.numberOfChannels === 1) {
    mono = decoded.getChannelData(0);
  } else {
    const len = decoded.length;
    mono = new Float32Array(len);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) mono[i] += data[i];
    }
    for (let i = 0; i < len; i++) mono[i] /= decoded.numberOfChannels;
  }

  // Resample if the AudioContext ignored our sample-rate hint.
  const src = mono;
  const srcRate = decoded.sampleRate;
  if (srcRate === TARGET_SAMPLE_RATE) { ctx.close?.(); return src; }
  const ratio = TARGET_SAMPLE_RATE / srcRate;
  const dstLen = Math.floor(src.length * ratio);
  const dst = new Float32Array(dstLen);
  // Linear interpolation is fine for STT — Whisper's model itself
  // is robust to modest resampling artifacts. Cubic wouldn't
  // meaningfully improve WER for voice-note-length clips.
  for (let i = 0; i < dstLen; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1);
    const t = x - i0;
    dst[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  ctx.close?.();
  return dst;
}
