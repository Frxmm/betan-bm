CREATE TABLE common_area_tasks (
  id serial PRIMARY KEY,
  property_id integer NOT NULL REFERENCES properties(id),
  date text NOT NULL,
  area_key text NOT NULL,
  assigned_to integer,
  assigned_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  completed_at timestamptz,
  completed_by integer,
  paper_refilled_at timestamptz,
  paper_refilled_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, area_key)
);
