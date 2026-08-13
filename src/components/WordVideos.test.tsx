/**
 * The screen a word's videos are ordered and labelled on.
 *
 * Ordering is the reason the page exists, and it is the one control here that
 * has three ways in: the strip of clips in the player, a drag handle on each row
 * and a pair of buttons on each row. The buttons are what a keyboard has and
 * what a test can press, so they are what is asserted — a drag that stopped
 * working would still be caught by the store test underneath all three of them,
 * but a pair of arrows that silently stopped moving anything would not be caught
 * anywhere else.
 *
 * What the strip is asserted for instead is what it says: the labels on it are
 * read off the order, so pressing an arrow has to move the words "Intro" and
 * "Outro" as well as the takes.
 *
 * The missing-file row is asserted because it is the state nobody develops
 * against: the videos are listed in this browser and their bytes are cached in
 * it, so a word opened on a second machine is a run of rows with nothing behind
 * them, and drawing those as blanks would look like the takes had been lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { WordVideos } from './WordVideos'
import { useAssetStore } from '../state/useAssetStore'
import { useDriveStore } from '../state/useDriveStore'
import { useWordsStore } from '../state/useWordsStore'
import type { DriveFile } from '../lib/google/drive'
import type { Asset } from '../lib/types'
import type { Word } from '../lib/words'

const pickVideos = vi.fn<(parentId: string) => Promise<DriveFile[]>>()
const moveFile = vi.fn<(fileId: string, parentId: string) => Promise<void>>()

vi.mock('../lib/google/picker', () => ({
  isPickerConfigured: () => true,
  pickVideos: (parentId: string) => pickVideos(parentId),
}))

// Only the one call is stood in for: the rest of the module is what the store
// and the byte-fetching hook are built on, and replacing all of it would be
// mocking the thing under test out from under itself.
vi.mock('../lib/google/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/google/drive')>()),
  moveFile: (fileId: string, parentId: string) => moveFile(fileId, parentId),
}))

vi.mock('../lib/db', () => ({
  putWord: () => Promise.resolve(),
  putLanguage: () => Promise.resolve(),
  deleteWord: () => Promise.resolve(),
  deleteLanguage: () => Promise.resolve(),
  listWords: () => Promise.resolve([]),
  listLanguages: () => Promise.resolve([]),
  putAsset: () => Promise.resolve(),
  getAsset: () => Promise.resolve(undefined),
  deleteAsset: () => Promise.resolve(),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

function asset(id: string, name: string): Asset {
  return {
    id,
    kind: 'video',
    blobKey: `blob_${id}`,
    mimeType: 'video/mp4',
    name,
    duration: 4,
    createdAt: 0,
  }
}

const WORD: Word = {
  id: 'word_gato',
  languageId: 'lang_es',
  text: 'gato',
  videos: [
    { id: 'v1', assetId: 'asset_a', role: 'intro', transcript: 'Ready?' },
    { id: 'v2', assetId: 'asset_b', role: 'word' },
  ],
  createdAt: 0,
}

/** The word as the store holds it now, which is what every edit is checked against. */
function current(): Word {
  return useWordsStore.getState().words.find((entry) => entry.id === WORD.id)!
}

function mount(word: Word = WORD) {
  useWordsStore.setState({
    tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0 }],
    languages: [{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }],
    words: [word],
    selectedTierId: 'tier_1',
    selectedLanguageId: 'lang_es',
    selectedWordId: word.id,
    loading: false,
    loaded: true,
  })
  const view = render(<WordVideos word={word} />)
  return {
    // The page re-renders from the store in the real app; here the prop is
    // passed in, so an edit has to be handed back the same way to be seen.
    rerender: () => view.rerender(<WordVideos word={current()} />),
    // The player's own element, which is the first on the page — it is drawn
    // above the list, and the rest are the thumbnails on the rows.
    player: () => view.container.querySelector('video')!,
  }
}

beforeEach(() => {
  useAssetStore.setState({
    assets: [asset('asset_a', 'intro.mp4'), asset('asset_b', 'gato.mp4')],
    loading: false,
  })
})

/** The detail rows, as against the strip of clips in the player above them. */
function rows() {
  return within(screen.getByRole('list', { name: 'Videos in detail' })).getAllByRole('listitem')
}

/** The clips in the player, in the order they are laid out. */
function clips() {
  return within(screen.getByRole('list', { name: 'Clips in order' })).getAllByRole('listitem')
}

