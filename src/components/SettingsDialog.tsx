/**
 * API keys and storage.
 *
 * The keys belong to the user. They are sent per request to our own proxy
 * function, forwarded once to the provider, and never written to a server. The
 * copy in this browser is the only copy, which is why "remember" is a choice
 * rather than a default.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Field, Modal, Spinner, TextInput } from './ui'
import { LLM_MODELS } from '../lib/models'
import { ModelPicker } from './ModelPicker'
import { verifyKey } from '../lib/elevenlabs'
import { run } from '../lib/falClient'
import { clearAll, estimateUsage, formatBytes } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { isMockEnabled } from '../lib/mock'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { releaseAllAssetUrls } from '../state/useAssetStore'

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettingsStore()
  const loadAssets = useAssetStore((state) => state.load)

  const [falTest, setFalTest] = useState<TestState>('idle')
  const [elevenTest, setElevenTest] = useState<TestState>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)

  useEffect(() => {
    if (open) void estimateUsage().then(setUsage)
  }, [open])

  const testFal = async () => {
    setFalTest('testing')
    setTestError(null)
    try {
      // The cheapest possible real call: a tiny LLM completion.
      await run(
        'fal-ai/any-llm',
        { model: settings.llmModel, prompt: 'Reply with: ok' },
        { key: settings.fal },
      )
      setFalTest('ok')
    } catch (cause) {
      setFalTest('fail')
      setTestError(toDisplayMessage(cause))
    }
  }

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
      <span className="text-xs text-emerald-300">✓ working</span>
    ) : state === 'fail' ? (
      <span className="text-xs text-red-300">✕ failed</span>
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

        <Callout tone="info" title="Your keys stay yours">
          Keys are held in this browser and attached to each request as it passes through this
          site&apos;s proxy on its way to the provider. Nothing is stored on a server, and this site
          has no API accounts of its own.
        </Callout>

        <Field
          label="fal.ai API key"
          hint={
            <>
              Used for image generation, video generation, and the “Improve with AI” buttons. Create
              one at <span className="text-ink">fal.ai/dashboard/keys</span>.
            </>
          }
          htmlFor="fal-key"
        >
          <TextInput
            id="fal-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your fal.ai key"
            value={settings.fal}
            onChange={(event) => settings.setKey('fal', event.target.value)}
          />
        </Field>
        <div className="-mt-3 flex items-center gap-3">
          <Button onClick={testFal} disabled={!settings.fal.trim() || falTest === 'testing'}>
            Test connection
          </Button>
          {badge(falTest)}
        </div>

        <Field
          label="ElevenLabs API key"
          hint={
            <>
              Used only to change your recorded voice into another one. Create one at{' '}
              <span className="text-ink">elevenlabs.io</span> under Profile → API keys.
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
            onChange={(event) => settings.setKey('elevenlabs', event.target.value)}
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
            Remember these keys on this device
            <span className="mt-0.5 block text-xs text-ink-dim">
              Saves them in this browser&apos;s local storage so you do not retype them. Leave it
              off on a shared machine — keys will then be forgotten when you close the tab.
            </span>
          </span>
        </label>

        <ModelPicker
          label="Prompt-improvement model"
          options={LLM_MODELS}
          value={settings.llmModel}
          onChange={(id) => settings.setPref('llmModel', id)}
          hint="Routed through fal.ai, so it uses the same key. Cheaper models are perfectly good at rewriting prompts."
        />

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
              Forget API keys
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
