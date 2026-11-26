import { isProductIcon } from '../shared/product-icons.mjs';
import { assertProductImagesBelongToOutlet } from './product-image-policy.mjs';

export async function applyCatalogEvent({
  client,
  event,
  scope,
  actor,
  deviceId,
  isUuid,
  categoryCache = new Map(),
}) {
  if (event.type === 'outlet.upsert') {
    const o = event.payload;
    await client.query(
      `INSERT INTO outlets(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name`,
      [o.id, o.name],
    );
  } else if (event.type === 'product.upsert') {
    const p = event.payload;
    const variants = p.variants == null ? [] : p.variants;
    const hasImageId = Object.prototype.hasOwnProperty.call(p, 'imageId');
    const imageId = hasImageId ? p.imageId : null;
    const unit = p.unit ?? 'pcs',
      minStock = Number(p.minStock ?? 0);
    const validStockMap = (value) =>
      value == null ||
      (value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((raw) => {
          const quantity = Number(raw);
          return (
            Number.isFinite(quantity) &&
            quantity > -1e15 &&
            quantity < 1e15 &&
            Math.abs(quantity * 1000 - Math.round(quantity * 1000)) <= 1e-6
          );
        }));
    if (
      !isUuid(p.id) ||
      typeof p.sku !== 'string' ||
      !p.sku.trim() ||
      p.sku.length > 40 ||
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      p.name.length > 80 ||
      (p.barcode != null && (typeof p.barcode !== 'string' || p.barcode.length > 50)) ||
      !Number.isSafeInteger(p.price) ||
      p.price < 0 ||
      !Number.isSafeInteger(p.cost ?? 0) ||
      (p.cost ?? 0) < 0 ||
      (p.category != null && (typeof p.category !== 'string' || p.category.length > 40)) ||
      typeof unit !== 'string' ||
      !unit.trim() ||
      unit.length > 40 ||
      !Number.isFinite(minStock) ||
      minStock < 0 ||
      minStock >= 1e15 ||
      Math.abs(minStock * 1000 - Math.round(minStock * 1000)) > 1e-6 ||
      !validStockMap(p.stockByOutlet) ||
      (p.favorite != null && typeof p.favorite !== 'boolean') ||
      (imageId != null && !isUuid(imageId)) ||
      !Array.isArray(variants) ||
      variants.length > 500
    ) {
      throw Object.assign(new Error('Identitas produk tidak valid.'), { status: 400 });
    }
    const productIdentity = await client.query(
      `SELECT id,sku,barcode,outlet_id,metadata FROM products
       WHERE id=$1 OR (outlet_id=$2 AND sku=$3)
         OR (outlet_id=$2 AND deleted_at IS NULL AND $4::text IS NOT NULL AND barcode=$4)
       FOR UPDATE`,
      [p.id, event.outletId, p.sku, p.barcode || null],
    );
    const existingProduct = productIdentity.rows.find((row) => row.id === p.id);
    if (existingProduct && existingProduct.outlet_id !== scope)
      throw Object.assign(new Error('Produk tidak ditemukan di toko aktif.'), { status: 404 });
    const oldMetadata = existingProduct?.metadata || {};
    const selectedIcon = p.icon ?? oldMetadata.icon ?? 'cube';
    if (!isProductIcon(selectedIcon))
      throw Object.assign(new Error('Ikon produk tidak valid.'), { status: 400 });
    if (
      productIdentity.rows.some(
        (row) => row.id !== p.id && (row.sku === p.sku || (p.barcode && row.barcode === p.barcode)),
      )
    ) {
      throw Object.assign(new Error('SKU atau barcode produk sudah dipakai produk lain.'), {
        status: 409,
      });
    }
    const selectedImageId =
      hasImageId && p.imageId == null
        ? null
        : (p.imageId ?? existingProduct?.metadata?.imageId ?? null);
    if (selectedImageId) {
      await assertProductImagesBelongToOutlet(client, [selectedImageId], scope, isUuid);
    }
    const variantIds = new Set(),
      variantSkus = new Set(),
      variantBarcodes = new Set();
    for (const variant of variants) {
      if (
        !variant ||
        typeof variant !== 'object' ||
        Array.isArray(variant) ||
        !isUuid(variant.id) ||
        typeof variant.sku !== 'string' ||
        !variant.sku.trim() ||
        variant.sku.length > 100 ||
        typeof variant.name !== 'string' ||
        !variant.name.trim() ||
        variant.name.length > 120 ||
        (variant.barcode != null &&
          (typeof variant.barcode !== 'string' || variant.barcode.length > 120)) ||
        !Number.isSafeInteger(variant.price) ||
        variant.price < 0 ||
        !Number.isSafeInteger(variant.cost ?? 0) ||
        (variant.cost ?? 0) < 0 ||
        !validStockMap(variant.stockByOutlet) ||
        variantIds.has(variant.id) ||
        variantSkus.has(variant.sku) ||
        (variant.barcode && variantBarcodes.has(variant.barcode))
      ) {
        throw Object.assign(new Error('Identitas varian produk tidak valid atau berulang.'), {
          status: 400,
        });
      }
      variantIds.add(variant.id);
      variantSkus.add(variant.sku);
      if (variant.barcode) variantBarcodes.add(variant.barcode);
    }
    if (variants.length) {
      const existingVariants = await client.query(
        `SELECT id,product_id,sku,barcode FROM product_variants
         WHERE id=ANY($1::uuid[]) OR
           (product_id=$4 AND (sku=ANY($2::text[]) OR barcode=ANY($3::text[]))) FOR UPDATE`,
        [variants.map((variant) => variant.id), [...variantSkus], [...variantBarcodes], p.id],
      );
      for (const row of existingVariants.rows) {
        const byId = variants.find((variant) => variant.id === row.id);
        const bySku = variants.find((variant) => variant.sku === row.sku);
        const byBarcode =
          row.barcode && variants.find((variant) => variant.barcode === row.barcode);
        if (
          (byId && row.product_id !== p.id) ||
          (row.product_id === p.id && bySku && bySku.id !== row.id) ||
          (row.product_id === p.id && byBarcode && byBarcode.id !== row.id)
        ) {
          throw Object.assign(
            new Error('ID, SKU, atau barcode varian sudah terikat ke varian lain.'),
            { status: 409 },
          );
        }
      }
    }
    let categoryId = null;
    if (p.category) {
      const categoryKey = `${event.outletId}\u0000${p.category}`;
      categoryId = categoryCache.get(categoryKey);
      if (!categoryId) {
        const category = await client.query(
          `INSERT INTO categories(id,outlet_id,name) VALUES(gen_random_uuid(),$1,$2)
           ON CONFLICT(outlet_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
          [event.outletId, p.category],
        );
        categoryId = category.rows[0]?.id || null;
        if (categoryId) categoryCache.set(categoryKey, categoryId);
      }
    }
    const favorite = oldMetadata.favorite ?? !!p.favorite;
    const productValues = [
      p.id,
      event.outletId,
      p.sku,
      p.barcode || null,
      p.name,
      categoryId,
      unit,
      p.price,
      p.cost ?? 0,
      minStock,
      {
        ...oldMetadata,
        variants,
        stockByOutlet: p.stockByOutlet || oldMetadata.stockByOutlet || {},
        favorite,
        icon: selectedIcon,
        imageId: selectedImageId,
      },
    ];
    const productWrite = existingProduct
      ? await client.query(
          `UPDATE products SET sku=$3,barcode=$4,name=$5,category_id=$6,unit=$7,price_rupiah=$8,cost_rupiah=$9,
         min_stock=$10,metadata=$11,updated_at=now() WHERE id=$1 AND outlet_id=$2 RETURNING id`,
          productValues,
        )
      : await client.query(
          `INSERT INTO products(id,outlet_id,sku,barcode,name,category_id,unit,price_rupiah,cost_rupiah,min_stock,metadata,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT DO NOTHING RETURNING id`,
          productValues,
        );
    if (!productWrite.rowCount)
      throw Object.assign(new Error('SKU, barcode, atau ID produk sudah digunakan.'), {
        status: 409,
      });
    if (variants.length) {
      const savedVariants = await client.query(
        `INSERT INTO product_variants(id,product_id,sku,barcode,name,price_rupiah,cost_rupiah,metadata)
         SELECT incoming.id,$2::uuid,incoming.sku,incoming.barcode,incoming.name,incoming.price,COALESCE(incoming.cost,0),jsonb_build_object('unit',$3::text)
         FROM jsonb_to_recordset($1::jsonb) AS incoming(id uuid,sku text,barcode text,name text,price bigint,cost bigint)
         WHERE true
         ON CONFLICT(id) DO UPDATE SET sku=EXCLUDED.sku,barcode=EXCLUDED.barcode,name=EXCLUDED.name,
         price_rupiah=EXCLUDED.price_rupiah,cost_rupiah=EXCLUDED.cost_rupiah,metadata=EXCLUDED.metadata
         WHERE product_variants.product_id=EXCLUDED.product_id RETURNING id`,
        [
          JSON.stringify(
            variants.map((variant) => ({
              id: variant.id,
              sku: variant.sku,
              barcode: variant.barcode || null,
              name: variant.name,
              price: variant.price,
              cost: variant.cost ?? 0,
            })),
          ),
          p.id,
          unit,
        ],
      );
      if (savedVariants.rowCount !== variants.length)
        throw Object.assign(new Error('ID varian sudah digunakan oleh produk lain.'), {
          status: 409,
        });
    }
    if (variants.length) {
      const activeVariantIds = variants.map((v) => v.id);
      await client.query(
        `UPDATE product_variants SET metadata=jsonb_set(metadata,'{retired}','true'::jsonb)
         WHERE product_id=$1 AND NOT (id=ANY($2::uuid[]))`,
        [p.id, activeVariantIds],
      );
    }
    const stockBalanceRows = [];
    for (const [outletId, quantity] of Object.entries(p.stockByOutlet || {}))
      stockBalanceRows.push({
        outlet_id: outletId,
        product_id: p.id,
        variant_id: null,
        quantity: Number(quantity) || 0,
      });
    for (const variant of p.variants || [])
      for (const [outletId, quantity] of Object.entries(variant.stockByOutlet || {})) {
        stockBalanceRows.push({
          outlet_id: outletId,
          product_id: p.id,
          variant_id: variant.id,
          quantity: Number(quantity) || 0,
        });
      }
    if (stockBalanceRows.length)
      await client.query(
        `WITH inserted_balances AS (
           INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
           SELECT incoming.outlet_id,incoming.product_id,incoming.variant_id,incoming.quantity
           FROM jsonb_to_recordset($1::jsonb) AS incoming(outlet_id uuid,product_id uuid,variant_id uuid,quantity numeric)
           WHERE true
           ON CONFLICT(outlet_id,product_id,variant_id) DO NOTHING
           RETURNING outlet_id,product_id,variant_id,quantity
         )
         INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at,user_id)
         SELECT gen_random_uuid(),outlet_id,product_id,variant_id,quantity,'Stok awal',now(),$4
         FROM inserted_balances
         WHERE $2::boolean AND outlet_id=$3 AND quantity>0`,
        [JSON.stringify(stockBalanceRows), !existingProduct, scope, actor?.id || null],
      );
    if (variants.length)
      await client.query(
        `UPDATE stock_balances parent SET quantity=COALESCE((
           SELECT sum(child.quantity) FROM stock_balances child
           JOIN product_variants variant ON variant.id=child.variant_id
           WHERE child.outlet_id=parent.outlet_id AND child.product_id=parent.product_id
             AND COALESCE((variant.metadata->>'retired')::boolean,FALSE)=FALSE
         ),0),updated_at=now()
         WHERE parent.product_id=$1 AND parent.variant_id IS NULL
           AND EXISTS (SELECT 1 FROM product_variants WHERE product_id=$1)`,
        [p.id],
      );
  } else if (event.type === 'product.favorite') {
    const { productId, favorite } = event.payload;
    if (
      !isUuid(productId) ||
      typeof favorite !== 'boolean' ||
      Object.keys(event.payload).some((key) => !['productId', 'favorite'].includes(key))
    ) {
      throw Object.assign(new Error('Perubahan produk favorit tidak valid.'), { status: 400 });
    }
    const updated = await client.query(
      `UPDATE products SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{favorite}',to_jsonb($3::boolean),true),updated_at=now()
       WHERE id=$1 AND outlet_id=$2 AND deleted_at IS NULL RETURNING id`,
      [productId, scope, favorite],
    );
    if (!updated.rowCount)
      throw Object.assign(new Error('Produk favorit tidak ditemukan di toko ini.'), {
        status: 404,
      });
  } else if (event.type === 'product.delete') {
    const target = event.payload;
    const byId = target.id != null,
      bySku = target.sku != null;
    if (
      byId === bySku ||
      (byId && !isUuid(target.id)) ||
      (bySku && (typeof target.sku !== 'string' || !target.sku.trim() || target.sku.length > 40))
    ) {
      throw Object.assign(
        new Error('Hapus produk harus memakai tepat satu ID atau SKU yang valid.'),
        { status: 400 },
      );
    }
    const deleted = await client.query(
      `UPDATE products SET deleted_at=now(),updated_at=now()
       WHERE outlet_id=$1 AND ${byId ? 'id=$2' : 'sku=$2'} AND deleted_at IS NULL RETURNING id`,
      [scope, byId ? target.id : target.sku],
    );
    if (deleted.rowCount !== 1)
      throw Object.assign(new Error('Produk tidak ditemukan atau sudah dihapus.'), { status: 404 });
  } else if (event.type === 'customer.upsert') {
    const c = event.payload;
    if (
      !isUuid(c.id) ||
      typeof c.name !== 'string' ||
      !c.name.trim() ||
      c.name.length > 120 ||
      (c.phone != null && (typeof c.phone !== 'string' || c.phone.length > 40)) ||
      (c.email != null && (typeof c.email !== 'string' || c.email.length > 254))
    ) {
      throw Object.assign(new Error('Data pelanggan tidak valid.'), { status: 400 });
    }
    const canonical = {
      ...c,
      outletId: scope,
      name: c.name.trim(),
      phone: c.phone?.trim() || null,
      email: c.email?.trim() || null,
    };
    const savedCustomer = await client.query(
      `INSERT INTO customers(id,outlet_id,name,phone,email) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,email=EXCLUDED.email
       WHERE customers.outlet_id=EXCLUDED.outlet_id RETURNING id`,
      [canonical.id, scope, canonical.name, canonical.phone, canonical.email],
    );
    if (!savedCustomer.rowCount)
      throw Object.assign(new Error('ID pelanggan sudah digunakan di outlet lain.'), {
        status: 409,
      });
    await client.query('UPDATE sync_events SET payload=$1 WHERE device_id=$2 AND event_id=$3', [
      canonical,
      deviceId,
      event.id,
    ]);
  }
}
