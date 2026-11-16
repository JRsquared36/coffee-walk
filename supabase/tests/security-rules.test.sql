-- Tests for the security rules in supabase/migrations/0001_beta_schema.sql.
-- Run with: npm run test:database   (see supabase/README.md)
--
-- Each test acts as a particular person, tries something, and checks the database allowed or
-- refused it. Everything happens inside one transaction that is undone at the end.
-- A failure stops the run with "TEST FAILED".

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;
begin;

-- ---------- Helpers ----------
create schema tests;
grant usage on schema tests to anon, authenticated;

-- Act as someone for the statements that follow: 'anon' (not signed in), or 'authenticated' with a user id.
create function tests.act_as(role_name text, user_id uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when user_id is null then '' else json_build_object('sub', user_id)::text end, true);
  execute format('set local role %I', role_name);
end $$;

-- The statement must be refused by a rule or a constraint.
create function tests.refused(statement text, label text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when insufficient_privilege or check_violation or unique_violation or foreign_key_violation or not_null_violation then
    raise notice 'ok  refused: %', label;
    return;
  end;
  raise exception 'TEST FAILED (this should have been refused): %', label;
end $$;

-- The statement must run and change exactly this many rows. 0 means "the rules hid the row from you".
create function tests.changes(statement text, expected_rows bigint, label text) returns void language plpgsql as $$
declare changed_rows bigint;
begin
  execute statement;
  get diagnostics changed_rows = row_count;
  if changed_rows <> expected_rows then
    raise exception 'TEST FAILED (% rows changed, expected %): %', changed_rows, expected_rows, label;
  end if;
  raise notice 'ok  % row(s): %', changed_rows, label;
end $$;

-- The query (which returns one number) must return this number.
create function tests.sees(count_query text, expected bigint, label text) returns void language plpgsql as $$
declare actual bigint;
begin
  execute count_query into actual;
  if actual is distinct from expected then
    raise exception 'TEST FAILED (got %, expected %): %', actual, expected, label;
  end if;
  raise notice 'ok  sees %: %', actual, label;
end $$;
grant execute on all functions in schema tests to anon, authenticated;

-- ---------- The cast ----------
-- ana and ben: on the beta list.   cat: signed in, not on the list.
-- dan: on the list, but his email was never confirmed.   eve: on the list; signs in as "Eve@Example.com".
insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ana@example.com', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'ben@example.com', now()),
  ('cccccccc-0000-0000-0000-000000000003', 'cat@example.com', now()),
  ('dddddddd-0000-0000-0000-000000000004', 'dan@example.com', null),
  ('eeeeeeee-0000-0000-0000-000000000005', 'Eve@Example.com', now());
insert into public.beta_members (email) values ('ana@example.com'), ('ben@example.com'), ('dan@example.com'), ('eve@example.com');

-- ---------- Ana, a beta member ----------
select tests.act_as('authenticated', 'aaaaaaaa-0000-0000-0000-000000000001');
select tests.sees($$ select public.is_beta_member()::int $$, 1, 'Ana is recognised as a beta member');
select tests.changes($$ insert into public.profiles (id, username) values (auth.uid(), 'ana') $$, 1, 'Ana creates her profile');
select tests.changes($$ insert into public.check_ins (place_id, rating, note, tags) values ('place-one', 5, 'Great flat white', '{cozy-quiet}') $$, 1, 'Ana checks in (user_id filled in for her)');
select tests.sees($$ select count(*) from public.check_ins where user_id = auth.uid() $$, 1, 'Ana sees her check-in');

select tests.refused($$ insert into public.profiles (id, username) values ('bbbbbbbb-0000-0000-0000-000000000002', 'fake_ben') $$, 'Ana creating a profile for Ben');
select tests.refused($$ insert into public.check_ins (user_id, place_id, rating) values ('bbbbbbbb-0000-0000-0000-000000000002', 'place-one', 1) $$, 'Ana checking in as Ben');
select tests.refused($$ select * from public.beta_members $$, 'Ana reading the beta list');
select tests.refused($$ insert into public.beta_members (email) values ('stranger@example.com') $$, 'Ana adding someone to the beta list');
select tests.refused($$ delete from public.beta_members $$, 'Ana emptying the beta list');
select tests.refused($$ select * from auth.users $$, 'Ana reading other people''s sign-in emails');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('place-one', 6) $$, 'a rating of 6');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('place-one', 0) $$, 'a rating of 0');
select tests.refused($$ insert into public.check_ins (place_id, rating, note) values ('place-one', 4, repeat('x', 501)) $$, 'a 501-character note');
select tests.refused($$ insert into public.check_ins (place_id, rating, tags) values ('place-one', 4, '{free-wifi-forever}') $$, 'a tag that is not one of the app''s preferences');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('', 4) $$, 'a check-in with no café');
select tests.refused($$ update public.profiles set username = 'A!' where id = auth.uid() $$, 'a username with capitals and punctuation');

