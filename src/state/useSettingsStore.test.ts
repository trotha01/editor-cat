import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_VIDEO_MODEL } from '../lib/models'
import { migratePrefs, useSettingsStore, type StoredPrefs } from './useSettingsStore'

const PREFS_KEY = 'editor-cat.prefs.v1'

const stored = () =>
  JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>

describe('migratePrefs', () => {
  it('moves an unversioned choice off the models the user no longer pays for', () => {
    // Video now runs on the site's own account, and the old defaults cost two
    // to nine times what the current one does.
    const prefs = migratePrefs({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/veo3/image-to-video',
      llmModel: 'openai/gpt-4o',
    })

    expect(prefs.videoModel).toBe(DEFAULT_VIDEO_MODEL)
  })

  it('keeps the other preferences, which have nothing to do with the change', () => {
    const prefs = migratePrefs({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/wan-i2v',
      llmModel: 'openai/gpt-4o',
    })

    expect(prefs.imageModel).toBe('fal-ai/flux/dev')
    expect(prefs.llmModel).toBe('openai/gpt-4o')
  })

  it('leaves a hand-typed model ID alone, because that choice is unmistakable', () => {
    const prefs = migratePrefs({ videoModel: 'someone/private-model' })
    expect(prefs.videoModel).toBe('someone/private-model')
  })

  it('does not run twice', () => {
    const prefs = migratePrefs({ videoModel: 'fal-ai/veo3/image-to-video', v: 2 })
    expect(prefs.videoModel).toBe('fal-ai/veo3/image-to-video')
  })

  it('falls back to defaults for missing or malformed fields', () => {
    const prefs = migratePrefs({ imageModel: 42 as unknown as string, v: 2 })
    expect(prefs.imageModel).toBe('fal-ai/flux/schnell')
    expect(prefs.videoModel).toBe(DEFAULT_VIDEO_MODEL)
  })

  it('drops a preference the app no longer has, rather than carrying it around', () => {
    // Captions moved to a hosted transcriber, so the in-browser speech model is
    // gone. Anyone who used the app before that has one written into storage.
    const prefs = migratePrefs({ speechModel: 'Xenova/whisper-base', v: 3 } as StoredPrefs)
    expect(prefs).not.toHaveProperty('speechModel')
  })
})

describe('setPref', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists every preference, not just the one being changed', () => {
    // The previous implementation re-listed each key by hand, so a preference
    // someone forgot to add there was silently dropped on the next write.
    const { setPref } = useSettingsStore.getState()

    setPref('imageModel', 'fal-ai/flux/dev')
    setPref('llmModel', 'openai/gpt-4o')
    setPref('videoModel', 'fal-ai/wan-i2v')

    expect(stored()).toMatchObject({
      imageModel: 'fal-ai/flux/dev',
      llmModel: 'openai/gpt-4o',
      videoModel: 'fal-ai/wan-i2v',
    })
  })

  it('stamps the version so the migration does not re-run over a fresh choice', () => {
    useSettingsStore.getState().setPref('videoModel', 'fal-ai/veo3/image-to-video')
    expect(stored().v).toBe(3)
    expect(migratePrefs(stored()).videoModel).toBe('fal-ai/veo3/image-to-video')
  })
})
