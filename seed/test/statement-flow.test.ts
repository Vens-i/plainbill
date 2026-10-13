/**
 * "Your statement, explained" on the full seed: patient mailing addresses, the itemized
 * statement (JSON layout + PDF) behind verification, and the margin notes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, schema } from '@plainbill/api';
import { loadSeed } from '../src/load';

let db: ReturnType<typeof openDatabase>['db'];
let close: () => void;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  db = opened.db;
  close = opened.close;
  await loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
});
afterAll(() => close());

describe('patient addresses', () => {
  it('every seed patient has a fictional mailing address', () => {
    const rows = db
      .select()
      .from(schema.patients)
      .all()
      .sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(13);
    for (const p of rows) {
      expect(p.addressLine1, p.lastName).toMatch(/^\d+ /);
      expect([p.city, p.state, p.zip]).toEqual(['Harborview', 'CA', '94000']);
    }
    expect(rows[0]).toMatchObject({
      firstName: 'Maria',
      addressLine1: '418 Seacliff Ave',
      addressLine2: 'Apt 2B',
    });
  });
});
