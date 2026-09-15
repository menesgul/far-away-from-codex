PRAGMA foreign_keys = ON;

CREATE TABLE installations (
    id TEXT PRIMARY KEY NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    telegram_chat_id TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE pairings (
    id TEXT PRIMARY KEY NOT NULL,
    installation_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE
);

CREATE INDEX idx_installations_revoked_at
    ON installations(revoked_at)
    WHERE revoked_at IS NOT NULL;

CREATE INDEX idx_pairings_installation_expires_at
    ON pairings(installation_id, expires_at);

CREATE INDEX idx_pairings_cleanup
    ON pairings(expires_at, used_at);
