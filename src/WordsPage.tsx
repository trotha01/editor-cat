/**
 * The word pages: upload the videos for a word, put them in order, and watch
 * them back.
 *
 * A page rather than a tab in the editor, because it is a different job. The
 * editor is one project being cut together; this is a growing shelf of words,
 * each with a handful of whole takes filed under it, and the two share media
 * storage and nothing else. Sitting it in the step nav would have made it a step
 * of a project it has nothing to do with.
 *
 * Three navigation columns, because the shelf has three levels and each is a
 * list you look things up in: a tier — "1st tier", "Classical", "ESL" — then a
 * language taught in it, then a word of that language. Everything to the right
 * of them is about the one word that is selected, and the three columns are the
 * same three levels of folder the shelf is kept as in Drive.
 */
import { useEffect, useMemo, useState } from 'react'
import { usePersistedState } from './hooks/usePersistedState'
import { DriveUploads } from './components/DriveUploads'
import { FeedbackBubble } from './components/FeedbackBubble'
import { RenameField } from './components/RenameField'
import { SettingsDialog } from './components/SettingsDialog'
import { WordVideos } from './components/WordVideos'
import { Button, Callout, EmptyState, LinkButton, Spinner, TextInput } from './components/ui'
import { EDITOR_HASH } from './lib/route'
import { languagesInTier, sortedTiers, wordsInLanguage } from './lib/words'
import { useDriveStore } from './state/useDriveStore'
import { useWordsStore } from './state/useWordsStore'

/**
 * What deleting also does, when there is a folder in Drive to do it to.
 *
 * Said out loud because it is a departure from the rest of the app, where your
 * Drive copy is always left alone. Here the folder is the shelf, so a delete
 * that stopped at this browser would be undone by the next read.
 */
function binNote(inDrive: boolean): string {
  return inDrive ? '\n\nThe folder goes to your Google Drive bin, where you can get it back.' : ''
}

