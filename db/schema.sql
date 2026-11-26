CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS outlets (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  outlet_id uuid REFERENCES outlets(id),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('Pemilik','Manajer','Admin','Kasir')),
  pin_hash text NOT NULL,
  password_hash text,
  totp_secret_ciphertext bytea,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('Pemilik','Manajer','Admin','Kasir'));

CREATE SEQUENCE IF NOT EXISTS outlet_code_seq MINVALUE 100000 MAXVALUE 999999 START 100000 NO CYCLE;
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE outlets ALTER COLUMN code SET DEFAULT nextval('outlet_code_seq')::text;
UPDATE outlets SET code=nextval('outlet_code_seq')::text WHERE code IS NULL;
ALTER TABLE outlets ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outlets_code_unique ON outlets(code);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='outlets_code_format') THEN
    ALTER TABLE outlets ADD CONSTRAINT outlets_code_format CHECK (code ~ '^[0-9]{6}$');
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_identity text;
DROP INDEX IF EXISTS users_login_identity_unique;
CREATE UNIQUE INDEX users_login_identity_unique ON users(login_identity) WHERE active = true AND login_identity IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_salt text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_ciphertext bytea;

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  outlet_id uuid REFERENCES outlets(id),
  name text NOT NULL,
  UNIQUE(outlet_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  outlet_id uuid REFERENCES outlets(id),
  sku text NOT NULL,
  barcode text,
  name text NOT NULL,
  category_id uuid REFERENCES categories(id),
  unit text NOT NULL DEFAULT 'pcs',
  price_rupiah bigint NOT NULL CHECK (price_rupiah >= 0),
  cost_rupiah bigint NOT NULL DEFAULT 0 CHECK (cost_rupiah >= 0),
  min_stock numeric(18,3) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(outlet_id, sku)
);

CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique
  ON products(outlet_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  sku text NOT NULL,
  barcode text,
  name text NOT NULL,
  price_rupiah bigint NOT NULL CHECK (price_rupiah >= 0),
  cost_rupiah bigint NOT NULL DEFAULT 0 CHECK (cost_rupiah >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_sku_unique
  ON product_variants(product_id, sku);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_barcode_unique
  ON product_variants(product_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  quantity numeric(18,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(outlet_id, product_id, variant_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  outlet_id uuid REFERENCES outlets(id),
  name text NOT NULL,
  phone text,
  email text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  user_id uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  opening_cash_rupiah bigint NOT NULL DEFAULT 0,
  expected_cash_rupiah bigint,
  physical_cash_rupiah bigint,
  difference_rupiah bigint,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  shift_id uuid REFERENCES shifts(id),
  customer_id uuid REFERENCES customers(id),
  cashier_name text NOT NULL,
  sale_number text NOT NULL,
  status text NOT NULL,
  subtotal_rupiah bigint NOT NULL,
  discount_rupiah bigint NOT NULL DEFAULT 0,
  tax_rupiah bigint NOT NULL DEFAULT 0,
  service_rupiah bigint NOT NULL DEFAULT 0,
  total_rupiah bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE(outlet_id, sale_number)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  product_name text NOT NULL,
  sku text NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit_price_rupiah bigint NOT NULL,
  unit_cost_rupiah bigint NOT NULL DEFAULT 0,
  discount_rupiah bigint NOT NULL DEFAULT 0,
  note text
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  method text NOT NULL,
  status text NOT NULL,
  amount_rupiah bigint NOT NULL,
  reference text,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sale_refunds (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  amount_rupiah bigint NOT NULL CHECK (amount_rupiah >= 0),
  cancelled_outstanding_rupiah bigint NOT NULL DEFAULT 0 CHECK (cancelled_outstanding_rupiah >= 0),
  method text NOT NULL,
  reference text,
  reason text NOT NULL,
  approved_by text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS receivable_payments (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  customer_id uuid REFERENCES customers(id),
  shift_id uuid REFERENCES shifts(id),
  method text NOT NULL,
  amount_rupiah bigint NOT NULL CHECK (amount_rupiah > 0),
  occurred_at timestamptz NOT NULL
);
ALTER TABLE receivable_payments ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  amount_rupiah bigint NOT NULL CHECK (amount_rupiah > 0),
  reason text NOT NULL,
  category text NOT NULL DEFAULT 'Operasional',
  occurred_at timestamptz NOT NULL,
  approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected')),
  requested_by uuid,
  approved_by text,
  approved_at timestamptz
);
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Operasional';
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS requested_by uuid;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS approved_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cash_movements_approval_status_check') THEN
    ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_approval_status_check CHECK (approval_status IN ('pending','approved','rejected'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS cash_movements_pending_by_shift
  ON cash_movements(shift_id) WHERE approval_status='pending';

CREATE TABLE IF NOT EXISTS attendance (
  id uuid PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  user_id uuid NOT NULL,
  user_name text NOT NULL,
  work_date date NOT NULL,
  check_in timestamptz NOT NULL,
  check_out timestamptz,
  check_in_location jsonb,
  check_out_location jsonb,
  UNIQUE(outlet_id,user_id,work_date)
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_location jsonb;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_location jsonb;

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY,
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  delta numeric(18,3) NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL,
  user_id uuid REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  to_product_id uuid REFERENCES products(id),
  to_variant_id uuid REFERENCES product_variants(id),
  from_outlet_id uuid NOT NULL REFERENCES outlets(id),
  to_outlet_id uuid NOT NULL REFERENCES outlets(id),
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  note text,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  outlet_id uuid REFERENCES outlets(id),
  user_id uuid REFERENCES users(id),
  role text NOT NULL,
  action text NOT NULL,
  detail text,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_events (
  server_cursor bigserial PRIMARY KEY,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  outlet_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id, event_id)
);

CREATE INDEX IF NOT EXISTS sync_events_outlet_cursor ON sync_events(outlet_id, server_cursor);
CREATE INDEX IF NOT EXISTS sales_outlet_occurred ON sales(outlet_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_outlet_product ON stock_movements(outlet_id, product_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS daily_backups (
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  backup_date date NOT NULL,
  encrypted_payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(outlet_id, backup_date)
);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_append_only'
      AND tgrelid = 'audit_log'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER audit_log_append_only
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_no_truncate'
      AND tgrelid = 'audit_log'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER audit_log_no_truncate
      BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version,name) VALUES(1,'baseline') ON CONFLICT(version) DO NOTHING;
