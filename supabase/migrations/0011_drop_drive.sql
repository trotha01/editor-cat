-- Google Drive is gone; this takes the last of it out of the database.
--
-- Media now lives in a Cloudflare R2 bucket this deployment owns, found by
-- `assets.r2_key` (0010). What Drive gave us was somebody else's storage quota
-- and a copy of their files that was legible without this app. What it cost was
-- an entire OAuth integration, Auth0 Token Vault, a second consent screen
-- between signing in and reaching the editor, a third screen to choose a folder,
-- and a scope so narrow (`drive.file`) that a video the user dropped into one
-- of our own folders by hand was invisible to us.
--
-- Two things go.
--
-- `drive_folders` (0007) held the folder a person chose for their media. There
-- is nothing to choose any more: files go where the app puts them, which is the
-- same answer for everybody and needs no row.
--
-- `assets.drive_file_id` (0001) was how a second machine found an asset's bytes
-- again. `r2_key` is how it does that now. **Run this only once the migration
-- in the app has moved everything**: dropping the column throws away the last
-- record of where an unmigrated file lives, and while the file itself is still
-- in the user's Drive — nothing here or in the app ever deleted one — nobody
-- would be able to find it from the asset any more.
--
-- Deliberately not folded into 0010. That one is additive and safe to run at
-- any point; this one is destructive and has a precondition, and putting the
-- two in one file would make it impossible to satisfy.

drop table if exists drive_folders;

alter table assets drop column if exists drive_file_id;
