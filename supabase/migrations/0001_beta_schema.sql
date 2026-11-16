-- Coffee Walk: shared check-ins for the friends beta.
--
-- How to apply: Supabase dashboard → SQL Editor → paste this whole file → Run. Run it once.
-- Then add your friends' emails to the beta_members table (see supabase/README.md).
--
-- The idea in one paragraph: the app talks to this database directly from the browser, using a
-- key that anyone can read in the site's code. So the key protects nothing. What protects the data
-- is the rules below ("row-level security"): the database itself checks every read and write
-- against them, whatever the app's code says. Each table has its rules written right after it.
--
-- Who may do what:
--   - Not signed in: nothing.
--   - Signed in, but email not on the beta list: nothing.
--   - Beta member: read every profile and check-in; create, change and delete only their own.
--   - The beta list itself: only the project owner, in the Supabase dashboard.

-- ---------------------------------------------------------------------------------------------
-- The beta list: the emails allowed in. You edit it by hand in the dashboard.
-- ---------------------------------------------------------------------------------------------
create table public.beta_members (
  email text primary key check (email = lower(email)),  -- always lower case, so "Jo@x.com" can't slip past "jo@x.com"
  added_at timestamptz not null default now(),
  note text                                             -- for you, e.g. "college friend"
);

-- Rules switched on with no rule granting access means: the app can neither read nor change this
-- table. The second line is belt and braces on top of that.
alter table public.beta_members enable row level security;
revoke all on public.beta_members from anon, authenticated;

-- Is the signed-in person on the beta list? Every rule below asks this.
-- "security definer" lets this one function look at the beta list and at Supabase's own users table,
-- which the app itself can't see. It answers only yes or no.
-- It reads the email from Supabase's users table (not from the sign-in token), and requires that
-- the email has been confirmed, so nobody can claim an address they don't control.
create function public.is_beta_member() returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from auth.users signed_in_user
    join public.beta_members on beta_members.email = lower(signed_in_user.email)
    where signed_in_user.id = auth.uid()
      and signed_in_user.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_beta_member() from public, anon;
grant execute on function public.is_beta_member() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Profiles: one per person, created the first time they sign in and pick a username.
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,  -- the same id Supabase gives the sign-in
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),  -- 3–20 of: a–z, 0–9, underscore
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "beta members can see every profile"
  on public.profiles for select to authenticated
  using (public.is_beta_member());

create policy "a beta member creates only their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid() and public.is_beta_member());

create policy "a beta member changes only their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid() and public.is_beta_member())
  with check (id = auth.uid());

-- No delete rule: a profile goes when the account is deleted (in the dashboard), taking its check-ins with it.

-- ---------------------------------------------------------------------------------------------
-- Check-ins: the heart of it. "I was at this café, here's my rating and a note."
-- ---------------------------------------------------------------------------------------------
create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- Google's ID for the café. Google's terms allow storing this indefinitely, but not the café's
  -- name, address or hours, so those are NOT stored: the app looks them up from the ID when showing a check-in.
  place_id text not null check (length(place_id) between 1 and 300),
  rating smallint not null check (rating between 1 and 5),
  note text not null default '' check (length(note) <= 500),
  -- What the visitor says the café is like, from the same list as the app's preferences
  -- (ASPECTS in js/walk-preferences.js). Over time these can replace Google's guesses when
  -- matching cafés to preferences. Adding a preference to the app means adding it here too.
  tags text[] not null default '{}' check (
    tags <@ array['good-coffee', 'unique-space', 'outdoor-seating', 'cozy-quiet', 'lively-buzzy', 'work-friendly']
  ),
  visited_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.check_ins enable row level security;

-- The feed (newest first), one café's check-ins, and one person's log.
create index check_ins_newest_first on public.check_ins (visited_at desc);
create index check_ins_by_place on public.check_ins (place_id, visited_at desc);
create index check_ins_by_person on public.check_ins (user_id, visited_at desc);

create policy "beta members can see every check-in"
  on public.check_ins for select to authenticated
  using (public.is_beta_member());

create policy "a beta member adds check-ins only as themselves"
  on public.check_ins for insert to authenticated
  with check (user_id = auth.uid() and public.is_beta_member());

create policy "a beta member changes only their own check-ins"
  on public.check_ins for update to authenticated
  using (user_id = auth.uid() and public.is_beta_member())
  with check (user_id = auth.uid());

create policy "a beta member deletes only their own check-ins"
  on public.check_ins for delete to authenticated
  using (user_id = auth.uid() and public.is_beta_member());
