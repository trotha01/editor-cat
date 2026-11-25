# Working notes for this repo

## Manual steps

When a task needs Trevor to do something by hand, never describe it in prose.
Give one of these two, and nothing vaguer:

- **A terminal command** he can paste as-is. Real paths, real flags, no
  `<placeholders>` unless the value genuinely cannot be known — and if one is
  unavoidable, give the command that produces it first. This is macOS, so
  `pbcopy`/`pbpaste` are fair game.
- **An exact click path in Chrome.** A direct URL where one exists, then the
  literal labels of what to click, in order, in the order they appear on screen.
  "Authentication → Third-Party Auth → Add integration" beats "register the
  provider in the dashboard".

Numbered steps, one action each. If a step produces a value a later step needs,
say where it appears and what it looks like.

Dashboard work that cannot be done from a terminal — Supabase, Auth0, Netlify,
Google Cloud — still gets the click path, not a summary of the outcome.
