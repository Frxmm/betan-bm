CREATE TABLE IF NOT EXISTS feedback_threads (
  id             serial PRIMARY KEY,
  property_id    integer NOT NULL REFERENCES properties(id),
  reservation_id integer REFERENCES reservations(id),
  guest_id       integer REFERENCES guests(id),
  channel        text NOT NULL DEFAULT 'verbal',
  text           text NOT NULL,
  sentiment      text NOT NULL DEFAULT 'neutral',
  category       text NOT NULL DEFAULT 'otro',
  status         text NOT NULL DEFAULT 'open',
  assignee_id    integer REFERENCES users(id),
  due_date       date,
  source         text NOT NULL DEFAULT 'staff',
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS feedback_threads_status_idx ON feedback_threads (status, created_at);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id         serial PRIMARY KEY,
  thread_id  integer NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
  author_id  integer REFERENCES users(id),
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
