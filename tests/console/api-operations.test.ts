import { describe, it, expect } from 'vitest';
import { api } from '../../console/src/lib/api.ts';

/**
 * Structural tests for console API client write operations.
 * These verify that the api object exposes the correct methods with the expected
 * function signatures — guarding against accidental removal or signature changes.
 * They don't make real HTTP calls.
 */

describe('api write operations', () => {
  it('restart is a function accepting (name)', () => {
    expect(typeof api.restart).toBe('function');
    expect(api.restart.length).toBe(1);
  });

  it('stopInstance is a function accepting (name)', () => {
    expect(typeof api.stopInstance).toBe('function');
    expect(api.stopInstance.length).toBe(1);
  });

  it('updateConfig is a function accepting (name, patch)', () => {
    expect(typeof api.updateConfig).toBe('function');
    expect(api.updateConfig.length).toBe(2);
  });

  it('sendMessage is a function accepting (name, chatJid, text)', () => {
    expect(typeof api.sendMessage).toBe('function');
    expect(api.sendMessage.length).toBe(3);
  });

  it('accessDecision is a function accepting (name, subjectType, subjectId, action)', () => {
    expect(typeof api.accessDecision).toBe('function');
    expect(api.accessDecision.length).toBe(4);
  });

  it('saveContact is a function accepting (name, contact)', () => {
    expect(typeof api.saveContact).toBe('function');
    expect(api.saveContact.length).toBe(2);
  });

  it('searchMessages is a function accepting (name, query, conversationKey?)', () => {
    expect(typeof api.searchMessages).toBe('function');
    expect(api.searchMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('deleteLine is a function accepting (name)', () => {
    expect(typeof api.deleteLine).toBe('function');
    expect(api.deleteLine.length).toBe(1);
  });
});

describe('api read operations', () => {
  it('getLines is a function', () => {
    expect(typeof api.getLines).toBe('function');
  });

  it('getChats is a function accepting (name)', () => {
    expect(typeof api.getChats).toBe('function');
    expect(api.getChats.length).toBe(1);
  });

  it('getMessages is a function accepting (name, conversationKey, beforePk?)', () => {
    expect(typeof api.getMessages).toBe('function');
    expect(api.getMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('getMetrics is a function accepting (name, range)', () => {
    expect(typeof api.getMetrics).toBe('function');
    expect(api.getMetrics.length).toBe(2);
  });

  it('getAccess is a function accepting (name)', () => {
    expect(typeof api.getAccess).toBe('function');
    expect(api.getAccess.length).toBe(1);
  });
});
