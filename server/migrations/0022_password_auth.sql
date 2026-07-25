-- Password auth: users get an scrypt hash (NULL = not set yet; the invite
-- flow routes them to a set-password screen). Invite links stop being
-- permanent logins and become single-use onboarding/reset tokens — existing
-- permanent links get one grace redemption within 30 days.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

UPDATE invites SET permanent = FALSE,
  expires_at = LEAST(expires_at, (extract(epoch from now()) * 1000)::bigint + 30*24*3600*1000)
WHERE permanent;
