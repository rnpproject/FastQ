import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCatalogEvent } from '../server/sync-catalog-handler.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function queryRecorder(rowCount = 1) {
  const calls = [];
  return {
    calls,
    client: {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rowCount, rows: [] };
      },
    },
  };
}

test('catalog outlet upsert stays in the catalog handler', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: { type: 'outlet.upsert', payload: { id: outletId, name: 'Toko audit' } },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO outlets/);
  assert.deepEqual(calls[0].values, [outletId, 'Toko audit']);
});

test('catalog handlers reject malformed product, deletion, and customer payloads before database writes', async () => {
  const cases = [
    { type: 'product.upsert', payload: { id: 'bad' }, expected: 400 },
    { type: 'product.delete', payload: {}, expected: 400 },
    { type: 'customer.upsert', payload: { id: customerId, name: '  ' }, expected: 400 },
  ];
  for (const event of cases) {
    const { calls, client } = queryRecorder();
    await assert.rejects(
      applyCatalogEvent({ client, scope: outletId, deviceId: eventId, isUuid, event }),
      (error) => error.status === event.expected,
    );
    assert.equal(calls.length, 0);
  }
});

test('customer upsert stores a canonical outlet-scoped payload', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'customer.upsert',
      payload: { id: customerId, name: '  Ayu  ', phone: ' 0812 ', email: ' ayu@example.test ' },
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, [customerId, outletId, 'Ayu', '0812', 'ayu@example.test']);
  assert.deepEqual(calls[1].values, [
    { id: customerId, name: 'Ayu', phone: '0812', email: 'ayu@example.test', outletId },
    eventId,
    eventId,
  ]);
});

test('product upsert accepts a negative stock balance after an offline sale conflict', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'product.upsert',
      outletId,
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        sku: 'SKU-NEG',
        name: 'Produk konflik',
        price: 100,
        stockByOutlet: { [outletId]: -2 },
        category: 'Uji',
      },
    },
  });
  const stockInsert = calls.find((call) => call.sql.includes('INSERT INTO stock_balances'));
  assert.equal(JSON.parse(stockInsert.values[0])[0].quantity, -2);
});

test('product icon and image fields are stored independently', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT id,sku,barcode,outlet_id,metadata FROM products'))
        return {
          rowCount: 1,
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000004',
              sku: 'SKU-VISUAL',
              barcode: null,
              outlet_id: outletId,
              metadata: {
                icon: 'coffee',
                imageId: '00000000-0000-4000-8000-000000000009',
              },
            },
          ],
        };
      if (sql.includes('INSERT INTO categories'))
        return { rowCount: 1, rows: [{ id: customerId }] };
      if (sql.includes('UPDATE products'))
        return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000004' }] };
      return { rowCount: 1, rows: [] };
    },
  };
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'product.upsert',
      outletId,
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        sku: 'SKU-VISUAL',
        name: 'Produk visual',
        price: 100,
        stockByOutlet: { [outletId]: 2 },
        category: 'Uji',
        icon: 'bread',
      },
    },
  });
  const write = calls.find((call) => call.sql.includes('UPDATE products'));
  const metadata = write.values[10];
  assert.equal(metadata.icon, 'bread');
  assert.equal(metadata.imageId, '00000000-0000-4000-8000-000000000009');
});

test('plain product upserts skip variant aggregation queries and reuse batch categories', async () => {
  const { calls, client } = queryRecorder();
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    categoryCache: new Map([['00000000-0000-4000-8000-000000000001\u0000Uji', customerId]]),
    event: {
      id: eventId,
      type: 'product.upsert',
      outletId,
      payload: {
        id: '00000000-0000-4000-8000-000000000004',
        sku: 'SKU-PLAIN',
        name: 'Produk tanpa varian',
        price: 100,
        stockByOutlet: { [outletId]: 2 },
        category: 'Uji',
      },
    },
  });
  assert.equal(
    calls.some((call) => call.sql.includes('INSERT INTO categories')),
    false,
  );
  assert.equal(
    calls.some((call) => call.sql.includes('UPDATE product_variants')),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.sql.includes('UPDATE stock_balances parent') &&
        call.sql.includes('JOIN product_variants'),
    ),
    false,
  );
});

test('variant SKUs can be reused by separately outlet-scoped products', async () => {
  const targetProductId = '00000000-0000-4000-8000-000000000011';
  const sourceProductId = '00000000-0000-4000-8000-000000000012';
  const targetVariantId = '00000000-0000-4000-8000-000000000013';
  const variantId = '00000000-0000-4000-8000-000000000014';
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT id,sku,barcode,outlet_id,metadata FROM products'))
        return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO categories'))
        return { rowCount: 1, rows: [{ id: customerId }] };
      if (sql.includes('SELECT id,product_id,sku,barcode FROM product_variants'))
        return {
          rowCount: 1,
          rows: [
            { id: eventId, product_id: sourceProductId, sku: 'SHARED-VARIANT', barcode: null },
          ],
        };
      if (sql.includes('INSERT INTO products('))
        return { rowCount: 1, rows: [{ id: targetProductId }] };
      if (sql.includes('INSERT INTO product_variants('))
        return { rowCount: 1, rows: [{ id: targetVariantId }] };
      return { rowCount: 1, rows: [] };
    },
  };
  await applyCatalogEvent({
    client,
    scope: outletId,
    deviceId: eventId,
    isUuid,
    event: {
      id: eventId,
      type: 'product.upsert',
      outletId,
      payload: {
        id: targetProductId,
        sku: 'PRODUCT-TARGET',
        name: 'Produk target',
        price: 100,
        category: 'Uji',
        variants: [
          {
            id: variantId,
            sku: 'SHARED-VARIANT',
            name: 'Ukuran kecil',
            price: 100,
          },
        ],
      },
    },
  });

  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO product_variants(')));
});
