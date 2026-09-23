// src/core/shadow-gate-features.ts
// Input contract and text normalization for the logged-only shadow gate.
// Pure: no I/O, no logging, no clock, no randomness.

export const FEATURE_VERSION = 1;

/** Upper bound on normalized text length, in UTF-16 code units. */
export const MAX_SHADOW_TEXT_UTF16 = 4096;

export type Tri = boolean | 'unknown';

export interface ShadowGateInput {
  chatKind: 'dm' | 'group';
  isOwner: Tri;
  isBotSender: Tri;          // kept for schema parity; no rule uses it
  mentionedSelf: Tri;
  isControlChat: Tri;
  contentType: string;       // e.g. 'text', 'image', ... (WhatSoup msg.contentType values)
  quoted: Tri;
  text: string | null;       // already normalized by normalizeShadowText
  truncated: boolean;
  contextStatus: 'known' | 'unknown';
  pendingObligation: Tri;
  featureVersion: 1;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function normalizeShadowText(
  raw: string | null | undefined,
): { text: string | null; truncated: boolean; replaced: boolean } {
  if (raw === null || raw === undefined) return { text: null, truncated: false, replaced: false };

  const wellFormed = raw.toWellFormed();
  const replaced = wellFormed !== raw;
  let text = wellFormed.normalize('NFC');

  let truncated = false;
  if (text.length > MAX_SHADOW_TEXT_UTF16) {
    let cut = MAX_SHADOW_TEXT_UTF16;
    // The string is well-formed, so a high surrogate just before the cut is
    // always paired with the unit at the cut; keeping it would leave it lone.
    if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
    text = text.slice(0, cut);
    truncated = true;
  }

  return { text: text.trim(), truncated, replaced };
}
