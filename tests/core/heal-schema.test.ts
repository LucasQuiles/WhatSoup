import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';

describe('Migration v10 — self-healing tables', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('creates control_messages with unique message_id', () => {
    const cols = db.raw.prepare("PRAGMA table_info(control_messages)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('message_id');

    db.raw.prepare(
      "INSERT INTO control_messages (message_id, direction, peer_jid, protocol, payload) VALUES ('m1', 'inbound', 'peer', 'LOOPS_HEAL', '{}')",
    ).run();

    expect(() => {
      db.raw.prepare(
        "INSERT INTO control_messages (message_id, direction, peer_jid, protocol, payload) VALUES ('m1', 'inbound', 'peer', 'LOOPS_HEAL', '{}')",
      ).run();
    }).toThrow();
  });

  it('creates heal_reports with unique report_id', () => {
    const cols = db.raw.prepare("PRAGMA table_info(heal_reports)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('report_id');
    expect(names).toContain('error_class');
    expect(names).toContain('state');

    db.raw.prepare(
      "INSERT INTO heal_reports (report_id, error_class, error_type) VALUES ('r1', 'class_a', 'crash')",
    ).run();

    expect(() => {
      db.raw.prepare(
        "INSERT INTO heal_reports (report_id, error_class, error_type) VALUES ('r1', 'class_b', 'crash')",
      ).run();
    }).toThrow();
  });

  it('creates pending_heal_reports with unique report_id', () => {
    const cols = db.raw.prepare("PRAGMA table_info(pending_heal_reports)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('report_id');
    expect(names).toContain('error_class');
    expect(names).toContain('state');

    db.raw.prepare(
      "INSERT INTO pending_heal_reports (report_id, error_class) VALUES ('p1', 'class_a')",
    ).run();

    expect(() => {
      db.raw.prepare(
        "INSERT INTO pending_heal_reports (report_id, error_class) VALUES ('p1', 'class_b')",
      ).run();
    }).toThrow();
  });

  it('enforces one active pending_heal_reports row per error_class', () => {
    db.raw.prepare(
      "INSERT INTO pending_heal_reports (report_id, error_class, state) VALUES ('p1', 'class_a', 'attempt_1')",
    ).run();

    expect(() => {
      db.raw.prepare(
        "INSERT INTO pending_heal_reports (report_id, error_class, state) VALUES ('p2', 'class_a', 'attempt_1')",
      ).run();
    }).toThrow();

    db.raw.prepare("UPDATE pending_heal_reports SET state = 'resolved' WHERE report_id = 'p1'").run();

    expect(() => {
      db.raw.prepare(
        "INSERT INTO pending_heal_reports (report_id, error_class, state) VALUES ('p2', 'class_a', 'attempt_1')",
      ).run();
    }).not.toThrow();
  });
});
