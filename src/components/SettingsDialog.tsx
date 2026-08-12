/**
 * Preferences and storage.
 *
 * There are no API keys here any more, and their absence is the feature: images,
 * video and captions run on the deployment's fal.ai account, and the voice
 * features on its ElevenLabs one. Nothing a visitor can type would be spent, so
 * nothing asks them to type it — a field that only ever produced a second way to
 * pay for the same thing is worse than no field.
 *
 * What is left is what genuinely belongs to this browser: which models the
 * prompt improver uses, the account, Drive, and the media stored on this device.
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

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettingsStore()
  // Whether the voice features are set up here at all. Nothing a visitor can do
  // changes it, so this only decides which half of one sentence is true.
  const siteEleven = settings.siteElevenLabs
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

        <ProjectSettings />

        <Callout tone="info" title="No keys needed">
          Everything runs on this site&apos;s own accounts: images, video and captions on its fal.ai
          account, and the voice features — changing a recorded voice, and fixing a clip that
          mispronounces its line — on its ElevenLabs one.{' '}
          {siteEleven
            ? 'Nothing is asked of you and nothing is stored in this browser.'
            : 'Voice generation is not set up on this deployment, so those two are unavailable until whoever runs it sets ELEVENLABS_API_KEY.'}
        </Callout>

        <ModelPicker
          label="Prompt-improvement model"
          options={LLM_MODELS}
          value={settings.llmModel}
          onChange={(id) => settings.setPref('llmModel', id)}
          hint="Routed through fal.ai, so it is covered by this site's own key. Cheaper models are perfectly good at rewriting prompts."
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
