/**
 * QR-044 - ContactsDirectory mapped display-name -> phone with
 * last-writer-wins. pushName is attacker-controlled, so a spoofed pushName
 * must not overwrite an established name mapping.
 */

import { describe, expect, it } from 'vitest';
import { ContactsDirectory } from '../../src/core/mentions.ts';

const ALICE = '15551110001@s.whatsapp.net';
const ATTACKER = '15559990002@s.whatsapp.net';

describe('ContactsDirectory pushName spoofing (QR-044)', () => {
  it('a later untrusted pushName cannot hijack an established name->phone mapping', () => {
    const dir = new ContactsDirectory();
    dir.observe(ALICE, 'Alice');
    expect(dir.resolve('alice')).toBe('15551110001');

    dir.observe(ATTACKER, 'Alice');
    expect(dir.resolve('alice')).toBe('15551110001');
  });

  it('the attacker phone self-key still resolves', () => {
    const dir = new ContactsDirectory();
    dir.observe(ALICE, 'Alice');
    dir.observe(ATTACKER, 'Alice');
    expect(dir.resolve('15559990002')).toBe('15559990002');
  });

  it('re-observing the same sender with the same name refreshes cleanly', () => {
    const dir = new ContactsDirectory();
    dir.observe(ALICE, 'Alice');
    dir.observe(ALICE, 'Alice');
    expect(dir.resolve('alice')).toBe('15551110001');
  });

  it('first-name alias is also protected from hijack', () => {
    const dir = new ContactsDirectory();
    dir.observe(ALICE, 'Alice Smith');
    expect(dir.resolve('alice')).toBe('15551110001');
    dir.observe(ATTACKER, 'Alice Jones');
    expect(dir.resolve('alice')).toBe('15551110001');
  });
});
