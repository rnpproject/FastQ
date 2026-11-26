import { filterRemoteSyncEvents } from './attendance-policy.mjs';
import { applyShiftEvent } from './sync-shift-handler.mjs';
import { applyTransferAndAuditEvent } from './sync-audit-transfer-handler.mjs';
import { applyReceivableEvent } from './sync-receivable-handler.mjs';
import { applyStockEvent } from './sync-stock-handler.mjs';
import { applyAttendanceEvent } from './sync-attendance-handler.mjs';
import { applyDiscountEvent } from './sync-discount-handler.mjs';
import { applyCashEvent } from './sync-cash-handler.mjs';
import { applySaleEvent } from './sync-sale-handler.mjs';
import { applyCatalogEvent } from './sync-catalog-handler.mjs';
import { applyBulkCatalogEvent } from './sync-bulk-catalog-handler.mjs';
import { roleEventTypes } from '../shared/sync-role-policy.mjs';
import { collectScopedEntityIds } from './sync-scope-policy.mjs';
import { matchesStoredSyncEvent } from './sync-event-policy.mjs';

function collectAffectedStockProductIds(events, isUuid) {
  const productIds = new Set();
  for (const event of events) {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const add = (value) => {
      if (isUuid(value)) productIds.add(value);
    };
    if (event.type === 'product.upsert') add(payload.id);
    else if (event.type === 'product.bulkUpsert' && Array.isArray(payload.products))
      for (const product of payload.products) add(product?.id);
    else if (
      event.type === 'stock.delta' ||
      event.type === 'stock.reconcile' ||
      event.type === 'transfer.upsert'
    )
      add(payload.productId);
    else if (event.type === 'sale.upsert' && Array.isArray(payload.items))
      for (const item of payload.items) add(item?.productId);
  }
  return [...productIds];
}

