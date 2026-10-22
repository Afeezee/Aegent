// Formatting controls for a diary entry.
//
// Markdown rather than a rich-text editor: the entry travels as text
// inside the sealed body, and a markup string survives that trip without
// a schema, a sanitiser, or a second rendering path. Headings give a
// title, and bold/italic/quote/list cover what people actually reach for
// when writing about their day.
//
// Alignment is not a Markdown idea, so it is a property of the entry
// rather than something smuggled into the text as HTML — which would
// then have to be sanitised on the way back out.

import type { RefObject } from "react";
import type { DiaryAlign } from "../lib/diary-protocol.js";

type Props = {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  align: DiaryAlign;
  onAlign: (a: DiaryAlign) => void;
};

export function DiaryToolbar({ textarea, value, onChange, align, onAlign }: Props) {
  // Wrap the selection, or drop the markers at the cursor and put the
  // caret between them so typing continues inside the formatting.
  function wrap(before: string, after = before) {
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + before.length + selected.length;
      el.setSelectionRange(selected ? caret : start + before.length, caret);
    });
  }

  // Prefixes apply to whole lines, so they attach at the start of the
  // line the caret is on rather than mid-word.
  function prefixLine(marker: string) {
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const line = value.slice(lineStart);
    // Toggle off if it is already there.
    const next = line.startsWith(marker)
      ? value.slice(0, lineStart) + line.slice(marker.length)
      : value.slice(0, lineStart) + marker + line;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const delta = line.startsWith(marker) ? -marker.length : marker.length;
      el.setSelectionRange(start + delta, start + delta);
    });
  }

  return (
    <div style={{
      display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap",
      padding: "6px 0 8px",
    }}>
      <Tool label="Title" title="Heading" onClick={() => prefixLine("## ")}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>T</span>
      </Tool>
      <Tool label="Bold" title="Bold" onClick={() => wrap("**")}>
        <span style={{ fontWeight: 800 }}>B</span>
      </Tool>
      <Tool label="Italic" title="Italic" onClick={() => wrap("*")}>
        <span style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}>I</span>
      </Tool>
      <Tool label="Quote" title="Quote" onClick={() => prefixLine("> ")}>
        <span style={{ fontSize: 15, lineHeight: 1 }}>&rdquo;</span>
      </Tool>
      <Tool label="List" title="Bullet list" onClick={() => prefixLine("- ")}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>&bull;</span>
      </Tool>

      <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />

      {(["left", "center", "justify"] as const).map((a) => (
        <Tool key={a} label={`Align ${a}`} title={`Align ${a}`}
          active={align === a} onClick={() => onAlign(a)}>
          <AlignGlyph which={a} />
        </Tool>
      ))}
    </div>
  );
}

function Tool({
  label, title, onClick, active, children,
}: {
  label: string; title: string; onClick: () => void; active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Keeps the textarea's selection alive: without this the control
      // steals focus before the handler runs and the selection is gone.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={title}
      style={{
        all: "unset", cursor: "pointer",
        minWidth: 28, height: 28, borderRadius: 8,
        display: "grid", placeItems: "center",
        color: active ? "var(--text)" : "var(--text-dim)",
        background: active ? "rgba(138,125,255,0.18)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
      }}
    >
      {children}
    </button>
  );
}

function AlignGlyph({ which }: { which: DiaryAlign }) {
  const lines = which === "center"
    ? ["60%", "90%", "70%"]
    : which === "justify"
      ? ["100%", "100%", "100%"]
      : ["90%", "60%", "80%"];
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, width: 14 }}>
      {lines.map((w, i) => (
        <span key={i} style={{
          height: 1.5, width: w, background: "currentColor", borderRadius: 1,
          alignSelf: which === "center" ? "center" : "flex-start",
        }} />
      ))}
    </span>
  );
}