describe('the run of videos', () => {
  it('lists them in the order they play, numbered', () => {
    mount()

    const listed = rows()
    expect(within(listed[0]!).getByText('intro.mp4')).toBeInTheDocument()
    expect(within(listed[0]!).getByText('1')).toBeInTheDocument()
    expect(within(listed[1]!).getByText('gato.mp4')).toBeInTheDocument()
  })

  it('moves one later, and moves it back', () => {
    const { rerender } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Move intro.mp4 later' }))
    expect(current().videos.map((video) => video.assetId)).toEqual(['asset_b', 'asset_a'])

    rerender()
    fireEvent.click(screen.getByRole('button', { name: 'Move intro.mp4 earlier' }))
    expect(current().videos.map((video) => video.assetId)).toEqual(['asset_a', 'asset_b'])
  })

  it('offers no way off either end of the run', () => {
    mount()

    expect(screen.getByRole('button', { name: 'Move intro.mp4 earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move gato.mp4 later' })).toBeDisabled()
  })

  /**
   * The ends of a run are not labelled by anybody, so there is nothing on their
   * rows to press — the label they wear is read out, and moving them is what
   * changes it. Only the takes in between have a switch, and it is optional.
   */
  it('reads the labels of the ends out rather than offering them', () => {
    mount()

    const listed = rows()
    expect(within(listed[0]!).getByText('Intro')).toBeInTheDocument()
    expect(within(listed[1]!).getByText('Outro')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Label .* as the word/ })).not.toBeInTheDocument()
  })

  it('takes the optional word label off a take in the middle, and puts it back', () => {
    useAssetStore.setState({
      assets: [
        asset('asset_a', 'intro.mp4'),
        asset('asset_b', 'gato.mp4'),
        asset('asset_c', 'outro.mp4'),
      ],
      loading: false,
    })
    const { rerender } = mount({
      ...WORD,
      videos: [...WORD.videos, { id: 'v3', assetId: 'asset_c', role: 'word' }],
    })

    const label = () => screen.getByRole('button', { name: 'Label gato.mp4 as the word' })
    expect(label()).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(label())
    expect(current().videos[1]?.role).toBeUndefined()

    rerender()
    expect(label()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(label())
    expect(current().videos[1]?.role).toBe('word')
  })

  it('attaches a transcript to one video without touching the others', () => {
    mount()

    fireEvent.change(screen.getByRole('textbox', { name: 'Transcript for gato.mp4' }), {
      target: { value: 'el gato' },
    })

    expect(current().videos.map((video) => video.transcript)).toEqual(['Ready?', 'el gato'])
  })

  it('takes one out of the run', () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Remove intro.mp4' }))

    expect(current().videos.map((video) => video.id)).toEqual(['v2'])
  })

  it('says so when this browser does not hold the file', () => {
    useAssetStore.setState({ assets: [asset('asset_b', 'gato.mp4')], loading: false })
    mount()

    expect(screen.getByText('The file for this one is not on this machine.')).toBeInTheDocument()
    // Still a row, still countable: two videos are listed and one of them is
    // simply not here. The strip above shows the one clip it can play.
    expect(rows()).toHaveLength(2)
    expect(clips()).toHaveLength(1)
  })
})

