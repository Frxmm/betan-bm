ALTER TABLE blocked_beds ADD COLUMN IF NOT EXISTS locked_by_direction boolean NOT NULL DEFAULT false;
