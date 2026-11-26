-- Additive migration: existing users, sessions and reviews remain untouched.
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN phone TEXT CHECK (phone IS NULL OR (length(phone) = 9 AND phone GLOB '9[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'));
CREATE UNIQUE INDEX idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- Atomic, persistent attempt budgets. Keys are HMACs, not phone numbers/IPs.
CREATE TABLE auth_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_expiry ON auth_attempts(expires_at);
