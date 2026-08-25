// Bridges between Aegent contacts and the *device's* address book, SMS
// composer, and share sheet — routing through native Capacitor plugins
// when running as the APK, and falling back to Web APIs on the browser.
//
// Reality of what's available where:
//   - Android System WebView does NOT expose the Web Contact Picker,
//     even though Chrome does. Trying `navigator.contacts.select`
//     in the APK just throws. So the native path via
//     @capacitor-community/contacts is mandatory there.
//   - iOS Safari doesn't expose it either.
//   - Only desktop / mobile Chromium browsers reliably do.
//   - `sms:` URLs open the native SMS composer on iOS + Android.
//   - Web Share API exists in Capacitor's WebView, but @capacitor/share
//     is more reliable (works even on desktop Android WebView / older
//     Chrome) and unifies the "share files vs. share text/url" path.

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { api, type PublicUser } from "./api.js";

// ---- picker types the callers see ----

export type PickedPhoneContact = {
  name: string;
  phone: string;
  emails: string[];
};

// ---- capability detection ----

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

// True if we have *some* way to import phone contacts. On the APK the
// native plugin is always available (installed at build time); on the
// browser it depends on Contact Picker support.
export function isContactPickerSupported(): boolean {
  if (isNativeApp()) return true;
  const n = navigator as unknown as {
    contacts?: { select?: (props: string[], opts?: { multiple?: boolean }) => Promise<unknown> };
  };
  return typeof n.contacts?.select === "function";
}

// ---- pick contacts ----

export async function pickPhoneContacts(): Promise<PickedPhoneContact[]> {
  if (isNativeApp()) return pickNative();
  return pickWeb();
}

async function pickNative(): Promise<PickedPhoneContact[]> {
  // Lazy import so we don't pay the cost / require the plugin on
  // web-only deploys.
  const { Contacts } = await import("@capacitor-community/contacts");

  // Ask Android for READ_CONTACTS. `getContacts` will also request on
  // demand, but requesting explicitly gives us a chance to surface a
  // clear error if the user says no.
  const perm = await Contacts.requestPermissions();
  if (perm.contacts !== "granted") {
    throw new Error("contacts_permission_denied");
  }

  const res = await Contacts.getContacts({
    projection: { name: true, phones: true, emails: true },
  });
  const out: PickedPhoneContact[] = [];
  for (const c of res.contacts ?? []) {
    const phone = c.phones?.[0]?.number ?? "";
    if (!phone) continue;
    const name = c.name?.display
      ?? [c.name?.given, c.name?.family].filter(Boolean).join(" ")
      ?? "";
    out.push({
      name: name.trim() || "Contact",
      phone,
      emails: (c.emails ?? []).map((e) => e.address ?? "").filter(Boolean),
    });
  }
  return out;
}

async function pickWeb(): Promise<PickedPhoneContact[]> {
  const n = navigator as unknown as {
    contacts: { select: (props: string[], opts?: { multiple?: boolean }) => Promise<Array<{
      name?: string[]; tel?: string[]; email?: string[];
    }>> };
  };
  const raw = await n.contacts.select(["name", "tel", "email"], { multiple: true });
  return raw
    .map((r) => ({
      name: (r.name ?? [])[0] ?? "",
      phone: (r.tel ?? [])[0] ?? "",
      emails: r.email ?? [],
    }))
    .filter((c) => c.name && c.phone);
}

// ---- match against Aegent ----

export async function matchPickedContactsToAegent(
  picked: PickedPhoneContact[],
): Promise<Array<PickedPhoneContact & { aegent?: PublicUser }>> {
  const phones = picked.map((p) => p.phone);
  const found = await api.lookupPhones(phones);
  // Match by last-9-digit tail — user might have "0803…" locally and
  // "+234803…" on Aegent.
  const suffix = (s: string) => s.replace(/[^\d]/g, "").slice(-9);
  const byTail = new Map(found.map((u) => [suffix(u.phone ?? ""), u]));
  return picked.map((p) => ({ ...p, aegent: byTail.get(suffix(p.phone)) }));
}

// ---- vCard export ----

export function vCardFor(c: {
  displayName: string;
  handle: string;
  email: string;
  phone?: string | null;
  note?: string;
}): string {
  const esc = (s: string) => s.replace(/([;,\\])/g, "\\$1");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${esc(c.displayName)}`,
    `N:${esc(c.displayName)};;;;`,
    `EMAIL;TYPE=INTERNET:${esc(c.email)}`,
    c.phone ? `TEL;TYPE=CELL:${esc(c.phone)}` : null,
    `NICKNAME:${esc("@" + c.handle)}`,
    `NOTE:${esc(c.note ?? `Aegent: @${c.handle}`)}`,
    "END:VCARD",
  ].filter(Boolean).join("\r\n");
}

export async function saveContactToPhone(
  c: Parameters<typeof vCardFor>[0],
): Promise<"shared" | "downloaded"> {
  const body = vCardFor(c);
  // Prefer the native share sheet everywhere — it exposes "Add to
  // Contacts" as a target on Android + iOS. Fall back to download for
  // desktop browsers.
  if (isNativeApp()) {
    try {
      await Share.share({
        title: `Add ${c.displayName} to contacts`,
        text: body,
        dialogTitle: `Save ${c.displayName}`,
      });
      return "shared";
    } catch { /* user cancel — fall through */ }
  }
  const nav = navigator as unknown as {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  const file = new File([body], `${c.displayName.replace(/[^\w]+/g, "_")}.vcf`, {
    type: "text/vcard",
  });
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `Add ${c.displayName} to contacts` });
      return "shared";
    } catch { /* user cancel — fall through */ }
  }
  const url = URL.createObjectURL(new Blob([body], { type: "text/vcard" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "downloaded";
}

// ---- share (native share sheet across all targets) ----

export async function shareInvite(input: {
  url: string;
  title: string;
  text: string;
}): Promise<"shared" | "copied"> {
  // Native app — the OS's system share sheet is what people expect:
  // Messages, WhatsApp, Gmail, Signal, Bluetooth, everything.
  if (isNativeApp()) {
    try {
      await Share.share({
        url: input.url,
        title: input.title,
        text: input.text,
        dialogTitle: input.title,
      });
      return "shared";
    } catch { /* user cancelled or plugin refused — fall through */ }
  }
  // Web — Web Share API where present (mobile Chrome, Safari), else
  // clipboard-copy as the practical fallback.
  const nav = navigator as unknown as {
    share?: (d: { title?: string; text?: string; url?: string }) => Promise<void>;
  };
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: input.title, text: input.text, url: input.url });
      return "shared";
    } catch { /* user cancel or blocked */ }
  }
  try { await navigator.clipboard.writeText(`${input.text} ${input.url}`.trim()); } catch { /* ignore */ }
  return "copied";
}

// ---- SMS invite ----

export function inviteBySms(phone: string | null, inviteUrl: string, senderName: string) {
  const body = inviteBodyFor(inviteUrl, senderName);
  const target = phone ? encodeURIComponent(phone) : "";
  const href = `sms:${target}?body=${encodeURIComponent(body)}`;
  // In Capacitor, opening `sms:` via location.href works on Android;
  // on iOS the same intent handler kicks in.
  window.location.href = href;
}

export function inviteBodyFor(inviteUrl: string, senderName: string): string {
  return `${senderName} invited you to chat privately on Aegent — end-to-end encrypted. ${inviteUrl}`;
}
