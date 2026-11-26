import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardHandler } from '../server/dashboard-handler.mjs';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const storeB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const storeOutside = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function createHarness(role, outlets) {
  const queries = [];
  let response;
  const handler = createDashboardHandler({
    pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.includes('SELECT DISTINCT o.id,o.name,o.timezone')) return { rows: outlets };
        if (sql.includes('SELECT count(*) FILTER'))
          return { rows: [{ transactions: 0, revenue: '0', receivables: '0' }] };
        return { rows: [] };
      },
    },
    activeSession: async () => ({ id: ownerId, role, outlet_id: storeA }),
    json: (_res, status, body) => {
      response = { status, body };
      return response;
    },
  });
  return {
    queries,
    get response() {
      return response;
    },
    request: (outletId = '') =>
      handler(
        {},
        {},
        new URL(`http://localhost/api/dashboard${outletId ? `?outletId=${outletId}` : ''}`),
      ),
  };
}

test('dashboard aggregates all stores assigned to the account', async () => {
  const harness = createHarness('Manajer', [
    { id: storeA, name: 'Toko A', timezone: 'Asia/Jakarta' },
    { id: storeB, name: 'Toko B', timezone: 'Asia/Jakarta' },
  ]);
  await harness.request();

  assert.equal(harness.response.status, 200);
  const aggregateQueries = harness.queries.filter(({ sql }) => !sql.includes('SELECT DISTINCT'));
  assert.ok(aggregateQueries.length > 0);
  for (const query of aggregateQueries) assert.deepEqual(query.values[0], [storeA, storeB]);
  assert.deepEqual(
    harness.response.body.outlets.map((outlet) => outlet.id),
    [storeA, storeB],
  );
});

test('dashboard rejects a store outside the account access list', async () => {
  const harness = createHarness('Manajer', [
    { id: storeA, name: 'Toko A', timezone: 'Asia/Jakarta' },
  ]);
  await harness.request(storeOutside);

  assert.equal(harness.response.status, 403);
  assert.equal(harness.queries.length, 1);
});

test('owner dashboard includes all stores owned by the owner account', async () => {
  const harness = createHarness('Pemilik', [
    { id: storeA, name: 'Toko A', timezone: 'Asia/Jakarta' },
    { id: storeB, name: 'Toko B', timezone: 'Asia/Jakarta' },
  ]);
  await harness.request();

  assert.equal(harness.response.status, 200);
  assert.deepEqual(harness.queries[0].values, [ownerId, 'Pemilik']);
  assert.match(harness.queries[0].sql, /\$2='Pemilik' AND o\.owner_user_id=\$1/);
});
