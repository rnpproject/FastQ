import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttendanceHistoryHandler } from '../server/attendance-history-handler.mjs';

const outletId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const recordId = '33333333-3333-4333-8333-333333333333';
const isUuid = (value) => /^[0-9a-f-]{36}$/i.test(value || '');

function fixture(role = 'Admin', rows = null) {
  const calls = [];
  let response;
  const handler = createAttendanceHistoryHandler({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return {
          rows: rows || [
            {
              id: recordId,
              user_id: staffId,
              user_name: 'Nadia',
              work_date: '2026-11-23',
              check_in: new Date('2026-11-23T01:00:00.000Z'),
              check_out: null,
              check_in_location: { latitude: -6.2, longitude: 106.8 },
              check_out_location: null,
            },
          ],
        };
      },
    },
    activeSession: async () => ({ id: 'admin', outlet_id: outletId, role }),
    json: (_res, status, value) => {
      response = { status, value };
    },
    isUuid,
  });
  const request = (query = '') =>
    handler({ method: 'GET' }, {}, new URL(`http://pos.test/api/attendance-history${query}`));
  return {
    calls,
    request,
    get response() {
      return response;
    },
  };
}

test('attendance export filters by date, staff, and active outlet', async () => {
  const f = fixture();
  await f.request(`?from=2026-11-01&to=2026-11-30&userId=${staffId}`);

  assert.equal(f.response.status, 200);
  assert.equal(f.response.value.attendance[0].userName, 'Nadia');
  assert.deepEqual(f.calls[0].params, [
    outletId,
    '2026-11-01',
    '2026-11-30',
    staffId,
    null,
    null,
    501,
  ]);
});

test('attendance export denies non-admins and rejects invalid filters before querying', async () => {
  const cashier = fixture('Kasir');
  await cashier.request('?from=2026-11-01&to=2026-11-30');
  assert.equal(cashier.response.status, 403);
  assert.equal(cashier.calls.length, 0);

  const invalidDate = fixture();
  await invalidDate.request('?from=2026-02-30&to=2026-03-01');
  assert.equal(invalidDate.response.status, 400);
  assert.equal(invalidDate.calls.length, 0);

  const invalidStaff = fixture();
  await invalidStaff.request('?from=2026-11-01&to=2026-11-30&userId=invalid');
  assert.equal(invalidStaff.response.status, 400);
  assert.equal(invalidStaff.calls.length, 0);
});

test('attendance export rejects requests for another outlet', async () => {
  const f = fixture();
  await f.request(`?from=2026-11-01&to=2026-11-30&outletId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  assert.equal(f.response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('attendance export returns a stable cursor when another page is available', async () => {
  const secondRecordId = '44444444-4444-4444-8444-444444444444';
  const f = fixture('Admin', [
    { id: recordId, work_date: '2026-11-23' },
    { id: secondRecordId, work_date: '2026-11-22' },
  ]);
  await f.request('?from=2026-11-01&to=2026-11-30&limit=1');

  assert.equal(f.response.status, 200);
  assert.equal(f.response.value.hasMore, true);
  assert.deepEqual(f.response.value.next, {
    before: '2026-11-23',
    beforeId: recordId,
  });
  assert.match(f.calls[0].sql, /\(work_date,id\)<\(\$5::date,\$6::uuid\)/);
});
