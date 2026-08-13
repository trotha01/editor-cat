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
 * Two navigation columns, because the shelf has two levels and both are lists
 * you look things up in: a language, then a word of that language. Everything to
 * the right of them is about the one word that is selected.
 */
import { useEffect, useMemo, useState } from 'react'
import { DriveUploads } from './components/DriveUploads'
import { WordVideos } from './components/WordVideos'
import { Button, EmptyState, LinkButton, TextInput } from './components/ui'
import { EDITOR_HASH } from './lib/route'
import { sortedLanguages, wordsInLanguage } from './lib/words'
import { useWordsStore } from './state/useWordsStore'

export function WordsPage() {
  const languages = useWordsStore((state) => state.languages)
  const words = useWordsStore((state) => state.words)
  const selectedLanguageId = useWordsStore((state) => state.selectedLanguageId)
  const selectedWordId = useWordsStore((state) => state.selectedWordId)
  const loading = useWordsStore((state) => state.loading)

  useEffect(() => {
    // A second visit in the same session keeps what was open — see `load`, which
    // reads the stores once and then leaves the selection alone.
    void useWordsStore.getState().load()
  }, [])

  const languageList = useMemo(() => sortedLanguages(languages), [languages])
  const wordList = useMemo(
    () => wordsInLanguage(words, selectedLanguageId),
    [words, selectedLanguageId],
  )

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
          Upload the videos for a word, order them, and watch them together.
        </p>
        <LinkButton href={EDITOR_HASH}>
          <span aria-hidden>🎬</span> Editor
        </LinkButton>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden">
        <NavColumn
          title="Languages"
          items={languageList.map((entry) => ({ id: entry.id, label: entry.name }))}
          selectedId={selectedLanguageId}
          onSelect={(id) => useWordsStore.getState().selectLanguage(id)}
          onAdd={(value) => useWordsStore.getState().addLanguage(value)}
          onDelete={(id) => {
            const doomed = languageList.find((entry) => entry.id === id)
            const count = words.filter((entry) => entry.languageId === id).length
            if (
              count > 0 &&
              !window.confirm(
                `Delete "${doomed?.name}" and its ${count} word${count === 1 ? '' : 's'}?`,
              )
            ) {
              return
            }
            void useWordsStore.getState().removeLanguage(id)
          }}
          addLabel="Add a language"
          placeholder="Spanish"
          empty={loading ? 'Loading…' : 'No languages yet. Add one to start.'}
        />

        <NavColumn
          title="Words"
          items={wordList.map((entry) => ({
            id: entry.id,
            label: entry.text,
            note: entry.videos.length ? `${entry.videos.length}` : undefined,
          }))}
          selectedId={selectedWordId}
          onSelect={(id) => useWordsStore.getState().selectWord(id)}
          onAdd={(value) => useWordsStore.getState().addWord(value)}
          onDelete={(id) => {
            const doomed = wordList.find((entry) => entry.id === id)
            const count = doomed?.videos.length ?? 0
            if (
              count > 0 &&
              !window.confirm(
                `Delete "${doomed?.text}" and its ${count} video${count === 1 ? '' : 's'}?`,
              )
            ) {
              return
            }
            void useWordsStore.getState().removeWord(id)
          }}
          addLabel="Add a word"
          placeholder="gato"
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

          {word ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-lg font-semibold">{word.text}</h2>
                {language ? <span className="text-sm text-ink-dim">{language.name}</span> : null}
              </div>
              <WordVideos word={word} />
            </>
          ) : (
            <EmptyState icon="🔤" title="Nothing selected">
              {selectedLanguageId
                ? 'Add a word, or pick one from the list, and its videos will show up here.'
                : 'Add a language, then a word, and upload the videos for it.'}
            </EmptyState>
          )}
        </section>
      </main>
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
  onDelete,
  addLabel,
  placeholder,
  empty,
  disabled = false,
}: {
  title: string
  items: NavItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: (value: string) => void
  onDelete: (id: string) => void
  addLabel: string
  placeholder: string
  empty: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onAdd(value)
    setDraft('')
  }

  return (
    <section className="flex w-full shrink-0 flex-col gap-2 rounded-xl border border-line bg-surface p-2 lg:w-52 lg:min-h-0">
      <h2 className="px-1 text-xs font-semibold tracking-wide text-ink-dim uppercase">{title}</h2>

      {items.length === 0 ? (
        <p className="px-1 py-2 text-xs leading-relaxed text-ink-dim">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {items.map((item) => (
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
              <Button
                variant="ghost"
                className="!px-1.5 !py-0.5 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onDelete(item.id)}
                aria-label={`Delete ${item.label}`}
              >
                ✕
              </Button>
            </li>
          ))}
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
        {/* Labelled with the same words as the field beside it: two columns
            means two buttons that both read "Add", and which list a press adds
            to is the whole of what tells them apart. */}
        <Button
          type="submit"
          aria-label={addLabel}
          disabled={disabled || !draft.trim()}
          className="!px-2 !py-1.5"
        >
          Add
        </Button>
      </form>
    </section>
  )
}
