/**
 * API keys and storage.
 *
 * There is one key field left, and on a properly configured deployment nobody
 * needs it: images, video and captions run on the site's fal.ai account and the
 * voice features on its ElevenLabs one. What it is for is using *your own*
 * ElevenLabs account instead — your quota, your voices, your saved clones —
 * which is a real thing to want and a strange thing to demand.
 *
 * Which of those two the panel is describing is the only thing `siteElevenLabs`
 * changes here, and it changes every sentence: a key that is required and a key
 * that is an alternative are not the same field with a different tone.
 *
 * A key entered here is sent per request to our own proxy function, forwarded
 * once to the provider, and never written to a server. The copy in this browser
 * is the only copy, which is why "remember" is a choice rather than a default.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Field, Modal, Spinner, TextInput } from './ui'
import { LLM_MODELS } from '../lib/models'
import { ModelPicker } from './ModelPicker'
import { AccountSettings } from './AccountSettings'
import { DriveSettings } from './DriveSettings'
import { ProjectSettings } from './ProjectSettings'
import { verifyKey } from '../lib/elevenlabs'
import { clearAll, estimateUsage, formatBytes } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { isMockEnabled } from '../lib/mock'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { releaseAllAssetUrls } from '../state/useAssetStore'

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettingsStore()
  // Whether this deployment pays for the voice features. It decides what this
  // whole panel is *for*: a key that is required, or one that is an alternative
  // to the site's own.
  const siteEleven = settings.siteElevenLabs
  const loadAssets = useAssetStore((state) => state.load)

  const [elevenTest, setElevenTest] = useState<TestState>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)

  useEffect(() => {
    if (open) void estimateUsage().then(setUsage)
  }, [open])

  const testEleven = async () => {
    setElevenTest('testing')
    setTestError(null)
    try {
      await verifyKey(settings.elevenlabs)
      setElevenTest('ok')
    } catch (cause) {
      setElevenTest('fail')
      setTestError(toDisplayMessage(cause))
    }
  }

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

  const badge = (state: TestState) =>
    state === 'testing' ? (
      <Spinner />
    ) : state === 'ok' ? (
      <span className="text-xs text-emerald-700">✓ working</span>
    ) : state === 'fail' ? (
      <span className="text-xs text-red-700">✕ failed</span>
    ) : null

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

        <Callout tone="info" title={siteEleven ? 'No key needed' : 'Your key stays yours'}>
          {siteEleven ? (
            <>
              Everything here runs on this site&apos;s own accounts: images, video and captions on
              its fal.ai account, and the voice features — changing a recorded voice, and fixing a
              clip that mispronounces its line — on its ElevenLabs one. The field below is optional,
              and only for using your own account instead.
            </>
          ) : (
            <>
              This deployment provides no ElevenLabs key of its own, so the voice features need one
              from you. It is held in this browser and attached to each request as it passes through
              this site&apos;s proxy on its way to the provider — never stored on a server. Image
              and video generation and caption transcription need no key either way; they run on
              this site&apos;s own fal.ai account.
            </>
          )}
        </Callout>

        <Field
          label={siteEleven ? 'ElevenLabs API key (optional)' : 'ElevenLabs API key'}
          hint={
            <>
              {siteEleven
                ? 'Use your own ElevenLabs account rather than this site’s: your quota, your voices. '
                : 'Used to change a recorded voice into another one, and to fix a clip that says its line wrong. '}
              Create one at <span className="text-ink">elevenlabs.io</span> under Profile → API
              keys.
            </>
          }
          htmlFor="eleven-key"
        >
          <TextInput
            id="eleven-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your ElevenLabs key"
            value={settings.elevenlabs}
            onChange={(event) => settings.setElevenLabsKey(event.target.value)}
          />
        </Field>
        <div className="-mt-3 flex items-center gap-3">
          <Button
            onClick={testEleven}
            disabled={!settings.elevenlabs.trim() || elevenTest === 'testing'}
          >
            Test connection
          </Button>
          {badge(elevenTest)}
        </div>

        {testError ? (
          <Callout tone="error" title="Connection test failed">
            {testError}
          </Callout>
        ) : null}

        <label className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3">
          <input
            type="checkbox"
            checked={settings.remember}
            onChange={(event) => settings.setRemember(event.target.checked)}
            className="mt-0.5 size-4"
          />
          <span className="text-sm">
            Remember this key on this device
            <span className="mt-0.5 block text-xs text-ink-dim">
              Saves it in this browser&apos;s local storage so you do not retype it. Leave it off on
              a shared machine — the key will then be forgotten when you close the tab.
            </span>
          </span>
        </label>

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
            <Button variant="ghost" onClick={() => settings.forgetKeys()}>
              Forget API key
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
