// A small WYSIWYG editor that stores Markdown.
//
// The diary already renders Markdown on read, so the only place raw
// `**stars**` ever showed was the composer's textarea. This replaces it
// with a contentEditable surface: you see bold as bold while you type,
// and on every change the formatted HTML is serialised back to the
// Markdown the entry is stored as. Storage format is unchanged, the
// reader is unchanged — only the editing surface is now genuine.
//
// execCommand is deprecated but universally supported and is still the
// least-code way to apply inline formatting to a selection without a
// heavy editor dependency. We constrain output to a handful of blocks,
// so the serialiser stays small and predictable.

import { useEffect, useRef } from "react";

export type RichCommand = "bold" | "italic" | "h2" | "quote" | "bullet";

export function applyRich(cmd: RichCommand): void {
  // Focus must already be in the editor; callers guard mousedown so the
  // selection survives the toolbar click.
  switch (cmd) {
    case "bold": document.execCommand("bold"); break;
    case "italic": document.execCommand("italic"); break;
    case "h2": toggleBlock("H2"); break;
    case "quote": toggleBlock("BLOCKQUOTE"); break;
    case "bullet": document.execCommand("insertUnorderedList"); break;
  }
}

function toggleBlock(tag: string): void {
  const cur = (document.queryCommandValue("formatBlock") || "").toUpperCase();
  document.execCommand("formatBlock", false, cur === tag ? "P" : tag);
}

export function RichEditor({
  value, onChange, placeholder, autoFocus, style,
}: {
  value: string;                 // Markdown
  onChange: (markdown: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Seed the DOM once from the incoming Markdown. We do NOT re-write the
  // DOM on every value change — that would fight the caret — so this
  // runs only when the editor is empty and value arrives (e.g. a draft).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerHTML === "" && value) el.innerHTML = markdownToHtml(value);
    if (autoFocus) el.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={(e) => onChange(htmlToMarkdown(e.currentTarget))}
      className="rich-editor"
      style={{
        width: "100%", boxSizing: "border-box", minHeight: 150,
        fontSize: 15, lineHeight: 1.6, outline: "none",
        overflowY: "auto", ...style,
      }}
    />
  );
}

// ---- serialisers ----
//
// A deliberately small subset: headings, bold, italic, quote, bullets,
// and line breaks. Anything else collapses to its text, which is the
// safe failure.

function htmlToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const inner = Array.from(el.childNodes).map(inline).join("");
    switch (el.tagName) {
      case "B": case "STRONG": return inner ? `**${inner}**` : "";
      case "I": case "EM": return inner ? `*${inner}*` : "";
      case "BR": return "";
      default: return inner;
    }
  };

  const block = (el: HTMLElement) => {
    switch (el.tagName) {
      case "H1": case "H2": case "H3":
        lines.push(`## ${inline(el).trim()}`); break;
      case "BLOCKQUOTE":
        lines.push(`> ${inline(el).trim()}`); break;
      case "UL": case "OL":
        for (const li of Array.from(el.children)) lines.push(`- ${inline(li).trim()}`);
        break;
      case "LI":
        lines.push(`- ${inline(el).trim()}`); break;
      default:
        lines.push(inline(el).trim());
    }
  };

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent ?? "").trim();
      if (t) lines.push(t);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      block(child as HTMLElement);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Just enough to re-seed a draft; the reader does the real rendering.
function markdownToHtml(md: string): string {
  return md.split("\n").map((raw) => {
    const line = escapeHtml(raw);
    const fmt = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\*)(.+?)\*/g, "$1<em>$2</em>");
    if (/^## /.test(line)) return `<h2>${fmt.slice(3)}</h2>`;
    if (/^&gt; /.test(line)) return `<blockquote>${fmt.slice(5)}</blockquote>`;
    if (/^- /.test(line)) return `<ul><li>${fmt.slice(2)}</li></ul>`;
    return `<div>${fmt || "<br>"}</div>`;
  }).join("");
}
