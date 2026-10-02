ALTER TABLE "rate_daily_prices"
  ADD CONSTRAINT "rate_daily_prices_rate_id_date_unique" UNIQUE ("rate_id", "date");
