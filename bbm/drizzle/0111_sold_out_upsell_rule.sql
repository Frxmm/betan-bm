-- Nueva regla de precio dinámico "sold_out_upsell" (venta de superiores):
-- cuando el tipo de habitación source se queda a 0 disponibles, baja el
-- precio del tipo target a precio de source + adjustValue €.
ALTER TABLE "pricing_rules" ADD COLUMN "source_room_type_id" integer REFERENCES "room_types"("id");
ALTER TABLE "pricing_rules" ADD COLUMN "target_room_type_id" integer REFERENCES "room_types"("id");
