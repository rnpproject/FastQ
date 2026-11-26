import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutletSessionHandler } from '../server/outlet-session-handler.mjs';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const primaryOutletId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownedOutletId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const foreignOutletId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function createHarness({ allowed = true, outletId = ownedOutletId } = {}) {
  let response;
  let cookie;
  let signedSession;
  let query;
  const handler = createOutletSessionHandler({
    pool: {
      async query(sql, values) {
        query = { sql, values };
        return allowed
          ? {
              rowCount: 1,
              rows: [{ id: ownedOutletId, name: 'Cabang B', code: '100002' }],
            }
          : { rowCount: 0, rows: [] };
      },
    },
    activeSession: async () => ({
      id: ownerId,
      name: 'Owner',
      role: 'Pemilik',
      outlet_id: primaryOutletId,
    }),
    sessionUser: () => ({
      sub: ownerId,
      sid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      name: 'Owner',
      role: 'Pemilik',
      outletId: primaryOutletId,
      exp: Date.now() + 60_000,
    }),
    requireSameOrigin() {},
    readJson: async () => ({ outletId }),
    isUuid: (value) =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    json: (_res, status, body) => {
      response = { status, body };
      return response;
    },
    setSessionCookie: (_res, token, maxAge, options) => {
      cookie = { token, maxAge, options };
    },
    signSession: (session) => {
      signedSession = session;
      return `signed:${session.outletId}`;
    },
    isAllowedOrigin: (origin) => origin === 'https://pos.local',
  });
  return {
    handler,
    get response() {
      return response;
    },
    get cookie() {
      return cookie;
    },
    get query() {
      return query;
    },
    get signedSession() {
      return signedSession;
    },
  };
}

test('Owner can switch to an owned outlet and the session scope is updated', async () => {
  const harness = createHarness();
  await harness.handler({ headers: { origin: 'https://pos.local' } }, {});

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.user.outletId, ownedOutletId);
  assert.equal(harness.signedSession.outletId, ownedOutletId);
  assert.equal(harness.cookie.token, `signed:${ownedOutletId}`);
  assert.equal(harness.cookie.options.crossOrigin, true);
  assert.deepEqual(harness.query.values, [ownedOutletId, ownerId]);
  assert.match(harness.query.sql, /u\.role='Pemilik' AND o\.owner_user_id=u\.id/);
});

test('switching to an outlet outside the Owner account is rejected', async () => {
  const harness = createHarness({ allowed: false, outletId: foreignOutletId });
  await harness.handler({ headers: { origin: 'https://pos.local' } }, {});

  assert.equal(harness.response.status, 403);
  assert.equal(harness.cookie, undefined);
  assert.equal(harness.signedSession, undefined);
});
