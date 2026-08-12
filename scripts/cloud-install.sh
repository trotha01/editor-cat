#!/bin/bash
# Install dependencies at the start of a cloud session.
#
# Claude Code cloud sessions — the ones a routine creates, and the ones
# `claude --cloud` creates — start from a fresh clone with no node_modules. The
# obvious place to fix that is the environment's setup script, but a setup
# script's filesystem is snapshotted and reused for about a week, so
# node_modules installed there would freeze at whatever package-lock.json looked
# like when the snapshot was built and then quietly drift. Installing per
# session costs a minute and is always right.
#
# CLAUDE_CODE_REMOTE is 'true' on a cloud session VM and is never true locally,
# so this exits before doing anything on a laptop, where node_modules already
# exists and npm ci would delete and rebuild it for no reason.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0

# The SessionStart hook also fires on resume, and a resumed session still has
# the dependencies the startup run installed.
[ -d node_modules ] && exit 0

npm ci

# Hooks that exit non-zero are reported as failures in the transcript; npm ci
# failing is worth seeing there, so let its status through rather than
# swallowing it.
exit $?
