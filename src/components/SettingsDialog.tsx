/**
 * Preferences and storage.
 *
 * There are no API keys here any more: images, video and captions run on the
 * deployment's fal.ai account, and the voice features on its ElevenLabs one.
 * Nothing a visitor can type would be spent, so nothing asks them to type it —
 * and nothing explains it either. Whose account pays is not a preference, and a
 * settings screen that answers a question nobody asked is just noise on the way
 * to the controls that are actually here.
 *
 * What is left is what genuinely belongs to this browser: which models the
 * prompt improver uses, the account, Drive, and the media stored on this device.
 * All of which is as much use on the word pages as in the editor — Drive most of
 * all, since the shelf lives in the folder this dialog names — so the same dialog
 * opens from both, minus the one section that is about a project.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Modal } from './ui'
import { LLM_MODELS } from '../lib/models'
import { ModelPicker } from './ModelPicker'
import { AccountSettings } from './AccountSettings'
import { DriveSettings } from './DriveSettings'
import { ProjectSettings } from './ProjectSettings'
import { clearAll, estimateUsage, formatBytes } from '../lib/db'
import { isMockEnabled } from '../lib/mock'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { releaseAllAssetUrls } from '../state/useAssetStore'

export function SettingsDialog({
  open,
  onClose,
  showProject = true,
}: {
  open: boolean
  onClose: () => void
  /**
   * Whether to offer the settings that belong to the open project.
   *
   * False on the word pages, which have no project open — nothing there ever
   * asked the project list to load, so the name in that field would be the empty
   * document's, and typing in it would rename a project nobody chose.
   */
  showProject?: boolean
}) {
  const settings = useSettingsStore()
  const loadAssets = useAssetStore((state) => state.load)

  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)

  useEffect(() => {
    if (open) void estimateUsage().then(setUsage)
  }, [open])

  const wipe = async () => {
    if (
      !window.confirm('Delete every generated image, video and recording stored in this browser?')
    ) {
      return
    }
    releaseAllAssetUrls()
    await clearAll()
    await loadAssets()
    setUsage(await estimateUsage())
    window.location.reload()
  }

  return (
    <Modal open={open} onClose={onClose} title="Settings" wide>
      <div className="flex flex-col gap-5">
        {isMockEnabled() ? (
          <Callout tone="info" title="Mock mode is on">
            Every AI call is faked locally, so no keys are needed and nothing is charged. Turn off{' '}
            <code>VITE_MOCK_PROVIDERS</code> to use the real providers.
          </Callout>
        ) : null}

        {showProject ? <ProjectSettings /> : null}

        <ModelPicker
          label="Video prompt-improvement model"
          options={LLM_MODELS}
          value={settings.llmModel}
          onChange={(id) => settings.setPref('llmModel', id)}
          hint="Routed through fal.ai, so it is covered by this site's own key. Cheaper models are perfectly good at rewriting prompts. The image prompt is not offered as a choice — it always goes to Claude, since every clip is built from it."
        />

        <AccountSettings />

        <DriveSettings />

        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
          <p className="text-sm font-medium">Stored media</p>
          <p className="text-xs text-ink-dim">
            {usage
              ? `Using ${formatBytes(usage.used)}${usage.quota ? ` of about ${formatBytes(usage.quota)} available` : ''}.`
              : 'Generated media is kept in this browser so your project survives a refresh.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={wipe}>
              Delete all stored media
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
