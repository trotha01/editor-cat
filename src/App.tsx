import { useEffect, useState, type CSSProperties } from 'react'
import { IdeaPanel } from './components/IdeaPanel'
import { ImagePanel } from './components/ImagePanel'
import { VideoPanel } from './components/VideoPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { AudioPanel } from './components/AudioPanel'
import { CaptionsPanel } from './components/CaptionsPanel'
import { OrientationToggle } from './components/OrientationToggle'
import { Preview } from './components/Preview'
import { ResizeHandle } from './components/ResizeHandle'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'
import { SettingsDialog } from './components/SettingsDialog'
import { ExportDialog } from './components/ExportDialog'
import { FeedbackBubble } from './components/FeedbackBubble'
import { DriveUploads } from './components/DriveUploads'
import { HydrationStatus } from './components/HydrationStatus'
import { ProjectPicker } from './components/ProjectPicker'
import { ProjectsError } from './components/ProjectsError'
import { SyncStatus } from './components/SyncStatus'
import { Button, LinkButton } from './components/ui'
import { usePersistedState } from './hooks/usePersistedState'
import { usePlayback } from './hooks/usePlayback'
import { useUndoRedoShortcut } from './hooks/useUndoRedoShortcut'
import { useProjectStore } from './state/useProjectStore'
import { installFlushOnExit, useProjectsStore } from './state/useProjectsStore'
import { useSettingsStore } from './state/useSettingsStore'
import { WORDS_HASH } from './lib/route'
import { isMockEnabled } from './lib/mock'

const TABS = [
  { id: 'idea', label: '1 · Idea', hint: 'Brainstorm scene ideas from a word' },
  { id: 'image', label: '2 · Image', hint: 'Make images from a prompt' },
  { id: 'video', label: '3 · Video', hint: 'Animate an image into a clip' },
  { id: 'library', label: 'Library', hint: 'Everything you have made' },
  { id: 'captions', label: '4 · Captions', hint: 'Transcribe the audio into karaoke captions' },
  { id: 'audio', label: '5 · Audio', hint: 'Record voiceovers, layer takes, add music' },
] as const

type TabId = (typeof TABS)[number]['id']

/** Bounds for dragging the sidebar with {@link ResizeHandle}. */
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 640
const DEFAULT_SIDEBAR_WIDTH = 416

