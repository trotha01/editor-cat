/**
 * One line in the corner of the staging site saying which PR it is showing.
 *
 * Every PR is deployed to the same address, so the address cannot tell you whose
 * work is on it, and the reflex that follows — refresh, look again, conclude the
 * change did not work — is the mistake this exists to head off. It is not the
 * only marker of the build: `VERSION` in the console is the one that answers on
 * a screen refusing to let you in. This is the one you do not have to think to
 * ask, on the one deployment where the question comes up constantly.
 *
 * Which makes staying out of the way the whole design. It is a line of text
 * until clicked, it takes no clicks that were not aimed at it, and it can be
 * sent away. What it must never do is be wrong: see `badgeBuild`, which is why
 * nothing here draws until the page agrees it is the staging site.
 */
import { useEffect, useState } from 'react'
import { badgeBuild, buildAge, formatAge, isStale, prUrl, STAGING } from '../lib/stagingBuild'

/**
 * How often the age is worked out again.
 *
 * Fine enough that "just now" turns into "1m ago" within a few seconds of it
 * becoming true, and that the colour changes at half an hour while someone is
 * looking at it rather than after they next reload — which is exactly when a
 * stale build most needs to say so.
 */
const TICK_MS = 15_000

/**
 * Where a dismissal is remembered.
 *
 * `sessionStorage`, so it lasts the tab and not a moment longer. The badge is
 * there to be checked against the next deploy, and one that stays hidden for
 * good after a single stray click has stopped being a deploy marker.
 */
const DISMISSED_KEY = 'editor-cat.stagingBadge.dismissed.v1'

function wasDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    // Storage unavailable is not worth a crash over a badge.
    return false
  }
}

export function StagingBadge() {
  // Both halves of the guard, read where they actually live: what the bundle was
  // built as, and where the browser says it is. Neither is enough on its own.
  const build = badgeBuild(window.location.hostname, STAGING)

  const [dismissed, setDismissed] = useState(wasDismissed)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const showing = build !== null && !dismissed

  useEffect(() => {
    if (!showing) return
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [showing])

  if (!build || dismissed) return null

  const age = buildAge(build, now)
  const stale = isStale(age)
  const url = prUrl(build)

  const dismiss = () => {
    setDismissed(true)
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Then it is back on the next reload, which is the harmless direction for
      // this to fail in.
    }
  }

  return (
    <aside
      aria-label="Staging build"
      // The frame takes no clicks at all, so the editor behind it stays reachable
      // to within a pixel of the badge — which then takes its own. Bottom left is
      // the one corner of this layout with nothing in it: the header's buttons
      // are top right, the timeline runs along the bottom of the other column,
      // and the panel above this scrolls whatever it covers back into view.
      className="pointer-events-none fixed bottom-2 left-2 z-40 max-w-[calc(100vw-1rem)]"
    >
      <div
        // Both fills are opaque, unlike the translucent amber the shared Callout
        // uses: that one is laid over a panel, and this is laid over whatever
        // happens to be underneath it — including, on a narrow screen, the
        // picture. A warning that has to be read through a video is not one.
        className={`pointer-events-auto overflow-hidden rounded-lg border text-[11px] shadow-lg ${
          stale
            ? 'border-amber-500/50 bg-amber-100 text-amber-900'
            : 'border-line bg-surface text-ink-dim'
        }`}
      >
        <div className="flex items-center gap-1.5 px-2 py-1">
          {stale ? (
            // Carries the warning in something other than the colour, which on
            // its own says nothing to a reader who cannot see it.
            <span
              role="img"
              aria-label="Stale build"
              title="Over half an hour old — probably not the build you are waiting for"
              className="shrink-0"
            >
              ⚠
            </span>
          ) : null}

          {url ? (
            <>
              {/* A new tab rather than this one: leaving the page to read the PR
                  would throw away the editor state you were checking. */}
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-medium underline underline-offset-2"
              >
                PR #{build.pr}
              </a>
              <span aria-hidden>·</span>
            </>
          ) : null}

          {/* Everything but the link toggles, so the one thing on this line that
              navigates is the only thing that does. */}
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            title={open ? 'Hide build details' : 'Show build details'}
            className="flex min-w-0 items-center gap-1.5"
          >
            {/* The branch is the part that can be arbitrarily long, so it is the
                part that gives way — cutting the age off instead would lose the
                one field that changes while you watch it. */}
            <span className="truncate">{build.branch}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{build.sha}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatAge(age)}</span>
          </button>

          <button
            type="button"
            onClick={dismiss}
            aria-label="Hide the staging badge"
            title="Hide until this tab is closed"
            className="shrink-0 px-0.5 opacity-60 transition hover:opacity-100"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>

        {open ? (
          <div className="border-t border-black/10 px-2 py-1.5 leading-relaxed">
            {build.title ? <p className="font-medium">{build.title}</p> : null}
            <p>
              {build.author ? `@${build.author} · ` : ''}
              {/* The local time, spelled out. The collapsed line answers "is this
                  recent"; this answers "was it before or after I pushed". */}
              Built {new Date(build.builtAt).toLocaleString()}
            </p>
            {stale ? <p>Over half an hour old — probably not your build.</p> : null}
          </div>
        ) : null}
      </div>
    </aside>
  )
}
