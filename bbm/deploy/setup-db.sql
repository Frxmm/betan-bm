-- Crea el usuario y la base de datos de UN entorno (una BD por entorno, todos los tenants dentro).
-- Ejecutar como superusuario postgres, con variables psql:
--   sudo -u postgres psql -v dbuser=betan_bm -v dbname=betan_bm_prod -v dbpass='<contraseña-fuerte>' -f deploy/setup-db.sql
-- (repite con dbname=betan_bm_test para test; si el usuario ya existe, el CREATE USER fallará: ignóralo)

CREATE USER :"dbuser" WITH PASSWORD :'dbpass';

CREATE DATABASE :"dbname" OWNER :"dbuser" ENCODING 'UTF8' LC_COLLATE 'es_ES.UTF-8' LC_CTYPE 'es_ES.UTF-8' TEMPLATE template0;
GRANT ALL PRIVILEGES ON DATABASE :"dbname" TO :"dbuser";

-- Permisos sobre el schema public (necesario en PostgreSQL 15+)
\c :"dbname"
GRANT ALL ON SCHEMA public TO :"dbuser";