function instrumentQueryClient(client, metrics) {
  const query = client.query.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query')
        return (...args) => {
          const startedAt = performance.now();
          metrics.queryCount += 1;
          try {
            const result = query(...args);
            return result.finally(() => {
              metrics.queryDurationMs += performance.now() - startedAt;
            });
          } catch (error) {
            metrics.queryDurationMs += performance.now() - startedAt;
            throw error;
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createSyncHandler({
  pool,
  activeSession,
  json,
  readJson,
  requireSameOrigin,
  isUuid,
  createHash,
}) {
  return async function syncEvents(req, res, url) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    const actor = await activeSession(req);
    const scope = actor.outlet_id;
    if (req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      const after = Number(url.searchParams.get('after') || 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return json(res, 400, { error: 'Cursor sinkronisasi tidak valid.' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fastq-sync-retention'))");
        const retention = await client.query(
          'SELECT minimum_cursor FROM sync_event_retention WHERE outlet_id=$1',
          [scope],
        );
        const minimumCursor = Number(retention.rows[0]?.minimum_cursor || 0);
        if (after < minimumCursor) {
          await client.query('ROLLBACK');
          return json(res, 409, {
            error:
              'Perangkat melewati batas retensi event. Data lokal tetap tersimpan; hubungi administrator untuk sinkronisasi ulang.',
            code: 'SYNC_RESYNC_REQUIRED',
            minimumCursor,
          });
        }
        if (deviceId && isUuid(deviceId)) {
          const knownDevice = await client.query(
            'SELECT last_cursor FROM sync_devices WHERE outlet_id=$1 AND device_id=$2',
            [scope, deviceId],
          );
          if (knownDevice.rowCount && after < Number(knownDevice.rows[0].last_cursor)) {
            await client.query('ROLLBACK');
            return json(res, 409, {
              error:
                'Cursor perangkat mundur dari sinkronisasi terakhir. Data lokal tetap tersimpan; hubungi administrator sebelum melanjutkan.',
              code: 'SYNC_CURSOR_ROLLBACK',
            });
          }
        }
        const result = scope
          ? await client.query(
              `SELECT server_cursor, event_id, device_id, outlet_id, event_type, payload, occurred_at
           FROM sync_events WHERE outlet_id=$2 AND server_cursor>$1 ORDER BY server_cursor LIMIT 1000`,
              [after, scope],
            )
          : await client.query(
              `SELECT server_cursor, event_id, device_id, outlet_id, event_type, payload, occurred_at
           FROM sync_events WHERE server_cursor>$1 ORDER BY server_cursor LIMIT 1000`,
              [after],
            );
        const cursor = result.rows.length ? Number(result.rows.at(-1).server_cursor) : after;
        await client.query('COMMIT');
        return json(res, 200, {
          events: result.rows.filter((event) => event.device_id !== deviceId),
          cursor,
          hasMore: result.rows.length === 1000,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method tidak didukung.' });
    requireSameOrigin(req);
    const body = await readJson(req);
    if (
      !isUuid(body.deviceId) ||
      !Number.isSafeInteger(body.cursor) ||
      body.cursor < 0 ||
      !Array.isArray(body.events) ||
      body.events.length > 100 ||
      (body.bootstrapOffset != null &&
        (!Number.isSafeInteger(body.bootstrapOffset) ||
          body.bootstrapOffset < 0 ||
          body.bootstrapOffset > 1_000_000)) ||
      (body.bootstrap != null && typeof body.bootstrap !== 'boolean') ||
      (body.activeShiftId != null && !isUuid(body.activeShiftId))
    )
      return json(res, 400, {
        error: 'deviceId, cursor, activeShiftId valid, dan maksimum 100 event wajib dikirim.',
      });
    const roleEvents = roleEventTypes[actor.role] || new Set();
    const syncStartedAt = performance.now();
    const queryMetrics = { queryCount: 0, queryDurationMs: 0 };
    const client = instrumentQueryClient(await pool.connect(), queryMetrics);
    const accepted = [];
    const rejected = [];
    const stockConflicts = [];
    let remote;
    let stockBalances;
    let transfers;
    let outlets;
    let bootstrapProducts = [];
    let bootstrapAttendance = [];
    let cursor;
    let needsBootstrap = false;
    let bootstrapTruncated = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fastq-sync-retention'))");
      const retention = await client.query(
        'SELECT minimum_cursor FROM sync_event_retention WHERE outlet_id=$1',
        [scope],
      );
      const minimumCursor = Number(retention.rows[0]?.minimum_cursor || 0);
      const knownDevice = await client.query(
        'SELECT last_cursor FROM sync_devices WHERE outlet_id=$1 AND device_id=$2',
        [scope, body.deviceId],
      );
      needsBootstrap = body.bootstrap === true || (!knownDevice.rowCount && body.cursor === 0);
      if (body.cursor < minimumCursor && !needsBootstrap)
        throw Object.assign(
          new Error(
            'Perangkat melewati batas retensi event. Data lokal tetap tersimpan; hubungi administrator untuk sinkronisasi ulang.',
          ),
          { status: 409, code: 'SYNC_RESYNC_REQUIRED' },
        );
      if (
        knownDevice.rowCount &&
        body.cursor < Number(knownDevice.rows[0].last_cursor) &&
        !needsBootstrap
      )
        throw Object.assign(
          new Error(
            'Cursor perangkat mundur dari sinkronisasi terakhir. Data lokal tetap tersimpan; hubungi administrator sebelum melanjutkan.',
          ),
          { status: 409, code: 'SYNC_CURSOR_ROLLBACK' },
        );
      const batchEventIds = new Set();
      const scopeValidationBudget = { inspectedObjects: 0, entityIds: 0 };
      const categoryCache = new Map();
      const eventScopeIds = new Map();
      const eventScopeErrors = new Map();
      const allScopeIds = new Set();
      if (scope) {
        for (const event of body.events) {
          if (
            !event ||
            typeof event !== 'object' ||
            !event.payload ||
            typeof event.payload !== 'object'
          )
            continue;
          try {
            const ids = collectScopedEntityIds(event, {
              scope,
              isUuid,
              budget: scopeValidationBudget,
            });
            eventScopeIds.set(event, ids);
            for (const id of ids) allScopeIds.add(id);
          } catch (error) {
            eventScopeErrors.set(event, error);
          }
        }
      }
      const foreignEntityIds = new Set();
      if (scope && allScopeIds.size) {
        const foreign = await client.query(
          `SELECT id FROM (
          SELECT id,outlet_id FROM products UNION ALL SELECT id,outlet_id FROM customers
          UNION ALL SELECT id,outlet_id FROM shifts UNION ALL SELECT id,outlet_id FROM sales
          UNION ALL SELECT movement.id,shift.outlet_id FROM cash_movements movement JOIN shifts shift ON shift.id=movement.shift_id
          UNION ALL SELECT id,outlet_id FROM attendance
          UNION ALL SELECT v.id,p.outlet_id FROM product_variants v JOIN products p ON p.id=v.product_id
        ) entities WHERE id=ANY($1::uuid[]) AND outlet_id IS DISTINCT FROM $2::uuid`,
          [[...allScopeIds], scope],
        );
        for (const row of foreign.rows) foreignEntityIds.add(row.id);
      }
      for (const event of body.events) {
        await client.query('SAVEPOINT sync_event');
        try {
          let saleConflict = null;
          const validTimestamp =
            event?.at == null ||
            (typeof event.at === 'string' &&
              event.at.length <= 40 &&
              Number.isFinite(Date.parse(event.at)));
          if (
            !event ||
            typeof event !== 'object' ||
            Array.isArray(event) ||
            !isUuid(event.id) ||
            typeof event.type !== 'string' ||
            !event.type ||
            !event.payload ||
            typeof event.payload !== 'object' ||
            Array.isArray(event.payload) ||
            !validTimestamp
          )
            throw Object.assign(new Error('Format event tidak valid.'), { status: 400 });
          if (batchEventIds.has(event.id))
            throw Object.assign(new Error('ID event duplikat dalam satu batch sinkronisasi.'), {
              status: 400,
            });
          batchEventIds.add(event.id);
          if (!roleEvents.has(event.type))
            throw Object.assign(
              new Error(`Role ${actor.role} tidak dapat mengirim perubahan ${event.type}.`),
              { status: 403 },
            );
          if (
            event.type === 'outlet.upsert' &&
            (actor.role !== 'Admin' || event.payload.id !== scope)
          )
            throw Object.assign(
              new Error(
                'Hanya Pemilik yang dapat membuat toko; Admin hanya dapat menyinkronkan toko aktif.',
              ),
              { status: 403 },
            );
          if (
            event.type === 'cash.upsert' &&
            (!['in', 'out'].includes(event.payload.type) ||
              (actor.role === 'Pemilik' && event.payload.type !== 'out'))
          )
            throw Object.assign(
              new Error('Jenis pergerakan kas tidak diizinkan untuk role akun ini.'),
              { status: 403 },
            );
          if (
            event.type === 'stock.delta' &&
            actor.role === 'Kasir' &&
            Number(event.payload.delta) >= 0
          )
            throw Object.assign(
              new Error('Kasir hanya dapat menyinkronkan pengurangan stok dari transaksi.'),
              { status: 403 },
            );
          if (
            event.type === 'sale.upsert' &&
            actor.role === 'Kasir' &&
            (['Dikembalikan', 'Void'].includes(event.payload.status) ||
              event.payload.refunds?.length ||
              event.payload.voidReason ||
              event.payload.voidAt)
          )
            throw Object.assign(
              new Error('Kasir tidak dapat membatalkan atau me-refund transaksi.'),
              { status: 403 },
            );
          if (scope) {
            const scopeError = eventScopeErrors.get(event);
            if (scopeError) throw scopeError;
            const deny = () => {
              throw Object.assign(
                new Error(
                  `Event ${event.type} (${event.id}) memuat data di luar toko akun. Data tetap disimpan di perangkat; gunakan akun toko yang sesuai.`,
                ),
                { status: 403 },
              );
            };
            if (event.outletId !== scope) deny();
            if (event.type === 'outlet.upsert' && event.payload.id !== scope) deny();
            const ids = eventScopeIds.get(event) || new Set();
            if ([...ids].some((id) => foreignEntityIds.has(id))) deny();
          }
          const inserted = await client.query(
            `INSERT INTO sync_events(event_id,device_id,outlet_id,event_type,payload,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,event_id) DO NOTHING RETURNING server_cursor`,
            [
              event.id,
              body.deviceId,
              event.outletId || null,
              event.type,
              event.payload,
              event.at || new Date().toISOString(),
            ],
          );
          if (!inserted.rowCount) {
            const existing = await client.query(
              `SELECT event_type,outlet_id,payload,occurred_at FROM sync_events WHERE device_id=$1 AND event_id=$2`,
              [body.deviceId, event.id],
            );
            if (!existing.rowCount || !matchesStoredSyncEvent(existing.rows[0], event)) {
              throw Object.assign(
                new Error('ID event sudah pernah dipakai untuk perubahan yang berbeda.'),
                {
                  status: 409,
                  code: 'SYNC_EVENT_ID_CONFLICT',
                  conflict: {
                    type: 'sync-event-id',
                    eventId: event.id,
                    eventType: existing.rows[0]?.event_type || event.type,
                    outletId: existing.rows[0]?.outlet_id || event.outletId || null,
                    occurredAt: existing.rows[0]?.occurred_at || null,
                    storedEvent: existing.rowCount
                      ? {
                          event_type: existing.rows[0].event_type,
                          outlet_id: existing.rows[0].outlet_id,
                          occurred_at: existing.rows[0].occurred_at,
                          payload: existing.rows[0].payload,
                        }
                      : null,
                  },
                },
              );
            }
            accepted.push(event.id);
            if (event.type === 'sale.upsert') {
              saleConflict = await applySaleEvent({
                client,
                event,
                scope,
                actor,
                deviceId: body.deviceId,
                isUuid,
                createHash,
              });
            }
            await client.query('RELEASE SAVEPOINT sync_event');
            if (saleConflict?.stockConflict) stockConflicts.push(saleConflict);
            continue;
          }
          accepted.push(event.id);
          if (
            [
              'outlet.upsert',
              'product.upsert',
              'product.favorite',
              'product.delete',
              'customer.upsert',
            ].includes(event.type)
          ) {
            await applyCatalogEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
              categoryCache,
            });
          } else if (event.type === 'product.bulkUpsert') {
            await applyBulkCatalogEvent({
              client,
              event,
              scope,
              actor,
              isUuid,
              createHash,
            });
          } else if (event.type === 'shift.upsert') {
            await applyShiftEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
          } else if (event.type === 'sale.upsert') {
            saleConflict = await applySaleEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
              createHash,
            });
          } else if (event.type === 'cash.upsert' || event.type === 'cash.approval') {
            await applyCashEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
          } else if (
            event.type === 'discount.request' ||
            event.type === 'discount.approval' ||
            event.type === 'discount.cancel'
          ) {
            await applyDiscountEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
            });
          } else if (event.type === 'attendance.upsert') {
            await applyAttendanceEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
            });
          } else if (event.type === 'receivable.payment') {
            await applyReceivableEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
            });
          } else if (event.type === 'transfer.upsert' || event.type === 'audit.append') {
            await applyTransferAndAuditEvent({
              client,
              event,
              scope,
              actor,
              deviceId: body.deviceId,
              isUuid,
              createHash,
            });
          } else if (event.type === 'stock.delta' || event.type === 'stock.reconcile') {
            await applyStockEvent({ client, event, scope, actor, deviceId: body.deviceId, isUuid });
          }
          await client.query('RELEASE SAVEPOINT sync_event');
          if (saleConflict?.stockConflict) stockConflicts.push(saleConflict);
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT sync_event');
          await client.query('RELEASE SAVEPOINT sync_event');
          if (event?.id) {
            const acceptedIndex = accepted.indexOf(event.id);
            if (acceptedIndex >= 0) accepted.splice(acceptedIndex, 1);
            rejected.push({
              id: event.id,
              code: error.code || 'SYNC_EVENT_REJECTED',
              message: error.message || 'Event ditolak.',
              retryable: error.status === 408 || error.status === 429 || error.status >= 500,
            });
          }
        }
      }
      remote = needsBootstrap
        ? { rows: [] }
        : await client.query(
            `SELECT server_cursor,event_id,device_id,outlet_id,event_type,payload,occurred_at
       FROM sync_events WHERE server_cursor>$1 AND outlet_id=$2 ORDER BY server_cursor LIMIT 1000`,
            [body.cursor, scope],
          );
      const remoteSaleIds = [
        ...new Set(
          remote.rows
            .filter(
              (event) =>
                event.device_id !== body.deviceId &&
                event.event_type === 'sale.upsert' &&
                isUuid(event.payload?.id),
            )
            .map((event) => event.payload.id),
        ),
      ];
      if (remoteSaleIds.length) {
        const conflictBalances = await client.query(
          `SELECT DISTINCT sale.id AS sale_id,balance.product_id,balance.variant_id,
                  balance.quantity::text AS quantity
           FROM sales sale
           JOIN sale_items item ON item.sale_id=sale.id
           JOIN stock_balances balance
             ON balance.outlet_id=sale.outlet_id AND balance.product_id=item.product_id
           WHERE sale.id=ANY($1::uuid[]) AND sale.outlet_id=$2
             AND COALESCE((sale.metadata->>'stock_conflict')::boolean,FALSE)=TRUE
           ORDER BY sale.id,balance.product_id,balance.variant_id NULLS FIRST`,
          [remoteSaleIds, scope],
        );
        const balancesBySale = new Map();
        for (const balance of conflictBalances.rows) {
          const balances = balancesBySale.get(balance.sale_id) || [];
          balances.push({
            outletId: scope,
            productId: balance.product_id,
            variantId: balance.variant_id,
            quantity: Number(balance.quantity),
          });
          balancesBySale.set(balance.sale_id, balances);
        }
        for (const [saleId, balances] of balancesBySale) {
          if (!stockConflicts.some((conflict) => conflict.saleId === saleId))
            stockConflicts.push({ saleId, stockConflict: true, stockBalances: balances });
        }
      }
      const attendanceRows = await client.query(
        `SELECT id,outlet_id,user_id,user_name,work_date::text AS work_date,
                check_in,check_out,check_in_location,check_out_location
         FROM attendance
         WHERE outlet_id=$1
           AND ($2::text <> 'Kasir' OR user_id=$3::uuid)
         ORDER BY work_date DESC,check_in DESC LIMIT 5000`,
        [scope, actor.role, actor.id],
      );
      bootstrapAttendance = attendanceRows.rows.map((row) => ({
        id: row.id,
        outletId: row.outlet_id,
        userId: row.user_id,
        userName: row.user_name,
        workDate: row.work_date,
        checkIn: row.check_in,
        checkOut: row.check_out,
        checkInLocation: row.check_in_location,
        checkOutLocation: row.check_out_location,
      }));
      let balances;
      if (needsBootstrap) {
        balances = await client.query(
          `SELECT product_id,variant_id,quantity::text AS quantity
       FROM stock_balances WHERE outlet_id=$1 ORDER BY product_id,variant_id NULLS FIRST`,
          [scope],
        );
      } else {
        const productIds = collectAffectedStockProductIds(
          [
            ...body.events,
            ...remote.rows.map((event) => ({
              type: event.event_type,
              payload: event.payload,
            })),
          ],
          isUuid,
        );
        balances = productIds.length
          ? await client.query(
              `SELECT product.id AS product_id,balance.variant_id,
                      COALESCE(balance.quantity,0)::text AS quantity
               FROM products product
               LEFT JOIN product_variants variant ON variant.product_id=product.id
               LEFT JOIN stock_balances balance
                 ON balance.outlet_id=product.outlet_id AND balance.product_id=product.id
                 AND balance.variant_id IS NOT DISTINCT FROM variant.id
               WHERE product.outlet_id=$1 AND product.deleted_at IS NULL
                 AND product.id=ANY($2::uuid[])
               ORDER BY product.id,variant.id`,
              [scope, productIds],
            )
          : { rows: [] };
      }
      stockBalances = balances.rows.map((balance) => ({
        outletId: scope,
        productId: balance.product_id,
        variantId: balance.variant_id,
        quantity: Number(balance.quantity),
      }));
      const transferRows = needsBootstrap
        ? await client.query(
            `SELECT transfer.id,
                CASE WHEN transfer.to_outlet_id=$1
                  THEN COALESCE(transfer.to_product_id,transfer.product_id)
                  ELSE transfer.product_id END AS "productId",
                CASE WHEN transfer.to_outlet_id=$1
                  THEN COALESCE(transfer.to_variant_id,transfer.variant_id)
                  ELSE transfer.variant_id END AS "variantId",
                transfer.from_outlet_id AS "from",
                transfer.to_outlet_id AS "to",transfer.quantity::text AS quantity,
                transfer.note,transfer.occurred_at AS at,product.name AS "productName"
         FROM stock_transfers transfer
         LEFT JOIN products product ON product.id=CASE WHEN transfer.to_outlet_id=$1
           THEN COALESCE(transfer.to_product_id,transfer.product_id) ELSE transfer.product_id END
         WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
         ORDER BY transfer.occurred_at DESC,transfer.id DESC LIMIT 500`,
            [scope],
          )
        : { rows: [] };
      transfers = transferRows.rows.map((transfer) => ({
        ...transfer,
        quantity: Number(transfer.quantity),
        at: new Date(transfer.at).toISOString(),
      }));
      const outletRows = needsBootstrap
        ? await client.query(
            `SELECT outlet.id,outlet.name,outlet.code
         FROM outlets outlet
         WHERE outlet.id=$1 OR outlet.id IN (
           SELECT transfer.from_outlet_id FROM stock_transfers transfer
           WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
           UNION
           SELECT transfer.to_outlet_id FROM stock_transfers transfer
           WHERE transfer.from_outlet_id=$1 OR transfer.to_outlet_id=$1
         )
         ORDER BY outlet.name,outlet.id`,
            [scope],
          )
        : { rows: [] };
      outlets = outletRows.rows;
      if (needsBootstrap) {
        const catalogCount = await client.query(
          'SELECT count(*)::int AS total FROM products WHERE outlet_id=$1 AND deleted_at IS NULL',
          [scope],
        );
        const bootstrapOffset = body.bootstrapOffset || 0;
        const products = await client.query(
          `SELECT p.id,p.sku,p.barcode,p.name,p.unit,p.price_rupiah::text AS price,
                    p.cost_rupiah::text AS cost,p.min_stock::text AS min_stock,p.metadata,
                    c.name AS category
             FROM products p LEFT JOIN categories c ON c.id=p.category_id
             WHERE p.outlet_id=$1 AND p.deleted_at IS NULL ORDER BY p.name,p.id LIMIT 5000 OFFSET $2`,
          [scope, bootstrapOffset],
        );
        bootstrapTruncated =
          Number(catalogCount.rows[0]?.total || 0) > bootstrapOffset + products.rows.length;
        const variants = await client.query(
          `SELECT v.id,v.product_id,v.sku,v.barcode,v.name,v.price_rupiah::text AS price,
                    v.cost_rupiah::text AS cost,v.metadata
             FROM product_variants v JOIN products p ON p.id=v.product_id
             WHERE p.outlet_id=$1 AND p.deleted_at IS NULL AND p.id=ANY($2::uuid[]) ORDER BY v.name`,
          [scope, products.rows.map((product) => product.id)],
        );
        const latestCursor = await client.query(
          'SELECT COALESCE(MAX(server_cursor),0)::text AS cursor FROM sync_events WHERE outlet_id=$1',
          [scope],
        );
        const balancesById = new Map(
          stockBalances.map((balance) => [
            `${balance.productId}|${balance.variantId || ''}`,
            balance.quantity,
          ]),
        );
        bootstrapProducts = products.rows.map((product) => {
          const metadata = product.metadata || {};
          const productVariants = variants.rows
            .filter((variant) => variant.product_id === product.id)
            .map((variant) => ({
              id: variant.id,
              sku: variant.sku,
              barcode: variant.barcode,
              name: variant.name,
              price: Number(variant.price),
              ...(actor.role === 'Kasir' ? {} : { cost: Number(variant.cost) }),
              unit: variant.metadata?.unit || product.unit,
              retired: !!variant.metadata?.retired,
              stock: balancesById.get(`${product.id}|${variant.id}`) || 0,
              stockByOutlet: {
                ...(metadata.variants?.[variant.id]?.stockByOutlet || {}),
                [scope]: balancesById.get(`${product.id}|${variant.id}`) || 0,
              },
            }));
          const stock = productVariants.length
            ? productVariants.reduce(
                (sum, variant) => sum + (variant.retired ? 0 : variant.stock),
                0,
              )
            : balancesById.get(`${product.id}|`) || 0;
          return {
            id: product.id,
            sku: product.sku,
            barcode: product.barcode,
            name: product.name,
            category: product.category || 'Lainnya',
            unit: product.unit,
            price: Number(product.price),
            ...(actor.role === 'Kasir' ? {} : { cost: Number(product.cost) }),
            minStock: Number(product.min_stock),
            favorite: !!metadata.favorite,
            icon: metadata.icon || 'cube',
            imageId: metadata.imageId || null,
            stock,
            stockByOutlet: { ...(metadata.stockByOutlet || {}), [scope]: stock },
            variants: productVariants,
          };
        });
        cursor = Number(latestCursor.rows[0]?.cursor || 0);
      } else cursor = remote.rows.length ? Number(remote.rows.at(-1).server_cursor) : body.cursor;
      await client.query(
        `INSERT INTO sync_devices(outlet_id,device_id,last_seen_at,last_cursor) VALUES($1,$2,now(),$3)
       ON CONFLICT(outlet_id,device_id) DO UPDATE SET last_seen_at=now(),last_cursor=GREATEST(sync_devices.last_cursor,EXCLUDED.last_cursor)`,
        [scope, body.deviceId, cursor],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      const eventTypes = {};
      for (const event of body.events) {
        const type = typeof event?.type === 'string' ? event.type : 'invalid';
        eventTypes[type] = (eventTypes[type] || 0) + 1;
      }
      console.info(
        JSON.stringify({
          event: 'sync.transaction',
          transactionDurationMs: Math.round(performance.now() - syncStartedAt),
          queryCount: queryMetrics.queryCount,
          queryDurationMs: Math.round(queryMetrics.queryDurationMs),
          eventCount: body.events.length,
          acceptedCount: accepted.length,
          rejectedCount: rejected.length,
          eventTypes,
        }),
      );
      client.release();
    }
    const events = filterRemoteSyncEvents(remote.rows, actor.role, body.deviceId);
    const active = await pool.query(
      `SELECT id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata
     FROM shifts WHERE outlet_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
      [scope],
    );
    const known = body.activeShiftId
      ? await pool.query(
          `SELECT id,outlet_id,user_id,opened_at,closed_at,opening_cash_rupiah,expected_cash_rupiah,physical_cash_rupiah,difference_rupiah,metadata
     FROM shifts WHERE id=$1 AND outlet_id=$2`,
          [body.activeShiftId, scope],
        )
      : null;
    const toShift = (row) => {
      if (!row) return null;
      const metadata = row.metadata || {};
      return {
        id: row.id,
        outletId: row.outlet_id,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        openingCash: Number(row.opening_cash_rupiah),
        expectedCash: row.expected_cash_rupiah === null ? null : Number(row.expected_cash_rupiah),
        physicalCash: row.physical_cash_rupiah === null ? null : Number(row.physical_cash_rupiah),
        actualCash: row.physical_cash_rupiah === null ? null : Number(row.physical_cash_rupiah),
        difference: row.difference_rupiah === null ? null : Number(row.difference_rupiah),
        cashier: metadata.cashier || null,
        openedBy: metadata.openedBy || metadata.cashier || null,
        openedById: metadata.openedById || row.user_id,
        closedBy: metadata.closedBy || null,
        cashiers: Array.isArray(metadata.cashiers) ? metadata.cashiers : [],
      };
    };
    const activeShift = toShift(active.rows[0]);
    const knownShift = known?.rows[0]?.id !== activeShift?.id ? toShift(known?.rows[0]) : null;
    return json(res, 200, {
      accepted,
      rejected,
      stockConflicts,
      events,
      stockBalances,
      transfers,
      outlets,
      bootstrapProducts,
      catalogBootstrapped: needsBootstrap,
      bootstrapTruncated,
      attendance: bootstrapAttendance,
      activeShift,
      knownShift,
      cursor,
      hasMore: remote.rows.length === 1000,
    });
  };
}
