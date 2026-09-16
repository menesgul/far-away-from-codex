ALTER TABLE pairings ADD COLUMN consumed_marker TEXT;

CREATE UNIQUE INDEX idx_pairings_one_active_per_installation
    ON pairings(installation_id)
    WHERE used_at IS NULL;
