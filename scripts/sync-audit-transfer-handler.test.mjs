import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyTransferAndAuditEvent } from '../server/sync-audit-transfer-handler.mjs';

const sourceOutletId = '00000000-0000-4000-8000-000000000001';
const destinationOutletId = '00000000-0000-4000-8000-000000000002';
const sourceProductId = '00000000-0000-4000-8000-000000000003';
const destinationProductId = '00000000-0000-4000-8000-000000000004';
const sourceVariantId = '00000000-0000-4000-8000-000000000005';
const destinationVariantId = '00000000-0000-4000-8000-000000000006';
const transferId = '00000000-0000-4000-8000-000000000007';
const userId = '00000000-0000-4000-8000-000000000008';
const deviceId = '00000000-0000-4000-8000-000000000009';

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function createTransferClient({ targetExists = false, withVariant = false } = {}) {
  const calls = [];
  const sourceVariant = {
    id: sourceVariantId,
    product_id: sourceProductId,
    sku: 'SKU-TRANSFER-VARIANT',
    barcode: 'BARCODE-TRANSFER-VARIANT',
    name: 'Ukuran kecil',
    price_rupiah: 12000,
    cost_rupiah: 8000,
    metadata: {},
  };
  const targetVariant = {
    ...sourceVariant,
    id: destinationVariantId,
    product_id: destinationProductId,
    stock: '3',
  };
  const targetProduct = {
    id: destinationProductId,
    sku: 'SKU-TRANSFER',
    barcode: null,
    name: 'Produk transfer',
    deleted_at: null,
  };

  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT id FROM stock_transfers')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT p.id,p.outlet_id,p.sku,p.barcode,p.name')) {
        return {
          rows: [
            {
              id: sourceProductId,
              outlet_id: sourceOutletId,
              sku: 'SKU-TRANSFER',
              barcode: null,
              name: 'Produk transfer',
              unit: 'pcs',
              price_rupiah: 12000,
              cost_rupiah: 8000,
              min_stock: 0,
              metadata: {},
              category: 'Minuman',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT id FROM outlets'))
        return { rows: [{ id: destinationOutletId }], rowCount: 1 };
      if (sql.includes('SELECT id,sku,barcode,name,deleted_at FROM products'))
        return { rows: targetExists ? [targetProduct] : [], rowCount: targetExists ? 1 : 0 };
      if (sql.includes('FROM product_variants WHERE product_id=$1')) {
        const productId = values[0];
        const rows =
          productId === sourceProductId
            ? withVariant
              ? [sourceVariant]
              : []
            : targetExists && withVariant
              ? [targetVariant]
              : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO categories'))
        return { rows: [{ id: '00000000-0000-4000-8000-000000000010' }], rowCount: 1 };
      if (sql.includes('INSERT INTO products(id,outlet_id'))
        return { rows: [targetProduct], rowCount: 1 };
      if (sql.includes('INSERT INTO product_variants('))
        return { rows: [targetVariant], rowCount: 1 };
      if (sql.includes('SELECT outlet_id,product_id,variant_id,quantity')) {
        const variantId = withVariant ? sourceVariantId : null;
        const targetId = withVariant ? destinationVariantId : null;
        return {
          rows: [
            {
              outlet_id: sourceOutletId,
              product_id: sourceProductId,
              variant_id: variantId,
              quantity: '10',
            },
            {
              outlet_id: destinationOutletId,
              product_id: destinationProductId,
              variant_id: targetId,
              quantity: '0',
            },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO stock_transfers'))
        return { rows: [{ id: transferId }], rowCount: 1 };
      if (sql.includes('SELECT p.id,p.sku,p.barcode,p.name,p.unit')) {
        return {
          rows: [
            {
              ...targetProduct,
              unit: 'pcs',
              price_rupiah: 12000,
              cost_rupiah: 8000,
              min_stock: 0,
              metadata: {},
              category: 'Minuman',
              stock: withVariant ? '3' : '3',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT variant.id,variant.sku')) {
        return { rows: withVariant ? [targetVariant] : [], rowCount: withVariant ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { calls, client };
}

async function applyTransfer(client, { variant = false } = {}) {
  await applyTransferAndAuditEvent({
    client,
    event: {
      id: deviceId,
      type: 'transfer.upsert',
      outletId: sourceOutletId,
      payload: {
        id: transferId,
        productId: sourceProductId,
        variantId: variant ? sourceVariantId : null,
        from: sourceOutletId,
        to: destinationOutletId,
        quantity: 3,
        note: 'Tes transfer',
        at: new Date().toISOString(),
      },
    },
    scope: sourceOutletId,
    actor: { id: userId, role: 'Admin' },
    deviceId,
    isUuid,
    createHash,
  });
}

test('transfer creates a destination product, credits its balance, and publishes sync events', async () => {
  const { calls, client } = createTransferClient();
  await applyTransfer(client);

  const transferInsert = calls.find((call) => call.sql.includes('INSERT INTO stock_transfers'));
  assert.equal(transferInsert.values[3], destinationProductId);
  const destinationCredit = calls.find(
    (call) =>
      call.sql.includes('UPDATE stock_balances SET quantity=quantity+$4::numeric') &&
      call.values[0] === destinationOutletId,
  );
  assert.deepEqual(destinationCredit.values.slice(0, 3), [
    destinationOutletId,
    destinationProductId,
    null,
  ]);
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO products(id,outlet_id')));
  const syncEventTypes = calls
    .filter((call) => call.sql.includes('INSERT INTO sync_events'))
    .map((call) => call.values[3]);
  assert.deepEqual(syncEventTypes, ['product.upsert', 'transfer.upsert']);
});

test('transfer creates and maps a destination variant with its own id', async () => {
  const { calls, client } = createTransferClient({ withVariant: true });
  await applyTransfer(client, { variant: true });

  const transferInsert = calls.find((call) => call.sql.includes('INSERT INTO stock_transfers'));
  assert.equal(transferInsert.values[4], destinationVariantId);
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO product_variants(')));
  const destinationCredit = calls.find(
    (call) =>
      call.sql.includes('UPDATE stock_balances SET quantity=quantity+$4::numeric') &&
      call.values[0] === destinationOutletId,
  );
  assert.deepEqual(destinationCredit.values.slice(0, 3), [
    destinationOutletId,
    destinationProductId,
    destinationVariantId,
  ]);
});

test('transfer reuses a matching destination product instead of creating another', async () => {
  const { calls, client } = createTransferClient({ targetExists: true });
  await applyTransfer(client);

  assert.equal(
    calls.some((call) => call.sql.includes('INSERT INTO products(id,outlet_id')),
    false,
  );
  const destinationCredit = calls.find(
    (call) =>
      call.sql.includes('UPDATE stock_balances SET quantity=quantity+$4::numeric') &&
      call.values[0] === destinationOutletId,
  );
  assert.equal(destinationCredit.values[1], destinationProductId);
  assert.deepEqual(
    calls
      .filter((call) => call.sql.includes('INSERT INTO sync_events'))
      .map((call) => call.values[3]),
    ['transfer.upsert'],
  );
});
