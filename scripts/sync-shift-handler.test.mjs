import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShiftEvent } from '../server/sync-shift-handler.mjs';

test('shift handler rejects invalid identity and opening cash before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyShiftEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: { type: 'shift.upsert', payload: { id: 'bad', openingCash: -1 } },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});

test('shift handler accepts legacy actualCash and persists it as physical cash', async () => {
  const shiftId = '00000000-0000-4000-8000-000000000010';
  const outletId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  let savedShiftParams;
  const client = {
    query: async (sql, params) => {
      if (sql.includes('SELECT user_id,opening_cash_rupiah,metadata FROM shifts')) {
        return {
          rows: [{ user_id: userId, opening_cash_rupiah: '100', metadata: {} }],
          rowCount: 1,
        };
      }
      if (sql.includes('AS total FROM payments')) return { rows: [{ total: '100' }], rowCount: 1 };
      if (sql.includes('AS total') && sql.includes('cash_movements'))
        return { rows: [{ total: '0' }], rowCount: 1 };
      if (sql.includes('INSERT INTO shifts')) {
        savedShiftParams = params;
        return {
          rows: [
            {
              id: shiftId,
              outlet_id: outletId,
              user_id: userId,
              opened_at: new Date('2026-11-25T10:00:00Z'),
              closed_at: new Date('2026-11-25T11:00:00Z'),
              opening_cash_rupiah: '100',
              expected_cash_rupiah: '200',
              physical_cash_rupiah: '125',
              difference_rupiah: '-75',
              metadata: {},
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await applyShiftEvent({
    client,
    event: {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'shift.upsert',
      outletId,
      payload: {
        id: shiftId,
        outletId,
        openedAt: '2026-11-25T10:00:00Z',
        closedAt: '2026-11-25T11:00:00Z',
        openingCash: 100,
        actualCash: 125,
        shiftName: ' Shift 2 ',
        openedById: userId,
      },
    },
    scope: outletId,
    actor: { id: userId, name: 'Admin', role: 'Admin' },
    deviceId: '00000000-0000-4000-8000-000000000004',
    isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
  });
  assert.equal(savedShiftParams[7], 125);
  assert.equal(savedShiftParams[8], -75);
  assert.equal(savedShiftParams[9].shiftName, 'Shift 2');
});

test('shift handler rejects an invalid display name before database access', async () => {
  let queries = 0;
  await assert.rejects(
    applyShiftEvent({
      client: {
        query: async () => {
          queries++;
          return { rows: [], rowCount: 0 };
        },
      },
      event: {
        type: 'shift.upsert',
        payload: {
          id: '00000000-0000-4000-8000-000000000010',
          openingCash: 0,
          shiftName: ' '.repeat(41),
        },
      },
      scope: '00000000-0000-4000-8000-000000000001',
      actor: { id: '00000000-0000-4000-8000-000000000002', role: 'Admin' },
      deviceId: '00000000-0000-4000-8000-000000000003',
      isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    }),
    (error) => error.status === 400,
  );
  assert.equal(queries, 0);
});
