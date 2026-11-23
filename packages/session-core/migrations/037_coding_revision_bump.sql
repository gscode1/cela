-- Migration 034 moved `coding` to version 4 without bumping `revision` (issue #383), so an admin who read the profile
-- at revision R before the upgrade and saved with `expectedRevision: R` after it would pass the lost-update check and
-- write version 5 from version 3, dropping 034's rule set and instructions (ADR 0023: every write that changes
-- something bumps `revision`). This bumps it for the one installation state where 034's write went unbumped: `coding`
-- is still version 4, still last written by `seed`. A profile edited since (any other `updated_by`, or a later
-- version) already carries a bump from `putProfile` and is left alone. A fresh install bumps 1 to 2 here, which is
-- harmless: nothing holds revision 1 yet. Not idempotent as bare SQL (each run adds one); the migration runner records
-- the file, so it runs once. Later seed migrations must bump `revision` themselves (test/seed-revision.test.ts).

update inbox.profiles
   set revision = revision + 1
 where name = 'coding' and current_version = 4 and updated_by = 'seed';
