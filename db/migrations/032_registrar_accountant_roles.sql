-- 032_registrar_accountant_roles.sql
-- Adds the Registrar and Accountant staff roles to the user_role enum.
-- Idempotent. (ADD VALUE cannot run inside a transaction block.)
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Registrar';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Accountant';
