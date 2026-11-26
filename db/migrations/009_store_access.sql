ALTER TABLE outlets
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);

UPDATE outlets o
SET owner_user_id = (
  SELECT u.id
  FROM users u
  WHERE u.outlet_id = o.id AND u.role = 'Pemilik'
  ORDER BY u.created_at, u.id
  LIMIT 1
)
WHERE o.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS outlets_owner_user
  ON outlets(owner_user_id, name);

CREATE TABLE IF NOT EXISTS user_outlet_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, outlet_id)
);

INSERT INTO user_outlet_access(user_id, outlet_id)
SELECT id, outlet_id
FROM users
WHERE active = true AND outlet_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS user_outlet_access_outlet
  ON user_outlet_access(outlet_id, user_id);
