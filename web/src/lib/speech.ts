// Speech-to-text for the agent composer.
//
// Uses the browser's built-in `SpeechRecognition` (vendor-prefixed on
// Safari as `webkitSpeechRecognition`). Streams interim transcripts as
// the user speaks so the composer can show live text, then commits the
// final transcript on stop.
//
// Support today: Chrome/Edge (all platforms), Safari (iOS + macOS),
// Samsung Internet. Firefox has no implementation. When unsupported,
// isSpeechSupported() returns false and the UI hides the mic button.

type MinimalRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { results: SpeechRecognitionResultList; resultIndex: number }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function ctor(): (new () => MinimalRecognition) | null {
  const g = window as unknown as {
    SpeechRecognition?: new () => MinimalRecognition;
    webkitSpeechRecognition?: new () => MinimalRecognition;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return ctor() !== null;
}

export type SpeechSession = {
  stop: () => void;         // graceful stop — final transcript emitted
  abort: () => void;        // immediate stop — no final transcript
};

export type SpeechCallbacks = {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  lang?: string;            // default: browser language
};

// Start listening. Returns a handle you can stop/abort.
export function startSpeech(cb: SpeechCallbacks): SpeechSession | null {
  const Ctor = ctor();
  if (!Ctor) { cb.onError?.("speech recognition not supported in this browser"); return null; }
  const rec = new Ctor();
  rec.lang = cb.lang ?? navigator.language ?? "en-US";
  rec.continuous = true;      // keep listening across pauses
  rec.interimResults = true;

  let finalBuffer = "";

  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = r[0]?.transcript ?? "";
      if (r.isFinal) finalBuffer += text;
      else interim += text;
    }
    if (interim) cb.onInterim?.((finalBuffer + interim).trim());
  };
  rec.onerror = (ev) => {
    // "no-speech" and "aborted" are user-benign; anything else surface.
    if (ev.error === "no-speech" || ev.error === "aborted") return;
    cb.onError?.(ev.error);
  };
  rec.onend = () => {
    // Commit whatever we ended with.
    if (finalBuffer.trim()) cb.onFinal(finalBuffer.trim());
  };

  try { rec.start(); }
  catch (e) { cb.onError?.((e as Error).message); return null; }
  return {
    stop: () => { try { rec.stop(); } catch { /* already stopped */ } },
    abort: () => { finalBuffer = ""; try { rec.abort(); } catch { /* ignore */ } },
  };
}
