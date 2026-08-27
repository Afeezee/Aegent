// On-device Whisper transcription for voice notes.
//
// Runs entirely in the browser / WebView — audio bytes never leave
// the device, consistent with the rest of Aegent's privacy model.
//
// Every step is wrapped in a try/catch that re-throws a tagged
// error so the failing step is visible in the surface (toast /
// chrome://inspect console) instead of a bare "transcription
// failed".
//
// Steps:
//   1. `loadPipeline`     — pull the Whisper model from Hugging Face
//                            (first call only; cached in browser cache API).
//   2. `decodeToMono16k`  — decodeAudioData → mono → 16 kHz Float32.
//   3. `pipeline(audio)`  — run the model.

const DEFAULT_MODEL = "onnx-community/whisper-tiny.en";
const TARGET_SAMPLE_RATE = 16000;

type ProgressCb = (info: { status: string; progress?: number; file?: string; total?: number; loaded?: number }) => void;

type Pipe = Awaited<ReturnType<typeof loadPipeline>>;
let PIPELINE: Pipe | null = null;
let LOADING: Promise<Pipe> | null = null;

class TranscribeError extends Error {
  constructor(public step: string, cause: unknown) {
    super(`${step}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "TranscribeError";
  }
}

async function loadPipeline(onProgress?: ProgressCb) {
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // dtype: previously set to "q8" for a smaller (~40 MB) model, but
    // the ONNX runtime shipped with @huggingface/transformers 4.x
    // rejects some q8-quantised whisper checkpoints with
    // "Missing required scale ... embed_tokens.weight_merged_0_scale".
    // Fall back to fp32 (~150 MB one-time download, then browser
    // cache). If a specific device pulls down bandwidth is tight,
    // switch encoder to q4 and decoder to fp32 which is the mixed
    // combo transformers.js recommends for Whisper — but we'd need to
    // verify against the same runtime version first.
    return await pipeline("automatic-speech-recognition", DEFAULT_MODEL, {
      progress_callback: onProgress,
      dtype: "fp32",
    });
  } catch (e) {
    throw new TranscribeError("model_load", e);
  }
}

export function isModelCached(): boolean {
  return PIPELINE !== null;
}

// Transcribe raw audio bytes. Accepts anything decodeAudioData can
// parse (WebM/Opus from MediaRecorder is the primary path).
export async function transcribeAudio(
  bytes: Uint8Array,
  opts: { language?: string; onProgress?: ProgressCb } = {},
): Promise<{ text: string; durationMs: number }> {
  const t0 = performance.now();

  // 1. Load / reuse pipeline.
  if (!PIPELINE) {
    if (!LOADING) LOADING = loadPipeline(opts.onProgress);
    try {
      PIPELINE = await LOADING;
    } catch (e) {
      LOADING = null;
      throw e; // already tagged
    }
    LOADING = null;
  }
  if (!PIPELINE) throw new TranscribeError("pipeline_missing", "pipeline object was null after load");

  // 2. Decode + resample audio.
  let audio: Float32Array;
  try {
    audio = await decodeToMono16k(bytes);
  } catch (e) {
    throw new TranscribeError("audio_decode", e);
  }
  if (audio.length < TARGET_SAMPLE_RATE / 2) {
    // < 0.5 s — Whisper hallucinates on very short clips. Bail early.
    throw new TranscribeError("audio_too_short", `${(audio.length / TARGET_SAMPLE_RATE).toFixed(2)} s`);
  }

  // 3. Run.
  try {
    const result = await PIPELINE(audio, opts.language ? { language: opts.language } : {}) as { text?: string } | Array<{ text?: string }>;
    const text = Array.isArray(result)
      ? result.map((r) => r.text ?? "").join(" ").trim()
      : (result.text ?? "").trim();
    return { text, durationMs: performance.now() - t0 };
  } catch (e) {
    throw new TranscribeError("inference", e);
  }
}

// ---- audio decode + resample ----

async function decodeToMono16k(bytes: Uint8Array): Promise<Float32Array> {
  const AudioCtxCtor: typeof AudioContext =
    (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  if (!AudioCtxCtor) throw new Error("AudioContext unavailable in this WebView");

  // Some Android WebViews refuse an explicit sampleRate hint and
  // throw NotSupportedError. Retry with default rate + manual
  // resample below.
  let ctx: AudioContext;
  try { ctx = new AudioCtxCtor({ sampleRate: TARGET_SAMPLE_RATE }); }
  catch { ctx = new AudioCtxCtor(); }

  // decodeAudioData mutates the ArrayBuffer on some engines; hand it
  // a fresh copy so upstream retries aren't broken.
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(copy as ArrayBuffer);
  } catch (e) {
    ctx.close?.();
    // Common cause on Android: WebM/Opus with codec metadata the
    // WebView's decoder rejects. Report the media type + first
    // bytes so debug logs can identify the format.
    const head = Array.from(bytes.slice(0, 8)).map((n) => n.toString(16).padStart(2, "0")).join(" ");
    throw new Error(`decodeAudioData failed (${(e as Error).message}); first bytes: ${head}`);
  }

  // Down-mix to mono.
  const src = decoded.numberOfChannels === 1
    ? decoded.getChannelData(0)
    : mixdownMono(decoded);

  const srcRate = decoded.sampleRate;
  ctx.close?.();
  if (srcRate === TARGET_SAMPLE_RATE) return src;

  // Manual linear resample.
  const ratio = TARGET_SAMPLE_RATE / srcRate;
  const dstLen = Math.floor(src.length * ratio);
  const dst = new Float32Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1);
    const t = x - i0;
    dst[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return dst;
}

function mixdownMono(buf: AudioBuffer): Float32Array {
  const len = buf.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  const div = buf.numberOfChannels;
  for (let i = 0; i < len; i++) out[i] /= div;
  return out;
}
