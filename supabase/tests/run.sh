#!/usr/bin/env bash
# Runs the security-rule tests against a THROWAWAY Postgres database.
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost/coffee_walk_test npm run test:database
#
# It loads a stand-in for Supabase, then every migration, then the tests.
# The stand-in DROPS tables, so this script refuses to run against a real Supabase database.
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a throwaway local Postgres database (never your Supabase project).}"
if [[ "$TEST_DATABASE_URL" == *supabase* ]]; then
  echo "Refusing to run: TEST_DATABASE_URL looks like a real Supabase database, and these tests drop tables." >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
files=(-f supabase/tests/supabase-stand-in.sql)
for migration in supabase/migrations/*.sql; do files+=(-f "$migration"); done
files+=(-f supabase/tests/security-rules.test.sql)

# psql prefixes each line with the file and line number; strip that so the results read cleanly.
psql "$TEST_DATABASE_URL" --set ON_ERROR_STOP=1 --quiet "${files[@]}" 2>&1 | sed -E 's/^psql:[^ ]+ (NOTICE|ERROR):  /\1: /; s/^NOTICE: //'
