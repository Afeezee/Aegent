// Lightweight emoji picker — categorised, searchable, zero dependency.
// Used to insert emoji into the composer and as the "more" surface for
// message reactions. Keeps a small curated set (the ones people
// actually use) so there's no megabyte emoji-data download.
//
// `mode="sticker"` swaps the grid for an oversized sticker set; a pick
// in that mode is still an emoji string, but the host (Composer) can
// treat it as a one-tap sticker send rather than inserting it into the
// draft. MessageBubble auto-detects messages whose body is a single
// emoji glyph and renders them at sticker scale, so no new schema is
// needed — a sticker is just a short, standalone message.

import { useMemo, useState } from "react";
import { motion } from "framer-motion";

type Category = { name: string; icon: string; emojis: string[] };

// Hand-picked set of emojis that read as "stickers" — big, expressive,
// decorative. The Composer sends these at full size so they land as
// standalone pieces rather than mixed into a message.
const STICKERS: string[] = (
  "❤️ 💖 💘 💕 💞 💗 💓 💝 💐 🌹 🌷 🌻 🌼 " +
  "🎉 🎊 🥳 🎁 🎂 🍾 🥂 🎈 🎀 🎖️ 🏆 👑 " +
  "😍 🥰 🤩 😘 🥺 🙏 🫶 🤗 👏 🙌 💯 ✨ " +
  "😂 🤣 😹 😜 🤪 🥹 🙃 🫡 🤭 🤫 😴 🫠 " +
  "😢 😭 💔 😔 😞 😩 😤 😡 🤬 🫤 😳 🙈 " +
  "🔥 ⚡ 💥 💫 🌟 🌈 ☀️ 🌙 ⭐ 💎 🪄 🎯 " +
  "🐶 🐱 🐼 🐻 🦊 🦁 🐯 🐨 🐸 🐧 🦄 🐝 " +
  "🍕 🍔 🍟 🍰 🍦 🍩 🍪 🍫 🍬 ☕ 🧋 🍹"
).split(" ").filter(Boolean);

// Curated, keyword-free set. Enough to feel complete without shipping
// the full Unicode table. Order within a group is rough frequency.
const CATEGORIES: Category[] = [
  {
    name: "Smileys", icon: "😊",
    emojis: "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖".split(" "),
  },
  {
    name: "Gestures", icon: "👍",
    emojis: "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦾 👏 🙌 👐 🤲 🤜 🤛 ✊ 👊 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝".split(" "),
  },
  {
    name: "Animals", icon: "🐶",
    emojis: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🪲 🐢 🐍 🐙 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🌵 🎄 🌲 🌴 🌱 🌿 🍀 🎋 🍃 🌺 🌸 🌼 🌻 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛄".split(" "),
  },
  {
    name: "Food", icon: "🍔",
    emojis: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥕 🌽 🌶️ 🥔 🍠 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍿 🧂 🍝 🍜 🍲 🍣 🍱 🍛 🍚 🍙 🍘 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍩 🍪 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃 🍸".split(" "),
  },
  {
    name: "Activity", icon: "⚽",
    emojis: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 🏏 🥊 🥋 ⛳ 🏹 🎣 🤿 🥌 🎿 ⛷️ 🏂 🏋️ 🤼 🤸 ⛹️ 🤺 🏇 🧘 🏄 🏊 🚴 🚵 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩".split(" "),
  },
  {
    name: "Travel", icon: "✈️",
    emojis: "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🚢 ⚓ 🏝️ 🏖️ 🏔️ ⛰️ 🌋 🗻 🏕️ ⛺ 🏠 🏡 🏢 🏣 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌".split(" "),
  },
  {
    name: "Objects", icon: "💡",
    emojis: "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🧭 ⏰ ⏱️ ⏲️ 🕰️ 💡 🔦 🏮 📔 📕 📖 📗 📘 📙 📚 📓 📒 📃 📜 📄 📰 📑 🔖 💰 💴 💵 💶 💷 💳 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 🔗 📎 ✂️ 📐 📏 📌 📍 🔒 🔓 🔑 🗝️ 🔔 📣 📢".split(" "),
  },
  {
    name: "Symbols", icon: "✅",
    emojis: "✅ ❌ ❎ ✔️ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❗ ❕ 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 🆔 🚫 🔞 📵 🚭 ⭕ 💯 🔃 🔄 🔙 🔚 🔛 🔜 🔝 ⬆️ ⬇️ ⬅️ ➡️ 🔀 🔁 🔂 ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️".split(" ").filter(Boolean),
  },
];

