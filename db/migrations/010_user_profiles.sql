CREATE TABLE IF NOT EXISTS user_profile_photos (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 30720),
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
