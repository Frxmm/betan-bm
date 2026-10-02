CREATE TABLE room_access_visits (
  id serial PRIMARY KEY,
  property_id integer NOT NULL REFERENCES properties(id),
  room_id integer REFERENCES rooms(id),
  reservation_id integer REFERENCES reservations(id),
  visited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX room_access_visits_visited_at_idx ON room_access_visits (visited_at);
