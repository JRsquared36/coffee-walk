-- Makes a plain Postgres database behave enough like Supabase to test our security rules.
-- For a THROWAWAY test database only: it drops and recreates things. run.sh refuses to use it on Supabase.
--
-- What it copies from Supabase:
--   - the "anon" (not signed in) and "authenticated" (signed in) roles the app's requests run as
--   - auth.users, where Supabase keeps sign-ins
--   - auth.uid(), which reads the signed-in person's id from the request
--   - Supabase's habit of letting both roles use every new table and function in "public",
--     leaving row-level security as the only thing in the way. That is why every table needs rules.

set client_min_messages = warning; -- hide "does not exist, skipping" chatter from the clean-up below

drop schema if exists tests cascade;
drop table if exists public.check_ins, public.profiles, public.beta_members cascade;
drop function if exists public.is_beta_member();
drop schema if exists auth cascade;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema auth;
grant usage on schema auth to anon, authenticated;

create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz
);
-- As on Supabase: the app's roles get no access to auth.users.

-- Supabase puts the signed-in person's details in the "request.jwt.claims" setting for each request.
create function auth.uid() returns uuid
  language sql
  stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
