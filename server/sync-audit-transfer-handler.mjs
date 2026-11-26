import { createHash } from 'node:crypto';
import { timestampMs } from './timestamp-utils.mjs';

function transferMovementId(transferId, outletId) {
  return createHash('sha256')
    .update(`transfer-stock:${transferId}:${outletId}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

const SERVER_SYNC_DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function derivedSyncEventId(createHash, transferId, outletId, eventType) {
  return createHash('sha256')
    .update(`transfer-sync:${transferId}:${outletId}:${eventType}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function isRetiredVariant(variant) {
  return Boolean(variant.metadata?.retired);
}

async function findOutletProduct(client, outletId, product) {
  const result = await client.query(
    `SELECT id,sku,barcode,name,deleted_at FROM products
     WHERE outlet_id=$1 AND (sku=$2 OR ($3::text IS NOT NULL AND barcode=$3))
     FOR UPDATE`,
    [outletId, product.sku, product.barcode],
  );
  const ids = new Set(result.rows.map((row) => row.id));
  if (ids.size > 1)
    throw Object.assign(
      new Error('SKU dan barcode produk menunjuk ke produk target yang berbeda.'),
      { status: 409 },
    );
  const existing = result.rows[0] || null;
  if (existing?.deleted_at)
    throw Object.assign(
      new Error(
        'Produk dengan SKU yang sama sudah dihapus di outlet tujuan. Pulihkan produk itu terlebih dahulu.',
      ),
      { status: 409 },
    );
  return existing;
}

async function ensureOutletProduct(client, outletId, sourceProduct) {
  const existing = await findOutletProduct(client, outletId, sourceProduct);
  if (existing) return { product: existing, created: false };

  let categoryId = null;
  if (sourceProduct.category) {
    const category = await client.query(
      `INSERT INTO categories(id,outlet_id,name) VALUES(gen_random_uuid(),$1,$2)
       ON CONFLICT(outlet_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [outletId, sourceProduct.category],
    );
    categoryId = category.rows[0]?.id || null;
  }
  const metadata = { ...(sourceProduct.metadata || {}) };
  delete metadata.stockByOutlet;
  delete metadata.variants;
  delete metadata.imageId;
  metadata.stockByOutlet = { [outletId]: 0 };
  metadata.imageId = null;
  const inserted = await client.query(
    `INSERT INTO products(id,outlet_id,sku,barcode,name,category_id,unit,price_rupiah,
       cost_rupiah,min_stock,metadata,updated_at)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT DO NOTHING RETURNING id,sku,barcode,name,deleted_at`,
    [
      outletId,
      sourceProduct.sku,
      sourceProduct.barcode,
      sourceProduct.name,
      categoryId,
      sourceProduct.unit,
      sourceProduct.price_rupiah,
      sourceProduct.cost_rupiah,
      sourceProduct.min_stock,
      metadata,
    ],
  );
  if (inserted.rowCount) return { product: inserted.rows[0], created: true };

  const raced = await findOutletProduct(client, outletId, sourceProduct);
  if (raced) return { product: raced, created: false };
  throw Object.assign(new Error('Produk tidak dapat dibuat di outlet tujuan.'), { status: 409 });
}

async function listOutletVariants(client, productId) {
  const result = await client.query(
    `SELECT id,product_id,sku,barcode,name,price_rupiah,cost_rupiah,metadata
     FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE`,
    [productId],
  );
  return result.rows;
}

function matchOutletVariant(sourceVariant, targetVariants) {
  const matchBy = (key, value) =>
    value == null ? [] : targetVariants.filter((variant) => variant[key] === value);
  const matches = matchBy('sku', sourceVariant.sku);
  const byBarcode = matchBy('barcode', sourceVariant.barcode);
  const byName = targetVariants.filter(
    (variant) =>
      variant.name.trim().toLocaleLowerCase() === sourceVariant.name.trim().toLocaleLowerCase(),
  );
  const preferred = matches.length ? matches : byBarcode.length ? byBarcode : byName;
  const unique = [...new Map(preferred.map((variant) => [variant.id, variant])).values()];
  if (unique.length > 1)
    throw Object.assign(new Error('Varian produk tidak dapat dipetakan dengan pasti.'), {
      status: 409,
    });
  return unique[0] || null;
}

async function ensureOutletVariant(client, outletProductId, sourceVariant, targetVariants) {
  const existing = matchOutletVariant(sourceVariant, targetVariants);
  if (existing) return { variant: existing, created: false };
  const inserted = await client.query(
    `INSERT INTO product_variants(id,product_id,sku,barcode,name,price_rupiah,cost_rupiah,metadata)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id,product_id,sku,barcode,name,price_rupiah,cost_rupiah,metadata`,
    [
      outletProductId,
      sourceVariant.sku,
      sourceVariant.barcode,
      sourceVariant.name,
      sourceVariant.price_rupiah,
      sourceVariant.cost_rupiah,
      sourceVariant.metadata || {},
    ],
  );
  if (inserted.rowCount) {
    targetVariants.push(inserted.rows[0]);
    return { variant: inserted.rows[0], created: true };
  }
  const refreshed = await listOutletVariants(client, outletProductId);
  const raced = matchOutletVariant(sourceVariant, refreshed);
  if (raced) {
    targetVariants.splice(0, targetVariants.length, ...refreshed);
    return { variant: raced, created: false };
  }
  throw Object.assign(new Error('Varian produk tidak dapat dibuat di outlet tujuan.'), {
    status: 409,
  });
}

async function loadOutletProductPayload(client, outletId, productId) {
  const result = await client.query(
    `SELECT p.id,p.sku,p.barcode,p.name,p.unit,p.price_rupiah,p.cost_rupiah,p.min_stock,
            p.metadata,c.name AS category,COALESCE(parent.quantity,0)::text AS stock
     FROM products p
     LEFT JOIN categories c ON c.id=p.category_id
     LEFT JOIN stock_balances parent
       ON parent.outlet_id=p.outlet_id AND parent.product_id=p.id AND parent.variant_id IS NULL
     WHERE p.id=$1 AND p.outlet_id=$2 AND p.deleted_at IS NULL`,
    [productId, outletId],
  );
  const product = result.rows[0];
  if (!product)
    throw Object.assign(new Error('Produk target tidak ditemukan setelah transfer.'), {
      status: 409,
    });
  const variantResult = await client.query(
    `SELECT variant.id,variant.sku,variant.barcode,variant.name,variant.price_rupiah,
            variant.cost_rupiah,variant.metadata,COALESCE(balance.quantity,0)::text AS stock
     FROM product_variants variant
     LEFT JOIN stock_balances balance
       ON balance.outlet_id=$2 AND balance.product_id=variant.product_id
       AND balance.variant_id=variant.id
     WHERE variant.product_id=$1 ORDER BY variant.name,variant.id`,
    [productId, outletId],
  );
  const metadata = product.metadata || {};
  const variants = variantResult.rows.map((variant) => {
    const stock = Number(variant.stock);
    return {
      id: variant.id,
      sku: variant.sku,
      barcode: variant.barcode,
      name: variant.name,
      price: Number(variant.price_rupiah),
      cost: Number(variant.cost_rupiah),
      unit: variant.metadata?.unit || product.unit,
      retired: isRetiredVariant(variant),
      stock,
      stockByOutlet: { [outletId]: stock },
    };
  });
  const stock = Number(product.stock);
  return {
    id: product.id,
    sku: product.sku,
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    unit: product.unit,
    price: Number(product.price_rupiah),
    cost: Number(product.cost_rupiah),
    minStock: Number(product.min_stock),
    stock,
    stockByOutlet: { [outletId]: stock },
    variants,
    favorite: !!metadata.favorite,
    icon: metadata.icon || 'cube',
    imageId: metadata.imageId || null,
  };
}

async function publishDestinationEvent(client, createHash, transfer, eventType, payload) {
  const eventId = derivedSyncEventId(createHash, transfer.id, transfer.to, eventType);
  await client.query(
    `INSERT INTO sync_events(event_id,device_id,outlet_id,event_type,payload,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,event_id) DO NOTHING`,
    [eventId, SERVER_SYNC_DEVICE_ID, transfer.to, eventType, payload, transfer.at],
  );
}

export async function applyTransferAndAuditEvent({
  client,
  event,
  scope,
  actor,
  deviceId,
  isUuid,
  createHash,
}) {
  if (event.type === 'transfer.upsert') {
    const t = event.payload;
    const quantity = Number(t?.quantity);
    const variantId = t?.variantId || null;
    if (
      !isUuid(t?.id) ||
      !isUuid(t?.productId) ||
      (variantId && !isUuid(variantId)) ||
      !isUuid(t?.from) ||
      !isUuid(t?.to) ||
      t.from === t.to ||
      t.from !== scope ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity >= 1e15 ||
      typeof t.at !== 'string' ||
      !Number.isFinite(Date.parse(t.at)) ||
      Date.parse(t.at) > Date.now() + 5 * 60_000 ||
      (t.note != null && (typeof t.note !== 'string' || t.note.length > 1000))
    ) {
      throw Object.assign(new Error('Data transfer stok tidak valid.'), { status: 400 });
    }

    const existingTransfer = await client.query(
      'SELECT id FROM stock_transfers WHERE id=$1 FOR UPDATE',
      [t.id],
    );
    if (existingTransfer.rowCount) return;

    const sourceResult = await client.query(
      `SELECT p.id,p.outlet_id,p.sku,p.barcode,p.name,p.unit,p.price_rupiah,p.cost_rupiah,
              p.min_stock,p.metadata,c.name AS category
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
       WHERE p.id=$1 AND p.outlet_id=$2 AND p.deleted_at IS NULL
       FOR UPDATE OF p`,
      [t.productId, t.from],
    );
    if (!sourceResult.rowCount)
      throw Object.assign(new Error('Produk sumber tidak ditemukan di outlet aktif.'), {
        status: 404,
      });
    const sourceProduct = sourceResult.rows[0];
    const sourceVariants = await listOutletVariants(client, sourceProduct.id);
    const sourceVariant = variantId
      ? sourceVariants.find((variant) => variant.id === variantId)
      : null;
    if (variantId && (!sourceVariant || isRetiredVariant(sourceVariant)))
      throw Object.assign(new Error('Varian produk tidak ditemukan atau sudah dihentikan.'), {
        status: 404,
      });

    const destinationOutlet = await client.query('SELECT id FROM outlets WHERE id=$1 FOR SHARE', [
      t.to,
    ]);
    if (!destinationOutlet.rowCount)
      throw Object.assign(new Error('Outlet tujuan tidak ditemukan.'), { status: 404 });

    const destination = await ensureOutletProduct(client, t.to, sourceProduct);
    let destinationVariants = await listOutletVariants(client, destination.product.id);
    let destinationVariant = null;
    let catalogChanged = destination.created;
    const variantMappings = new Map();
    const variantsToCopy = destination.created
      ? sourceVariants.filter((variant) => !isRetiredVariant(variant))
      : sourceVariant
        ? [sourceVariant]
        : [];
    for (const sourceItem of variantsToCopy) {
      const ensured = await ensureOutletVariant(
        client,
        destination.product.id,
        sourceItem,
        destinationVariants,
      );
      variantMappings.set(sourceItem.id, ensured.variant);
      if (ensured.created) catalogChanged = true;
    }
    if (sourceVariant) {
      destinationVariant = variantMappings.get(sourceVariant.id);
      if (!destinationVariant)
        throw Object.assign(new Error('Varian tujuan tidak dapat dipetakan.'), { status: 409 });
    }

    await client.query(
      `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
       VALUES($1,$2,$3,0),($4,$5,$6,0)
       ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
      [
        t.from,
        t.productId,
        variantId,
        t.to,
        destination.product.id,
        destinationVariant?.id || null,
      ],
    );
    if (variantId)
      await client.query(
        `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
         VALUES($1,$2,NULL,0),($3,$4,NULL,0)
         ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING`,
        [t.from, t.productId, t.to, destination.product.id],
      );
    const balances = await client.query(
      `SELECT outlet_id,product_id,variant_id,quantity
       FROM stock_balances
       WHERE (outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid)
          OR (outlet_id=$4 AND product_id=$5 AND variant_id IS NOT DISTINCT FROM $6::uuid)
       ORDER BY outlet_id FOR UPDATE`,
      [
        t.from,
        t.productId,
        variantId,
        t.to,
        destination.product.id,
        destinationVariant?.id || null,
      ],
    );
    const source = balances.rows.find(
      (row) =>
        row.outlet_id === t.from && row.product_id === t.productId && row.variant_id === variantId,
    );
    const destinationBalance = balances.rows.find(
      (row) =>
        row.outlet_id === t.to &&
        row.product_id === destination.product.id &&
        row.variant_id === (destinationVariant?.id || null),
    );
    if (!source || !destinationBalance || Number(source.quantity) < quantity) {
      throw Object.assign(new Error('Stok outlet sumber tidak mencukupi.'), {
        status: 409,
        conflict: {
          type: 'stock',
          eventId: event.id,
          productId: t.productId,
          variantId,
          outletId: t.from,
          serverQuantity: Number(source?.quantity || 0),
        },
      });
    }
    const insertedTransfer = await client.query(
      `INSERT INTO stock_transfers(id,product_id,variant_id,to_product_id,to_variant_id,
         from_outlet_id,to_outlet_id,quantity,note,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        t.id,
        t.productId,
        variantId,
        destination.product.id,
        destinationVariant?.id || null,
        t.from,
        t.to,
        quantity,
        t.note?.trim() || null,
        t.at,
      ],
    );
    if (!insertedTransfer.rowCount) return;

    await client.query(
      `UPDATE stock_balances SET quantity=quantity-$4::numeric,updated_at=now()
       WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid`,
      [t.from, t.productId, variantId, quantity],
    );
    await client.query(
      `UPDATE stock_balances SET quantity=quantity+$4::numeric,updated_at=now()
       WHERE outlet_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid`,
      [t.to, destination.product.id, destinationVariant?.id || null, quantity],
    );
    await client.query(
      `INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at,user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8),($9,$10,$11,$12,$13,$14,$7,$8)
       ON CONFLICT(id) DO NOTHING`,
      [
        transferMovementId(t.id, t.from),
        t.from,
        t.productId,
        variantId,
        -quantity,
        `Transfer ke ${t.to}`,
        t.at,
        actor.id,
        transferMovementId(t.id, t.to),
        t.to,
        destination.product.id,
        destinationVariant?.id || null,
        quantity,
        `Transfer dari ${t.from}`,
      ],
    );
    if (variantId) {
      for (const [outletId, productId] of [
        [t.from, t.productId],
        [t.to, destination.product.id],
      ])
        await client.query(
          `UPDATE stock_balances parent SET quantity=COALESCE((
             SELECT sum(child.quantity) FROM stock_balances child
             JOIN product_variants variant ON variant.id=child.variant_id
             WHERE child.outlet_id=$1 AND child.product_id=$2 AND child.variant_id IS NOT NULL
               AND COALESCE((variant.metadata->>'retired')::boolean,FALSE)=FALSE
           ),0),updated_at=now()
           WHERE parent.outlet_id=$1 AND parent.product_id=$2 AND parent.variant_id IS NULL`,
          [outletId, productId],
        );
    }

    if (catalogChanged) {
      const productPayload = await loadOutletProductPayload(client, t.to, destination.product.id);
      await publishDestinationEvent(client, createHash, t, 'product.upsert', productPayload);
    }
    const transferPayload = {
      id: t.id,
      productId: destination.product.id,
      variantId: destinationVariant?.id || null,
      from: t.from,
      to: t.to,
      quantity,
      note: t.note?.trim() || null,
      at: t.at,
      productName: destination.product.name || sourceProduct.name,
    };
    await publishDestinationEvent(client, createHash, t, 'transfer.upsert', transferPayload);
  } else if (event.type === 'audit.append') {
    const a = event.payload;
    if (
      !isUuid(a.id) ||
      typeof a.action !== 'string' ||
      !a.action.trim() ||
      a.action.length > 120 ||
      (a.detail != null && (typeof a.detail !== 'string' || a.detail.length > 1000)) ||
      typeof a.at !== 'string' ||
      a.at.length > 40 ||
      !Number.isFinite(Date.parse(a.at)) ||
      Date.parse(a.at) > Date.now() + 5 * 60_000
    ) {
      throw Object.assign(new Error('Entri audit tidak valid.'), { status: 400 });
    }
    let canonical = {
      id: a.id,
      outletId: scope,
      userId: actor.id,
      role: actor.role,
      action: a.action.trim(),
      detail: a.detail?.trim() || null,
      at: a.at,
    };
    const insertedAudit = await client.query(
      `INSERT INTO audit_log(id,outlet_id,user_id,role,action,detail,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(id) DO NOTHING RETURNING id`,
      [canonical.id, scope, actor.id, actor.role, canonical.action, canonical.detail, canonical.at],
    );
    if (!insertedAudit.rowCount) {
      const existingAudit = await client.query(
        'SELECT outlet_id,user_id,role,action,detail,occurred_at FROM audit_log WHERE id=$1 FOR UPDATE',
        [canonical.id],
      );
      const saved = existingAudit.rows[0];
      if (
        !saved ||
        saved.outlet_id !== scope ||
        saved.action !== canonical.action ||
        saved.detail !== canonical.detail ||
        timestampMs(saved.occurred_at) !== timestampMs(canonical.at)
      ) {
        throw Object.assign(new Error('ID entri audit sudah digunakan dengan isi berbeda.'), {
          status: 409,
        });
      }
      canonical = {
        id: saved.id,
        outletId: saved.outlet_id,
        userId: saved.user_id,
        role: saved.role,
        action: saved.action,
        detail: saved.detail,
        at: saved.occurred_at,
      };
    }
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      canonical,
      deviceId,
      event.id,
    ]);
  }
}