const RECENT_KEY = "aegent.recentEmoji";
function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}
function pushRecent(e: string) {
  try {
    const cur = loadRecent().filter((x) => x !== e);
    cur.unshift(e);
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 24)));
  } catch { /* ignore */ }
}

export function EmojiPicker({
  onPick, onClose, width = 320, mode = "emoji",
}: {
  onPick: (emoji: string) => void; onClose?: () => void; width?: number;
  // "sticker" opens on the sticker tab and renders bigger cells. The
  // callback shape is the same — the host decides what to do with it.
  mode?: "emoji" | "sticker";
}) {
  // -2 is the virtual "Stickers" tab. -1 is Recent. 0..N are CATEGORIES.
  const [cat, setCat] = useState<number>(mode === "sticker" ? -2 : 0);
  const [recent] = useState<string[]>(loadRecent);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    if (q.trim()) {
      const all = [...STICKERS, ...CATEGORIES.flatMap((c) => c.emojis)];
      return all.filter((e) => e.includes(q.trim()));
    }
    if (cat === -2) return STICKERS;
    if (cat === -1) return recent;
    return CATEGORIES[cat].emojis;
  }, [cat, q, recent]);
  const isStickerView = cat === -2 && !q.trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.14 }}
      onClick={(e) => e.stopPropagation()}
      className="glass"
      style={{
        width, maxWidth: "92vw", borderRadius: 14, padding: 8,
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      {/* Category tabs */}
      <div style={{ display: "flex", gap: 2, overflowX: "auto" }}>
        <TabBtn active={cat === -2 && !q} onClick={() => { setCat(-2); setQ(""); }} label="Stickers">🪄</TabBtn>
        {recent.length > 0 && (
          <TabBtn active={cat === -1 && !q} onClick={() => { setCat(-1); setQ(""); }} label="Recent">🕘</TabBtn>
        )}
        {CATEGORIES.map((c, i) => (
          <TabBtn key={c.name} active={cat === i && !q} onClick={() => { setCat(i); setQ(""); }} label={c.name}>{c.icon}</TabBtn>
        ))}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: isStickerView ? "repeat(5, 1fr)" : "repeat(8, 1fr)",
        gap: isStickerView ? 4 : 2,
        maxHeight: 240, overflowY: "auto",
      }}>
        {shown.length === 0 && (
          <div className="small" style={{ gridColumn: "1 / -1", color: "var(--text-mute)", padding: 10, textAlign: "center" }}>
            Nothing here.
          </div>
        )}
        {shown.map((e, i) => (
          <button key={`${e}-${i}`}
            onClick={() => { onPick(e); pushRecent(e); onClose?.(); }}
            aria-label={`${isStickerView ? "Sticker" : "Emoji"} ${e}`}
            style={{
              all: "unset", cursor: "pointer",
              fontSize: isStickerView ? 40 : 22, lineHeight: 1,
              width: "100%", aspectRatio: "1", display: "grid", placeItems: "center",
              borderRadius: 10,
            }}
            onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = "var(--glass-bg-hi)"; }}
            onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = "transparent"; }}
          >{e}</button>
        ))}
      </div>
    </motion.div>
  );
}

function TabBtn({ children, active, onClick, label }: { children: React.ReactNode; active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label} aria-label={label}
      style={{
        all: "unset", cursor: "pointer", fontSize: 18, padding: "6px 8px", borderRadius: 8,
        background: active ? "var(--glass-bg-hi)" : "transparent",
        opacity: active ? 1 : 0.7,
      }}>
      {children}
    </button>
  );
}
