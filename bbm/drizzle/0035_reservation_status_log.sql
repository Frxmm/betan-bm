CREATE TABLE IF NOT EXISTS reservation_status_logs (
  id             SERIAL PRIMARY KEY,
  reservation_id INTEGER     NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  from_status    VARCHAR(30),
  to_status      VARCHAR(30) NOT NULL,
  source         VARCHAR(30) NOT NULL,  -- 'user','fdm','import','checkin','checkout','cancel','revert','auto'
  user_id        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX reservation_status_logs_res_idx ON reservation_status_logs (reservation_id, changed_at DESC);