-- ---------- Ben, another beta member ----------
select tests.act_as('authenticated', 'bbbbbbbb-0000-0000-0000-000000000002');
select tests.changes($$ insert into public.profiles (id, username) values (auth.uid(), 'ben') $$, 1, 'Ben creates his profile');
select tests.sees($$ select count(*) from public.check_ins $$, 1, 'Ben sees Ana''s check-in: the feed is shared across the beta');
select tests.sees($$ select count(*) from public.profiles $$, 2, 'Ben sees both profiles');
select tests.changes($$ update public.check_ins set rating = 1 where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$, 0, 'Ben cannot change Ana''s check-in');
select tests.changes($$ delete from public.check_ins where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$, 0, 'Ben cannot delete Ana''s check-in');
select tests.changes($$ update public.profiles set username = 'hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$, 0, 'Ben cannot rename Ana');
select tests.refused($$ update public.profiles set username = 'ana' where id = auth.uid() $$, 'Ben taking the username "ana"');
-- Ana has a profile by now, so the only thing that can refuse this is the rule itself. (The earlier
-- "Ana checking in as Ben" would be refused anyway, because Ben had no profile yet.)
select tests.refused($$ insert into public.check_ins (user_id, place_id, rating) values ('aaaaaaaa-0000-0000-0000-000000000001', 'place-two', 1) $$, 'Ben checking in as Ana');
select tests.changes($$ insert into public.check_ins (place_id, rating, tags) values ('place-two', 3, '{good-coffee,work-friendly}') $$, 1, 'Ben checks in with two tags');
select tests.changes($$ update public.check_ins set rating = 4, note = 'Better on a second visit' where user_id = auth.uid() $$, 1, 'Ben edits his own check-in');
select tests.refused($$ update public.check_ins set user_id = 'aaaaaaaa-0000-0000-0000-000000000001' where user_id = auth.uid() $$, 'Ben handing his check-in to Ana');
select tests.changes($$ update public.profiles set username = 'ben_k' where id = auth.uid() $$, 1, 'Ben renames himself');

-- ---------- Cat, signed in but not on the list ----------
select tests.act_as('authenticated', 'cccccccc-0000-0000-0000-000000000003');
select tests.sees($$ select public.is_beta_member()::int $$, 0, 'Cat is not a beta member');
select tests.sees($$ select count(*) from public.check_ins $$, 0, 'Cat sees no check-ins');
select tests.sees($$ select count(*) from public.profiles $$, 0, 'Cat sees no profiles');
select tests.refused($$ insert into public.profiles (id, username) values (auth.uid(), 'cat') $$, 'Cat creating a profile');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('place-one', 5) $$, 'Cat checking in');
select tests.refused($$ insert into public.beta_members (email) values ('cat@example.com') $$, 'Cat adding herself to the beta list');

-- ---------- Dan, on the list but with an unconfirmed email ----------
select tests.act_as('authenticated', 'dddddddd-0000-0000-0000-000000000004');
select tests.sees($$ select public.is_beta_member()::int $$, 0, 'Dan is not let in until his email is confirmed');
select tests.sees($$ select count(*) from public.check_ins $$, 0, 'Dan sees no check-ins');

-- ---------- Eve, listed in lower case, signed in with capitals ----------
select tests.act_as('authenticated', 'eeeeeeee-0000-0000-0000-000000000005');
select tests.sees($$ select public.is_beta_member()::int $$, 1, 'Eve is matched whatever the capitals in her email');
select tests.sees($$ select count(*) from public.check_ins $$, 2, 'Eve sees both check-ins before she has a profile');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('place-one', 5) $$, 'Eve checking in before choosing a username');

-- ---------- Nobody signed in ----------
select tests.act_as('anon');
select tests.sees($$ select count(*) from public.check_ins $$, 0, 'a visitor who is not signed in sees no check-ins');
select tests.sees($$ select count(*) from public.profiles $$, 0, 'a visitor who is not signed in sees no profiles');
select tests.refused($$ insert into public.check_ins (user_id, place_id, rating) values ('aaaaaaaa-0000-0000-0000-000000000001', 'place-one', 1) $$, 'a visitor posting as Ana');
select tests.refused($$ select * from public.beta_members $$, 'a visitor reading the beta list');
select tests.refused($$ select public.is_beta_member() $$, 'a visitor asking whether they are a member');

-- ---------- The owner removes Ben from the list ----------
reset role;
delete from public.beta_members where email = 'ben@example.com';
select tests.act_as('authenticated', 'bbbbbbbb-0000-0000-0000-000000000002');
select tests.sees($$ select count(*) from public.check_ins $$, 0, 'once removed from the list, Ben sees nothing');
select tests.refused($$ insert into public.check_ins (place_id, rating) values ('place-two', 5) $$, 'Ben checking in after being removed');
select tests.changes($$ delete from public.check_ins where user_id = auth.uid() $$, 0, 'Ben can no longer delete, either');
select tests.act_as('authenticated', 'aaaaaaaa-0000-0000-0000-000000000001');
select tests.sees($$ select count(*) from public.check_ins $$, 2, 'Ana still sees Ben''s earlier check-in');

-- ---------- The owner deletes Ben's account ----------
reset role;
delete from auth.users where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select tests.act_as('authenticated', 'aaaaaaaa-0000-0000-0000-000000000001');
select tests.sees($$ select count(*) from public.check_ins $$, 1, 'deleting an account removes its check-ins');
select tests.sees($$ select count(*) from public.profiles $$, 1, 'and its profile');

reset role;
rollback;
\o
\echo 'ALL SECURITY RULE TESTS PASSED'
