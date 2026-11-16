# Shared check-ins (friends beta)

This folder holds the database side of Coffee Walk's shared check-ins: the tables, the security
rules, and tests for those rules. The database is hosted by [Supabase](https://supabase.com) on its
free plan. The app itself doesn't use it yet; this is the foundation.

## How it works

- **Sign-in:** Google only. No passwords to store.
- **Who gets in:** only people whose email you have added to the `beta_members` table. Anyone else
  can sign in with Google but sees nothing and can't post.
- **Who sees what:** every beta member sees every check-in. Each person can add, change and delete
  only their own.
- **What a check-in holds:** who, Google's ID for the café, a rating (1–5), a note, optional tags
  (cozy & quiet, good coffee…), and when.
- **What is not stored:** the café's name, address or hours. Google's terms allow keeping its place
  ID indefinitely but not that other data, so the app looks it up from the ID when it shows a check-in.

The app will reach the database with a key that is visible in the site's code, like the Google Maps
key. That key protects nothing. The **rules in the database** do: the database checks every read
and write against them, whatever the app's code says. They are in
[`migrations/0001_beta_schema.sql`](migrations/0001_beta_schema.sql), written next to each table.

## One-time setup

Menu names in Supabase and Google Cloud change now and then; if a label differs slightly, look for
the nearest match.

### 1. Create the Supabase project
1. Go to supabase.com, sign up (signing in with GitHub is easiest), and choose **New project**.
2. Name it `coffee-walk`, pick the region nearest you, and keep the **Free** plan.
3. It asks for a database password. Generate one and save it in a password manager. The app never uses it.

### 2. Create the tables and rules
1. In the project, open **SQL Editor** and start a new query.
2. Paste the whole of [`migrations/0001_beta_schema.sql`](migrations/0001_beta_schema.sql) and press **Run**.
3. Open **Table Editor**. You should see `beta_members`, `profiles` and `check_ins`, each marked as having row-level security on.

### 3. Turn on Google sign-in
In **Google Cloud Console**, in the same project as your Maps key:
1. Open the OAuth consent screen (also called **Google Auth Platform**). Set the app name to
   `Coffee Walk`, add your email, and choose **External** users.
2. While the app's status is **Testing**, only Google accounts you list as test users can sign in
   (up to 100). Add yourself and your friends there. Publishing the app removes that list; for
   basic sign-in Google should not require a review, but check what it tells you before publishing.
3. Create an **OAuth client ID** of type **Web application**.
   - Authorized JavaScript origins: `https://jrsquared36.github.io`
   - Authorized redirect URIs: the **Callback URL** that Supabase shows in the next step
     (it looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`).
4. Copy the **Client ID** and **Client secret**.

In **Supabase**:
1. **Authentication → Sign In / Providers → Google**: switch it on and paste the Client ID and Client secret.
2. **Authentication → Sign In / Providers → Email**: switch it **off**, so Google is the only way in.
3. **Authentication → URL Configuration**: set **Site URL** to `https://jrsquared36.github.io/coffee-walk/`
   and add the same address under **Redirect URLs**.

### 4. Add yourself to the beta
In **SQL Editor**, with your own Google email in lower case:
```sql
insert into beta_members (email, note) values ('you@gmail.com', 'me');
```

### 5. What to pass on, and what never to
The app needs two values from **Project Settings → API** (or **API Keys**):
- the **Project URL**, like `https://abcdefgh.supabase.co`
- the **publishable** key (older projects call it the **anon public** key)

Both are public by design and will be visible in the site's code.

**Never share, paste into a chat, or commit:**
- the **secret** key (older name: **service_role**). It bypasses every rule in this folder.
- the database password
- the Google **Client secret**

## Running the beta

Add a friend (their Google email, lower case):
```sql
insert into beta_members (email, note) values ('friend@gmail.com', 'college friend');
```
If Google sign-in is still in Testing, also add them as a test user in Google Cloud.

Remove someone. They can no longer see or post anything; what they already posted stays visible to the others:
```sql
delete from beta_members where email = 'friend@gmail.com';
```

Delete someone's account and everything they posted: **Authentication → Users**, find them, delete.

**The free plan pauses a project after a week with no activity.** If the app suddenly can't reach
the database, open the Supabase dashboard and press **Resume**.

## Testing the rules

```
TEST_DATABASE_URL=postgresql://postgres@localhost/coffee_walk_test npm run test:database
```

This needs a local Postgres with an empty, throwaway database. It never touches Supabase, and refuses
to run if pointed at one, because it drops and recreates tables. It loads a small stand-in for
Supabase, then the migrations, then 50 checks, each acting as a particular person: a member, a
second member, someone signed in but not on the list, someone whose email isn't confirmed, and a
visitor who isn't signed in.

When changing a rule, also weaken it on purpose and confirm a test fails. One rule once passed its
test for the wrong reason.

## Changing the database later

Never edit `0001_beta_schema.sql` after it has been run on the real project. Add a new file,
`0002_…sql`, with only the change, and run that in the SQL Editor. The tests load every migration in order.
