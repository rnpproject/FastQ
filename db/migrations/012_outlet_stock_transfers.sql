ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS to_product_id uuid REFERENCES products(id),
  ADD COLUMN IF NOT EXISTS to_variant_id uuid REFERENCES product_variants(id);

ALTER TABLE product_variants
  DROP CONSTRAINT IF EXISTS product_variants_sku_key,
  DROP CONSTRAINT IF EXISTS product_variants_barcode_key;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_sku_unique
  ON product_variants(product_id, sku);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_barcode_unique
  ON product_variants(product_id, barcode) WHERE barcode IS NOT NULL;
