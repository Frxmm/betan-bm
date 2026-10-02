-- Reclasificar las 'tentative' que en realidad eran "Por llegar" del scheduler:
-- tienen habitación asignada (los carritos web nunca la tienen) y su check-in ya llegó.
UPDATE "reservations"
SET "status" = 'arriving', "updated_at" = now()
WHERE "status" = 'tentative'
  AND "room_id" IS NOT NULL
  AND "check_in_date" <= CURRENT_DATE;
