// Bridges between Aegent contacts and the *device's* address book / SMS.
//
// The web has no universal contacts API. What we can rely on:
//   - Contact Picker API (`navigator.contacts.select`) — Android Chrome,
//     Edge, Samsung Internet. iOS Safari does not implement it.
//   - `sms:` URL scheme opens the native SMS composer on iOS + Android.
//   - vCard 3.0 downloads/shares — every platform's Contacts app can
//     import a `.vcf` file, so it's our "save this Aegent contact to
//     your phone" strategy.
//
// Callers should feature-detect first (isContactPickerSupported) and
// present manual entry as a fallback.

import { api, type PublicUser } from "./api.js";
import type { ContactRow } from "./store.js";

// ---- Contact Picker (Android Chrome) ----

type PickedPhoneContact = {
  name: string;
  phone: string;
  emails: string[];
};

export function isContactPickerSupported(): boolean {
  // navigator.contacts is Contact Picker API; navigator.mediaDevices is
  // just a sanity check that we're on a secure context.
  const n = navigator as unknown as {
    contacts?: { select?: (props: string[], opts?: { multiple?: boolean }) => Promise<unknown> };
  };
  return typeof n.contacts?.select === "function";
}

// Ask the OS for one or more phone contacts. Returns the ones the user
// picks in the native sheet — we get name + tel + email, nothing more.
export async function pickPhoneContacts(): Promise<PickedPhoneContact[]> {
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

// After picking, ask the server which of those numbers already have
// Aegent accounts. Result is a map keyed by the original phone string.
export async function matchPickedContactsToAegent(
  picked: PickedPhoneContact[],
): Promise<Array<PickedPhoneContact & { aegent?: PublicUser }>> {
  const phones = picked.map((p) => p.phone);
  const found = await api.lookupPhones(phones);
  // Match by any suffix — user might have "0803…" locally and "+234803…" on Aegent.
  const suffix = (s: string) => s.replace(/[^\d]/g, "").slice(-9);
  const byTail = new Map(found.map((u) => [suffix(u.phone ?? ""), u]));
  return picked.map((p) => ({ ...p, aegent: byTail.get(suffix(p.phone)) }));
}

// ---- vCard export — "save this Aegent contact to my phone" ----

// Build a minimal vCard 3.0 for a contact. Every phone Contacts app on
// the planet can import this.
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

// Trigger the platform's contact-import UX. Web Share API path is the
// nicer one on iOS/Android — the user gets a share sheet that includes
// "Add to Contacts". Fallback: plain download of the .vcf.
export async function saveContactToPhone(c: Parameters<typeof vCardFor>[0]): Promise<"shared" | "downloaded"> {
  const body = vCardFor(c);
  const file = new File([body], `${c.displayName.replace(/[^\w]+/g, "_")}.vcf`, {
    type: "text/vcard",
  });

  const nav = navigator as unknown as {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: `Add ${c.displayName} to contacts` });
    return "shared";
  }
  // Fallback download.
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

// ---- SMS invite ----

// Open the native SMS composer with the invite prefilled. Works on iOS
// and Android; desktop browsers usually no-op or open Messages on macOS.
export function inviteBySms(phone: string | null, inviteUrl: string, senderName: string) {
  const body = `${senderName} invited you to chat privately on Aegent — end-to-end encrypted. ${inviteUrl}`;
  const target = phone ? encodeURIComponent(phone) : "";
  // iOS uses ?body=, Android uses ?body= too; separator between number and
  // query differs (?, & on Android). Both platforms accept `?body=` reliably.
  const href = `sms:${target}?body=${encodeURIComponent(body)}`;
  window.location.href = href;
}

// Convenience: give the same SMS body a copy-to-clipboard variant for
// desktop, where sms: does nothing.
export function inviteBodyFor(inviteUrl: string, senderName: string): string {
  return `${senderName} invited you to chat privately on Aegent — end-to-end encrypted. ${inviteUrl}`;
}
