-- Runs once, on first start of an empty Docker volume.
-- The app role must be NOSUPERUSER/NOBYPASSRLS so row-level security applies.
CREATE ROLE babyapp LOGIN PASSWORD 'babyapp' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE babytracker OWNER babyapp;
CREATE DATABASE babytracker_test OWNER babyapp;
\connect babytracker
CREATE EXTENSION IF NOT EXISTS citext;
\connect babytracker_test
CREATE EXTENSION IF NOT EXISTS citext;