export default function App() {
  const [tab, setTab] = useState<TabId>('idea')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  const [sidebarWidth, setSidebarWidth] = usePersistedState(
    'editor-cat.sidebarWidth.v1',
    DEFAULT_SIDEBAR_WIDTH,
  )
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState(
    'editor-cat.sidebarCollapsed.v1',
    false,
  )

  const duration = useProjectStore((state) => state.duration())
  const fps = useProjectStore((state) => state.project.fps)
  const clipCount = useProjectStore((state) => state.project.clips.length)
  const canUndo = useProjectStore((state) => state.canUndo())
  const canRedo = useProjectStore((state) => state.canRedo())

  const playback = usePlayback(duration)
  useUndoRedoShortcut(useProjectStore)

  useEffect(() => {
    // Loads the project list and opens one, or falls back to the single local
    // project when there is no account behind this build.
    void useProjectsStore.getState().start()
    // Whether this deployment pays for the voice features or asks the visitor
    // for a key. Every voice control on screen reads the answer, so it is asked
    // once here rather than by each of them.
    void useSettingsStore.getState().loadElevenLabsSupport()

    return installFlushOnExit()
  }, [])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span aria-hidden className="text-xl">
          🎬
        </span>
        <h1 className="text-sm font-semibold">editor-cat</h1>

        <ProjectPicker onOpenSettings={() => setSettingsOpen(true)} />

        <SyncStatus />

        {isMockEnabled() ? (
          <span className="rounded-full bg-amber-500/20 px-2.5 py-1 text-xs text-amber-800">
            mock mode
          </span>
        ) : null}

        <Button
          onClick={() => useProjectStore.getState().undo()}
          disabled={!canUndo}
          title="Undo (Ctrl/Cmd+Z)"
          aria-label="Undo"
        >
          <span aria-hidden>↶</span>
        </Button>
        <Button
          onClick={() => useProjectStore.getState().redo()}
          disabled={!canRedo}
          title="Redo (Ctrl/Cmd+Shift+Z)"
          aria-label="Redo"
        >
          <span aria-hidden>↷</span>
        </Button>

        {/* The other page. Up here rather than in the step nav, because it is
            not a step of this project — it is somewhere else to be. */}
        <LinkButton href={WORDS_HASH} title="Upload and order videos for a word">
          <span aria-hidden>🔤</span> Words
        </LinkButton>

        <Button variant="primary" onClick={() => setExportOpen(true)} disabled={clipCount === 0}>
          <span aria-hidden>⬇️</span> Export
        </Button>
        {/* Last, and last on the words page too: Settings is the one button in
            the same place on both pages, so it stays findable by position. */}
        <Button onClick={() => setSettingsOpen(true)}>
          <span aria-hidden>⚙️</span> Settings
        </Button>
      </header>

      {/* Outside the sidebar and above the tabs: a project list that never
          arrived is not about whichever panel happens to be open, and the
          sidebar can be collapsed. */}
      <ProjectsError />

      {/* Stacked, this scrolls as one column. Side by side it must not: the two
          columns are then as tall as the window, and each scrolls on its own —
          which is what stops a tall panel on the left, or a tall preview on the
          right, from pushing the timeline off the bottom of the screen. */}
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:gap-0 lg:overflow-hidden">
        <section
          className={`flex w-full shrink-0 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto ${
            sidebarCollapsed ? 'lg:w-11' : 'sidebar-column'
          }`}
          style={
            sidebarCollapsed
              ? undefined
              : ({ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties)
          }
        >
          <div className="flex items-center gap-1">
            {/* Collapsing only makes sense once the sidebar sits beside the
                player rather than above it, so the button stays out of the
                stacked mobile layout entirely. */}
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden shrink-0 rounded-lg border border-line bg-surface px-2 py-2 text-xs text-ink-dim transition hover:text-ink lg:block"
            >
              <span aria-hidden>{sidebarCollapsed ? '»' : '«'}</span>
            </button>

            <nav
              className={`flex flex-1 gap-1 rounded-xl border border-line bg-surface p-1 ${
                sidebarCollapsed ? 'lg:hidden' : ''
              }`}
              aria-label="Steps"
            >
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTab(entry.id)}
                  title={entry.hint}
                  aria-current={tab === entry.id}
                  className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium transition ${
                    tab === entry.id ? 'bg-accent text-accent-ink' : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          </div>

          {/* `contents` drops this wrapper out of the box model, so the
              section's own `gap-3` still applies as if these were direct
              children — collapsing only needs to add `lg:hidden` here, not
              rebuild the spacing. */}
          <div className={sidebarCollapsed ? 'flex flex-col gap-3 lg:hidden' : 'contents'}>
            <HydrationStatus />

            {/* Outside the tab panel: a backup started from the Image tab must
                still be able to report a failure once you have moved on. */}
            <DriveUploads />

            <div className="rounded-xl border border-line bg-surface p-4">
              {tab === 'idea' ? <IdeaPanel /> : null}
              {tab === 'image' ? <ImagePanel /> : null}
              {tab === 'video' ? <VideoPanel /> : null}
              {tab === 'library' ? <LibraryPanel currentTime={playback.currentTime} /> : null}
              {tab === 'audio' ? (
                <AudioPanel
                  currentTime={playback.currentTime}
                  onPlay={playback.play}
                  onPause={playback.pause}
                />
              ) : null}
              {tab === 'captions' ? (
                <CaptionsPanel currentTime={playback.currentTime} onSeek={playback.seek} />
              ) : null}
            </div>
          </div>
        </section>

        {sidebarCollapsed ? null : (
          <ResizeHandle
            orientation="horizontal"
            label="Resize sidebar"
            className="hidden lg:flex lg:mx-1"
            onResize={(delta) =>
              setSidebarWidth((width) =>
                Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width + delta)),
              )
            }
          />
        )}

        <section className="flex min-w-0 flex-1 flex-col gap-4 lg:min-h-0 lg:overflow-y-auto">
          <OrientationToggle />

          {/* The transport lives inside the preview rather than beside it, so
              that fullscreen takes both: a picture you cannot pause or scrub
              is barely worth going fullscreen for. */}
          <Preview currentTime={playback.currentTime} playing={playback.playing}>
            <Transport
              currentTime={playback.currentTime}
              duration={duration}
              fps={fps}
              playing={playback.playing}
              onToggle={playback.toggle}
              onSeek={playback.seek}
            />
          </Preview>

          <Timeline currentTime={playback.currentTime} onSeek={playback.seek} />
        </section>
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Fixed to the corner of the window rather than placed in the layout, so
          it is reachable from every step without taking room from any of them. */}
      <FeedbackBubble />
    </div>
  )
}
