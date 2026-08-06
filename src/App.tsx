import { useEffect, useState } from 'react'
import { ImagePanel } from './components/ImagePanel'
import { VideoPanel } from './components/VideoPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { AudioPanel } from './components/AudioPanel'
import { OrientationToggle } from './components/OrientationToggle'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'
import { SettingsDialog } from './components/SettingsDialog'
import { ExportDialog } from './components/ExportDialog'
import { DriveUploads } from './components/DriveUploads'
import { HydrationStatus } from './components/HydrationStatus'
import { ProjectPicker } from './components/ProjectPicker'
import { SyncStatus } from './components/SyncStatus'
import { Button } from './components/ui'
import { usePlayback } from './hooks/usePlayback'
import { useAssetStore } from './state/useAssetStore'
import { useDriveStore } from './state/useDriveStore'
import { useProjectStore } from './state/useProjectStore'
import { installFlushOnExit, useProjectsStore } from './state/useProjectsStore'
import { setIngestListener } from './lib/media'
import { recordAsset } from './lib/sync/assetSync'
import { isMockEnabled } from './lib/mock'

const TABS = [
  { id: 'image', label: '1 · Image', hint: 'Make images from a prompt' },
  { id: 'video', label: '2 · Video', hint: 'Animate an image into a clip' },
  { id: 'library', label: 'Library', hint: 'Everything you have made' },
  { id: 'audio', label: '3 · Audio', hint: 'Record voiceovers, layer takes, add music' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('image')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  const loadAssets = useAssetStore((state) => state.load)
  const duration = useProjectStore((state) => state.duration())
  const clipCount = useProjectStore((state) => state.project.clips.length)

  const playback = usePlayback(duration)

  useEffect(() => {
    void loadAssets()
    // Loads the project list and opens one, or falls back to the single local
    // project when there is no account behind this build.
    void useProjectsStore.getState().start()

    return installFlushOnExit()
  }, [loadAssets])

  useEffect(() => {
    // Every panel reaches durable storage through this one hook, so generated
    // images, rendered clips, recordings and manual uploads are all backed up
    // and catalogued without any of them knowing Drive or Supabase exist.
    setIngestListener((asset, blob) => {
      useDriveStore.getState().uploadAsset(asset, blob)
      void recordAsset(asset, blob.size)
    })
    return () => setIngestListener(null)
  }, [])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span aria-hidden className="text-xl">
          🎬
        </span>
        <h1 className="text-sm font-semibold">editor-cat</h1>

        <ProjectPicker />

        <SyncStatus />

        {isMockEnabled() ? (
          <span className="rounded-full bg-amber-500/20 px-2.5 py-1 text-xs text-amber-800">
            mock mode
          </span>
        ) : null}

        <Button onClick={() => setSettingsOpen(true)}>
          <span aria-hidden>⚙️</span> Settings
        </Button>
        <Button variant="primary" onClick={() => setExportOpen(true)} disabled={clipCount === 0}>
          <span aria-hidden>⬇️</span> Export
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row">
        <section className="flex w-full shrink-0 flex-col gap-3 lg:w-[26rem]">
          <nav
            className="flex gap-1 rounded-xl border border-line bg-surface p-1"
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

          <HydrationStatus />

          {/* Outside the tab panel: a backup started from the Image tab must
              still be able to report a failure once you have moved on. */}
          <DriveUploads />

          <div className="rounded-xl border border-line bg-surface p-4">
            {tab === 'image' ? <ImagePanel /> : null}
            {tab === 'video' ? <VideoPanel /> : null}
            {tab === 'library' ? <LibraryPanel /> : null}
            {tab === 'audio' ? (
              <AudioPanel
                currentTime={playback.currentTime}
                onPlay={playback.play}
                onPause={playback.pause}
              />
            ) : null}
          </div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <OrientationToggle />
          <Preview currentTime={playback.currentTime} playing={playback.playing} />
          <Transport
            currentTime={playback.currentTime}
            duration={duration}
            playing={playback.playing}
            onToggle={playback.toggle}
            onSeek={playback.seek}
          />
          <Timeline currentTime={playback.currentTime} onSeek={playback.seek} />
        </section>
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  )
}
