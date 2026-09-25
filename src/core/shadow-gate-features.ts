// src/core/shadow-gate-features.ts
// Input contract and text normalization for the logged-only shadow gate.
// Pure: no I/O, no logging, no clock, no randomness.

import { avoidTrailingHighSurrogateBreak } from '../lib/text-chunking.ts';

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

/** ASCII or full-width question mark. */
export function containsQuestionMark(text: string): boolean {
  return text.includes('?') || text.includes('？');
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
    // The string is well-formed, so a high surrogate just before the cut is
    // always paired with the unit at the cut; keeping it would leave it lone.
    text = text.slice(0, avoidTrailingHighSurrogateBreak(text, 0, MAX_SHADOW_TEXT_UTF16));
    truncated = true;
  }

  return { text: text.trim(), truncated, replaced };
}