export function WordsPage() {
  const tiers = useWordsStore((state) => state.tiers)
  const languages = useWordsStore((state) => state.languages)
  const words = useWordsStore((state) => state.words)
  const selectedTierId = useWordsStore((state) => state.selectedTierId)
  const selectedLanguageId = useWordsStore((state) => state.selectedLanguageId)
  const selectedWordId = useWordsStore((state) => state.selectedWordId)
  const loading = useWordsStore((state) => state.loading)
  const syncing = useWordsStore((state) => state.syncing)
  const syncError = useWordsStore((state) => state.syncError)
  const driveConnected = useDriveStore((state) => state.status === 'connected' && !!state.folder)

  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * Which of the three columns are narrowed to a strip.
   *
   * Remembered across visits like the editor's sidebar width, and for the same
   * reason: somebody who works one tier at a time collapses that column once,
   * not every morning.
   */
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(
    'editor-cat.words.collapsedColumns.v1',
    {},
  )
  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }))

  useEffect(() => {
    // A second visit in the same session keeps what was open — see `load`, which
    // reads the stores once and then leaves the selection alone.
    void useWordsStore.getState().load()
  }, [])

  useEffect(() => {
    // Whenever there is a Drive to read, read it — which is not only on mount.
    // A connection restored after the page was opened, or granted again after it
    // lapsed, is the same event as arriving with one, and a shelf that only
    // syncs on a reload would look like one that does not sync.
    if (driveConnected) void useWordsStore.getState().syncFromDrive()
  }, [driveConnected])

  const tierList = useMemo(() => sortedTiers(tiers), [tiers])
  const languageList = useMemo(
    () => languagesInTier(languages, selectedTierId),
    [languages, selectedTierId],
  )
  const wordList = useMemo(
    () => wordsInLanguage(words, selectedLanguageId),
    [words, selectedLanguageId],
  )

  const tier = tierList.find((entry) => entry.id === selectedTierId)
  const language = languageList.find((entry) => entry.id === selectedLanguageId)
  const word = wordList.find((entry) => entry.id === selectedWordId)

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span aria-hidden className="text-xl">
          🔤
        </span>
        {/* Not "Words": the column below is called that, and a page and a list
            inside it should not answer to the same name. */}
        <h1 className="text-sm font-semibold">Word videos</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-ink-dim">
          {syncing
            ? 'Reading your Drive…'
            : 'Upload the videos for a word, order them, and watch them together.'}
        </p>
        {syncing ? <Spinner className="text-ink-dim" /> : null}

        <LinkButton href={EDITOR_HASH}>
          <span aria-hidden>🎬</span> Editor
        </LinkButton>
        {/* The same dialog the editor opens, minus the project section: the
            account, the Drive folder this shelf lives in, and what this browser
            is storing are all as much this page's business as the editor's. It
            sits last here as it does there, so it is in the same place on both
            pages. */}
        <Button onClick={() => setSettingsOpen(true)}>
          <span aria-hidden>⚙️</span> Settings
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden">
        <NavColumn
          title="Tiers"
          collapsed={!!collapsed.tiers}
          onToggle={() => toggle('tiers')}
          items={tierList.map((entry) => ({ id: entry.id, label: entry.name }))}
          selectedId={selectedTierId}
          onSelect={(id) => useWordsStore.getState().selectTier(id)}
          onAdd={(value) => useWordsStore.getState().addTier(value)}
          onRename={(id, name) => useWordsStore.getState().renameTier(id, name)}
          onDelete={(id) => {
            const doomed = tierList.find((entry) => entry.id === id)
            const count = languages.filter((entry) => entry.tierId === id).length
            if (
              count > 0 &&
              !window.confirm(
                `Delete "${doomed?.name}" and its ${count} language${count === 1 ? '' : 's'}?` +
                  binNote(driveConnected && !!doomed?.driveFolderId),
              )
            ) {
              return
            }
            void useWordsStore.getState().removeTier(id)
          }}
          addLabel="Add a tier"
          placeholder="1st tier"
          empty={loading ? 'Loading…' : 'No tiers yet. Add one to start.'}
        />

        <NavColumn
          title="Languages"
          collapsed={!!collapsed.languages}
          onToggle={() => toggle('languages')}
          items={languageList.map((entry) => ({ id: entry.id, label: entry.name }))}
          selectedId={selectedLanguageId}
          onSelect={(id) => useWordsStore.getState().selectLanguage(id)}
          onAdd={(value) => useWordsStore.getState().addLanguage(value)}
          onRename={(id, name) => useWordsStore.getState().renameLanguage(id, name)}
          onDelete={(id) => {
            const doomed = languageList.find((entry) => entry.id === id)
            const count = words.filter((entry) => entry.languageId === id).length
            if (
              count > 0 &&
              !window.confirm(
                `Delete "${doomed?.name}" and its ${count} word${count === 1 ? '' : 's'}?` +
                  binNote(driveConnected && !!doomed?.driveFolderId),
              )
            ) {
              return
            }
            void useWordsStore.getState().removeLanguage(id)
          }}
          addLabel="Add a language"
          placeholder="French"
          disabled={!selectedTierId}
          empty={
            selectedTierId
              ? `No languages in ${tier?.name ?? 'this tier'} yet.`
              : 'Pick a tier first.'
          }
        />

        <NavColumn
          title="Words"
          collapsed={!!collapsed.words}
          onToggle={() => toggle('words')}
          items={wordList.map((entry) => ({
            id: entry.id,
            label: entry.text,
            note: entry.videos.length ? `${entry.videos.length}` : undefined,
          }))}
          selectedId={selectedWordId}
          onSelect={(id) => useWordsStore.getState().selectWord(id)}
          onAdd={(value) => useWordsStore.getState().addWord(value)}
          onRename={(id, name) => useWordsStore.getState().renameWord(id, name)}
          onDelete={(id) => {
            const doomed = wordList.find((entry) => entry.id === id)
            const count = doomed?.videos.length ?? 0
            if (
              count > 0 &&
              !window.confirm(
                `Delete "${doomed?.text}" and its ${count} video${count === 1 ? '' : 's'}?` +
                  binNote(driveConnected && !!doomed?.driveFolderId),
              )
            ) {
              return
            }
            void useWordsStore.getState().removeWord(id)
          }}
          addLabel="Add a word"
          placeholder="cerville - brain"
          // The column is drawn either way rather than hidden, so the shape of
          // the page does not change the moment a language is picked.
          disabled={!selectedLanguageId}
          empty={
            selectedLanguageId
              ? `No words in ${language?.name ?? 'this language'} yet.`
              : 'Pick a language first.'
          }
        />

        <section className="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          {/* Outside the word, and drawn whether or not one is open: an upload
              that failed to reach Drive is still worth saying so about after you
              have moved on to the next word. This is an upload page above all
              else, so a backup that silently did not happen is the worst thing
              that could quietly go wrong on it. */}
          <DriveUploads />

          {/* A failed read of Drive is worth saying and never worth blocking on:
              what is on screen is this browser's copy of the shelf, which is
              still a shelf. */}
          {syncError ? (
            <Callout tone="warn" title="Google Drive">
              {syncError}
            </Callout>
          ) : null}

          {word ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-lg font-semibold">{word.text}</h2>
                {language ? (
                  <span className="text-sm text-ink-dim">
                    {tier ? `${tier.name} · ` : ''}
                    {language.name}
                  </span>
                ) : null}
                {/* The other end of the link, made visible: these videos are in a
                    folder the user owns, and the fastest way to believe that is
                    to be able to open it. */}
                {word.driveFolderId ? (
                  <a
                    href={`https://drive.google.com/drive/folders/${word.driveFolderId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-ink-dim underline decoration-dotted hover:text-ink"
                  >
                    Open the Drive folder
                  </a>
                ) : null}
              </div>
              <WordVideos word={word} />
            </>
          ) : (
            <EmptyState icon="🔤" title="Nothing selected">
              {selectedLanguageId
                ? 'Add a word, or pick one from the list, and its videos will show up here.'
                : 'Add a tier, then a language, then a word, and upload the videos for it.'}
            </EmptyState>
          )}
        </section>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showProject={false}
      />

      {/* Fixed to the corner of the window rather than placed in the layout, the
          same as in the editor — and told it is on this page, so a report says
          how big the shelf is instead of describing a timeline nobody opened. */}
      <FeedbackBubble scope="shelf" />
    </div>
  )
}

interface NavItem {
  id: string
  label: string
  /** A small figure after the name — how many videos a word has. */
  note?: string
}

/**
 * One of the two navigation columns.
 *
 * Both are the same thing — a list you pick from, with a box at the bottom to
 * add to it — so they are one component rather than two that gradually stop
 * matching. The add box is always on screen rather than behind an "add" button:
 * it is a text field and a button either way, and the version that is already
 * there is one click cheaper every time.
 */
function NavColumn({
  title,
  items,
  selectedId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  addLabel,
  placeholder,
  empty,
  disabled = false,
  collapsed,
  onToggle,
}: {
  title: string
  items: NavItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: (value: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  addLabel: string
  placeholder: string
  empty: string
  disabled?: boolean
  /** Narrowed to a strip, so the columns you are not using stop taking room. */
  collapsed: boolean
  onToggle: () => void
}) {
  const [draft, setDraft] = useState('')
  /** The row whose name is being typed over, if any. */
  const [renaming, setRenaming] = useState<string | null>(null)

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onAdd(value)
    setDraft('')
  }

  return (
    <section
      className={`flex w-full shrink-0 flex-col gap-2 rounded-xl border border-line bg-surface p-2 lg:min-h-0 ${
        collapsed ? 'lg:w-10' : 'lg:w-44'
      }`}
    >
      <div className="flex items-center gap-1">
        <h2
          className={`min-w-0 flex-1 truncate px-1 text-xs font-semibold tracking-wide text-ink-dim uppercase ${
            collapsed ? 'lg:hidden' : ''
          }`}
        >
          {title}
        </h2>
        {/* Collapsing only makes sense once the columns sit beside each other
            rather than stacked above the word, so the button — and the narrow
            state it produces — stay out of the mobile layout entirely. Same
            trade the editor's sidebar makes. */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          className="hidden shrink-0 rounded-lg px-1 py-0.5 text-xs text-ink-dim transition hover:text-ink lg:block"
        >
          <span aria-hidden>{collapsed ? '»' : '«'}</span>
        </button>
      </div>

      {/* The name of a column you cannot read the contents of, turned on its
          side so a strip this narrow can still say which one it is. */}
      {collapsed ? (
        <p className="hidden flex-1 px-1 text-xs font-semibold tracking-wide text-ink-dim uppercase [writing-mode:vertical-rl] lg:block">
          {title}
        </p>
      ) : null}

      {/* `contents` drops this wrapper out of the box model, so the section's
          own `gap-2` still applies as if these were direct children —
          collapsing only has to add `lg:hidden` here, not rebuild the spacing. */}
      <div className={collapsed ? 'flex flex-col gap-2 lg:hidden' : 'contents'}>
        {items.length === 0 ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-ink-dim">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {items.map((item) =>
              renaming === item.id ? (
                <li key={item.id} className="flex items-center">
                  <RenameField
                    initial={item.label}
                    label={`Rename ${item.label}`}
                    onCommit={(name) => onRename(item.id, name)}
                    onCancel={() => setRenaming(null)}
                  />
                </li>
              ) : (
                <li key={item.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={selectedId === item.id}
                    className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm transition ${
                      selectedId === item.id
                        ? 'bg-accent text-accent-ink'
                        : 'text-ink hover:bg-surface-2'
                    }`}
                  >
                    {item.label}
                    {item.note ? (
                      <span
                        className={`ml-1.5 text-xs ${
                          selectedId === item.id ? 'text-accent-ink/75' : 'text-ink-dim'
                        }`}
                      >
                        {item.note}
                      </span>
                    ) : null}
                  </button>
                  {/* Out of the way until the row is pointed at or tabbed into:
                    three columns of names are what this page is read from, and a
                    pencil and a cross beside every one of them is a lot of
                    furniture to read past. */}
                  <Button
                    variant="ghost"
                    className="!px-1 !py-0.5 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => setRenaming(item.id)}
                    aria-label={`Rename ${item.label}`}
                  >
                    ✏️
                  </Button>
                  <Button
                    variant="ghost"
                    className="!px-1 !py-0.5 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onDelete(item.id)}
                    aria-label={`Delete ${item.label}`}
                  >
                    ✕
                  </Button>
                </li>
              ),
            )}
          </ul>
        )}

        {/* A form, so Enter adds — typing a name and reaching for the mouse to
            confirm it is not how anyone adds twenty words. */}
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <TextInput
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            aria-label={addLabel}
            disabled={disabled}
            className="min-w-0 flex-1 !px-2 !py-1.5 text-sm"
          />
          {/* Labelled with the same words as the field beside it: three columns
              means three buttons that all read "Add", and which list a press
              adds to is the whole of what tells them apart. */}
          <Button
            type="submit"
            aria-label={addLabel}
            disabled={disabled || !draft.trim()}
            className="!px-2 !py-1.5"
          >
            Add
          </Button>
        </form>
      </div>
    </section>
  )
}
