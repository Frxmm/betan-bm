CREATE TABLE "competitor_hotels" (
  "id"              serial PRIMARY KEY,
  "property_id"     integer NOT NULL REFERENCES "properties"("id"),
  "name"            text NOT NULL,
  "platform"        text NOT NULL,
  "config"          jsonb NOT NULL DEFAULT '{}',
  "active"          boolean NOT NULL DEFAULT true,
  "last_fetched_at" timestamp with time zone,
  "last_error"      text,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "competitor_prices" (
  "id"            serial PRIMARY KEY,
  "competitor_id" integer NOT NULL REFERENCES "competitor_hotels"("id") ON DELETE CASCADE,
  "date"          date NOT NULL,
  "price"         numeric(10,2),
  "fetched_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "competitor_prices_competitor_id_date_unique" UNIQUE ("competitor_id", "date")
);

CREATE INDEX "competitor_prices_date_idx" ON "competitor_prices" ("date");