describe('watching them together', () => {
  it('opens on the first video and says how much there is', () => {
    mount()

    expect(screen.getByText('1 of 2 · Intro · intro.mp4')).toBeInTheDocument()
    expect(screen.getByText(/2 videos · 0:08/)).toBeInTheDocument()
  })

  it('lays the run out side by side, labelled by where each clip sits', () => {
    mount()

    const strip = clips()
    expect(within(strip[0]!).getByRole('button', { name: 'Play intro.mp4' })).toBeInTheDocument()
    expect(within(strip[0]!).getByText('Intro')).toBeInTheDocument()
    expect(within(strip[1]!).getByText('Outro')).toBeInTheDocument()
  })

  it('moves the labels with the clips when the order changes', () => {
    const { rerender } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Move intro.mp4 later' }))
    rerender()

    const strip = clips()
    expect(within(strip[0]!).getByRole('button', { name: 'Play gato.mp4' })).toBeInTheDocument()
    // The take that was the intro is at the back now, so it is the outro — and
    // nothing had to be relabelled by hand for that to be true.
    expect(within(strip[0]!).getByText('Intro')).toBeInTheDocument()
    expect(within(strip[1]!).getByRole('button', { name: 'Play intro.mp4' })).toBeInTheDocument()
    expect(within(strip[1]!).getByText('Outro')).toBeInTheDocument()
  })

  it('plays the clip that is clicked', () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play gato.mp4' }))

    expect(screen.getByText('2 of 2 · Outro · gato.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('shows the transcript of whatever is on screen, and moves on', () => {
    mount()

    const showing = () => screen.getByRole('textbox', { name: 'Transcript for the take on screen' })
    expect(showing()).toHaveValue('Ready?')

    fireEvent.click(screen.getByRole('button', { name: 'Play gato.mp4' }))

    expect(screen.getByText('2 of 2 · Outro · gato.mp4')).toBeInTheDocument()
    expect(showing()).toHaveValue('')
  })

  /**
   * The box under the picture is the same edit as the box on the take's row, and
   * this is asserted from the store rather than from the other box because that
   * is what "the same edit" means — a copy that merely looked right on screen
   * would be back to two transcripts that can drift.
   */
  it('rewrites the transcript of the take on screen, from under the picture', () => {
    const { rerender } = mount()

    fireEvent.change(screen.getByRole('textbox', { name: 'Transcript for the take on screen' }), {
      target: { value: '¿Listo?' },
    })

    expect(current().videos.map((video) => video.transcript)).toEqual(['¿Listo?', undefined])
    rerender()
    expect(screen.getByRole('textbox', { name: 'Transcript for intro.mp4' })).toHaveValue('¿Listo?')
  })

  /**
   * The bar is over the *word*, not over the file in the element, which is the
   * whole of why it is ours rather than the browser's own. Both directions of
   * that are asserted here: a point dragged to is read back as a take and a
   * time inside it, and a take playing is read forward as a point on the run.
   */
  it('scrubs across the whole run rather than the take on screen', () => {
    const { player } = mount()

    // Six seconds into a run of two four-second takes is two seconds into the
    // second one, and the element is only told that once it has that file.
    fireEvent.change(screen.getByRole('slider', { name: 'Scrub through the run' }), {
      target: { value: '6' },
    })

    expect(screen.getByText('2 of 2 · Outro · gato.mp4')).toBeInTheDocument()
    expect(screen.getByText('0:06.0 / 0:08.0')).toBeInTheDocument()
    fireEvent.loadedMetadata(player())
    expect(player().currentTime).toBe(2)
  })

  /**
   * A drag fires a change event on every pointer move, and a take within
   * reach of where the element already is does not need telling — seeking it
   * anyway is what made dragging the bar stutter. Only a move big enough to
   * matter reaches the element; the small ones still move the handle, since
   * that reads off state rather than off the element's own clock.
   */
  it('does not reseek the element for a drag too small to matter, but does for one that is', () => {
    const { player } = mount()

    fireEvent.change(screen.getByRole('slider', { name: 'Scrub through the run' }), {
      target: { value: '0.1' },
    })
    expect(screen.getByText('0:00.1 / 0:08.0')).toBeInTheDocument()
    expect(player().currentTime).toBe(0)

    fireEvent.change(screen.getByRole('slider', { name: 'Scrub through the run' }), {
      target: { value: '1' },
    })
    expect(player().currentTime).toBe(1)
  })

  it('counts where the run has got to as the take on screen plays', () => {
    const { player } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play gato.mp4' }))
    player().currentTime = 1
    fireEvent.timeUpdate(player())

    // One second into the second take is five into the run, not one.
    expect(screen.getByText('0:05.0 / 0:08.0')).toBeInTheDocument()
  })

  it('cannot be scrubbed along a run whose takes have never been measured', () => {
    useAssetStore.setState({
      assets: [
        { ...asset('asset_a', 'intro.mp4'), duration: undefined },
        { ...asset('asset_b', 'gato.mp4'), duration: undefined },
      ],
      loading: false,
    })
    mount()

    expect(screen.getByRole('slider', { name: 'Scrub through the run' })).toBeDisabled()
  })

  /**
   * The one rule in the player that is not obvious from reading it.
   *
   * A media element that reaches the end of its file pauses itself and fires
   * `pause` *before* it fires `ended` — verified in Chromium, and what the spec
   * says. So by the time the run is asked what to play next it has already been
   * stopped underneath it, and a player that merely leaves its own state alone
   * plays exactly one take per press. Both halves are asserted from the events
   * the browser really sends, in the order it really sends them.
   */
  it('carries on into the next take through the pause the browser fires at the end', () => {
    const { player } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.pause(player())
    fireEvent.ended(player())

    expect(screen.getByText('2 of 2 · Outro · gato.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('stops and rewinds when the last take ends', () => {
    const { player } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.pause(player())
    fireEvent.ended(player())
    fireEvent.pause(player())
    fireEvent.ended(player())

    expect(screen.getByText('1 of 2 · Intro · intro.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  /**
   * The picture is the only play control there is, so the click that reaches it
   * is asserted on the element itself rather than on the button around it — a
   * handler that only ever fired on the frame around the letterboxed picture
   * would pass any test that pressed the button by name.
   */
  it('plays and pauses when the picture itself is clicked', () => {
    const { player } = mount()

    fireEvent.click(player())
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

    fireEvent.click(player())
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('is not drawn at all for a word with nothing uploaded yet', () => {
    mount({ ...WORD, videos: [] })

    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
    expect(screen.getByText('No videos for this word yet')).toBeInTheDocument()
  })
})

/**
 * The takes that are in Drive and not in the app.
 *
 * The case this page had no answer to: `drive.file` shows this app what it made
 * and what it was handed, so a video recorded on a phone and dropped into the
 * word's folder is really there and really invisible here. Picking it is what
 * grants access to it, which is why the whole flow is asserted from the button
 * rather than from the store — the button is the only door in.
 */
describe('adding videos that are already in Drive', () => {
  const takeInDrive: DriveFile = {
    id: 'drive_take',
    name: 'cervelle.mp4',
    mimeType: 'video/mp4',
    kind: 'video',
  }

  /** The word as it is once its folder exists, which is what the Picker opens in. */
  const IN_DRIVE: Word = { ...WORD, driveFolderId: 'folder_gato' }

  beforeEach(() => {
    useDriveStore.setState({
      status: 'connected',
      folder: { id: 'root_media', name: 'editor-cat' },
    })
    pickVideos.mockReset()
    pickVideos.mockResolvedValue([])
    moveFile.mockReset()
    moveFile.mockResolvedValue(undefined)
  })

  it('puts a picked take on the end of the run, catalogued by its Drive id', async () => {
    pickVideos.mockResolvedValue([takeInDrive])
    const { rerender } = mount(IN_DRIVE)

    fireEvent.click(screen.getByRole('button', { name: 'Add from Drive' }))
    await waitFor(() => expect(current().videos).toHaveLength(3))

    // Opened in the word's own folder, which is where the takes it is missing
    // are most likely to be sitting.
    expect(pickVideos).toHaveBeenCalledWith('folder_gato')
    const added = useAssetStore.getState().byId(current().videos[2]!.assetId)
    expect(added?.driveFileId).toBe('drive_take')

    // No bytes yet — the row is drawn from the name, and the file comes down
    // afterwards, the same way a shelf read out of Drive fills in.
    rerender()
    expect(within(rows()[2]!).getByText('cervelle.mp4')).toBeInTheDocument()
  })

  it('moves it into the word’s folder, since the folder is the list of takes', async () => {
    pickVideos.mockResolvedValue([takeInDrive])
    mount(IN_DRIVE)

    fireEvent.click(screen.getByRole('button', { name: 'Add from Drive' }))

    // One picked from somewhere else in Drive would be dropped by the next read
    // of the shelf, which rebuilds each run from what the folder holds.
    await waitFor(() => expect(moveFile).toHaveBeenCalledWith('drive_take', 'folder_gato'))
  })

  it('does not list a take twice when it is picked again', async () => {
    useAssetStore.setState({
      assets: [
        asset('asset_a', 'intro.mp4'),
        { ...asset('asset_b', 'gato.mp4'), driveFileId: 'drive_take' },
      ],
      loading: false,
    })
    pickVideos.mockResolvedValue([takeInDrive])
    mount(IN_DRIVE)

    fireEvent.click(screen.getByRole('button', { name: 'Add from Drive' }))
    await screen.findByRole('button', { name: 'Add from Drive' })

    expect(current().videos).toHaveLength(2)
  })

  it('is not offered at all with no Drive to pick from', () => {
    useDriveStore.setState({ status: 'disconnected', folder: null })
    mount(IN_DRIVE)

    expect(screen.queryByRole('button', { name: 'Add from Drive' })).not.toBeInTheDocument()
  })
})
