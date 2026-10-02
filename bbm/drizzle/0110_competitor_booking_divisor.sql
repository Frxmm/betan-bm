-- Divisor "precio efectivo de Booking" configurable por competidor (antes era
-- una constante global 1.38 en código) — ver src/lib/competitorPricing.ts.
ALTER TABLE "competitor_hotels" ADD COLUMN "booking_effective_divisor" numeric(4,2) NOT NULL DEFAULT '1.38';
