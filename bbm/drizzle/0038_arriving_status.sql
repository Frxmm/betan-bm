-- Nuevo estado 'arriving' ("Por llegar"): llega hoy, aún sin check-in.
-- Separa el significado que hasta ahora compartía con 'tentative', que pasa a
-- ser solo "provisional" (carrito web sin pagar / reserva FDM sin confirmar).
-- NOTA: debe ejecutarse ANTES que 0039 y fuera de la misma transacción
-- (PostgreSQL no permite usar un valor de enum nuevo en la transacción que lo crea).
ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'arriving';
