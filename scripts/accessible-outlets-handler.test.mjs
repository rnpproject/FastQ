import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessibleOutletsHandler } from '../server/accessible-outlets-handler.mjs';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const primaryOutletId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assignedOutletId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function createHarness(role, outlets) {
  let query;
  let response;
  const handler = createAccessibleOutletsHandler({
    pool: {
      async query(sql, values) {
        query = { sql, values };
        return { rows: outlets };
      },
    },
    activeSession: async () => ({ id: userId, role, outlet_id: primaryOutletId }),
    json: (_res, status, body) => {
      response = { status, body };
      return response;
    },
  });
  return {
    handler,
    get query() {
      return query;
    },
    get response() {
      return response;
    },
  };
}

test('outlet list includes a non-owner user primary outlet and assigned outlets', async () => {
  const outlets = [
    { id: primaryOutletId, name: 'Toko Utama' },
    { id: assignedOutletId, name: 'Cabang' },
  ];
  const harness = createHarness('Kasir', outlets);
  await harness.handler({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.outlets.length, 2);
  assert.deepEqual(harness.query.values, [userId]);
  assert.match(harness.query.sql, /o\.id=u\.outlet_id/);
  assert.match(harness.query.sql, /user_outlet_access a/);
});

test('outlet list scopes Owner accounts to outlets they own', async () => {
  const harness = createHarness('Pemilik', [{ id: primaryOutletId, name: 'Toko Utama' }]);
  await harness.handler({}, {});

  assert.equal(harness.response.status, 200);
  assert.match(harness.query.sql, /u\.role='Pemilik' AND o\.owner_user_id=u\.id/);
});
