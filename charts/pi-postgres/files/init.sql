-- Idempotent: every statement is guarded, so a run on an existing data directory changes nothing. Passwords come from
-- the environment through \getenv; they are never in a manifest, an argument list or the log.
\set ON_ERROR_STOP on
\set QUIET on
-- A failing statement must not be echoed (with the password) into the server log.
SET log_statement = 'none';
SET log_min_error_statement = panic;
SET password_encryption = 'scram-sha-256';

\getenv pi_role PI_ROLE
\getenv pi_db PI_DB
\getenv pi_password PI_PASSWORD
\getenv onecli_role ONECLI_ROLE
\getenv onecli_db ONECLI_DB
\getenv onecli_password ONECLI_PASSWORD

CREATE TEMP TABLE wanted (role text, db text, password text);
INSERT INTO wanted VALUES (:'pi_role', :'pi_db', :'pi_password'), (:'onecli_role', :'onecli_db', :'onecli_password');

-- Roles: create when missing; always re-apply the attributes and the password, so a rotated Secret takes effect and a
-- role that was changed by hand is brought back to non-superuser.
SELECT format('CREATE ROLE %I LOGIN', role) FROM wanted
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role) \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', role, password)
  FROM wanted \gexec

-- Databases: CREATE DATABASE cannot run in a transaction or DO block, hence \gexec.
SELECT format('CREATE DATABASE %I OWNER %I', db, role) FROM wanted
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = db) \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', db, role) FROM wanted \gexec

-- Each role reaches its own database only.
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', db) FROM wanted \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', db, role) FROM wanted \gexec

-- The egress proxy's read-only role (epic #50, ADR 0035), only when auth.egressReader.enabled sets EGRESS_ROLE. It may
-- connect to the app database and read and write what egress.grant_proxy_reader grants (the egress rule tables to read,
-- its own status table to write). This startup pass grants only when the function already exists. The app reconciles
-- grants after migrations using charts/cela egressProxy.database.role, which must match EGRESS_ROLE.
\getenv egress_role EGRESS_ROLE
\getenv egress_password EGRESS_PASSWORD
\if :{?egress_role}
SELECT format('CREATE ROLE %I LOGIN', :'egress_role')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'egress_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'egress_role', :'egress_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'pi_db', :'egress_role') \gexec
\connect :"pi_db"
SELECT format('SELECT egress.grant_proxy_reader(%L)', :'egress_role')
 WHERE to_regprocedure('egress.grant_proxy_reader(name)') IS NOT NULL \gexec
\endif
