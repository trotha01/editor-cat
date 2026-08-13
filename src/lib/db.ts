/**
 * IndexedDB persistence.
 *
 * Raw media blobs, the catalogue of what they are, the project documents that
 * reference them, and the languages and words of the word pages. Keeping the
 * bytes locally is what makes the editor refresh-safe and lets you come back to
 * a project later without re-generating (and re-paying for) anything.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Asset, Project } from './types'
import type { Language, Word } from './words'

interface EditorCatDB extends DBSchema {
  blobs: {
    key: string
    value: Blob
  }
  assets: {
    key: string
    value: Asset
    indexes: { createdAt: number }
  }
  projects: {
    key: string
    value: Project
  }
  languages: {
    key: string
    value: Language
  }
  words: {
    key: string
    value: Word
    indexes: { languageId: string }
  }
}

const DB_NAME = 'editor-cat'
/** 2 added the `languages` and `words` stores behind the word pages. */
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<EditorCatDB>> | null = null

function db(): Promise<IDBPDatabase<EditorCatDB>> {
  dbPromise ??= openDB<EditorCatDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('blobs')) {
        database.createObjectStore('blobs')
      }
      if (!database.objectStoreNames.contains('assets')) {
        const store = database.createObjectStore('assets', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!database.objectStoreNames.contains('projects')) {
        database.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('languages')) {
        database.createObjectStore('languages', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('words')) {
        const store = database.createObjectStore('words', { keyPath: 'id' })
        store.createIndex('languageId', 'languageId')
      }
    },
  })
  return dbPromise
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await (await db()).put('blobs', blob, key)
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return (await db()).get('blobs', key)
}

export async function deleteBlob(key: string): Promise<void> {
  await (await db()).delete('blobs', key)
}

export async function putAsset(asset: Asset): Promise<void> {
  await (await db()).put('assets', asset)
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  return (await db()).get('assets', id)
}

export async function listAssets(): Promise<Asset[]> {
  const all = await (await db()).getAllFromIndex('assets', 'createdAt')
  return all.reverse() // newest first, which is what the library wants
}

export async function deleteAsset(id: string): Promise<void> {
  const database = await db()
  const asset = await database.get('assets', id)
  if (asset) await database.delete('blobs', asset.blobKey)
  await database.delete('assets', id)
}

export async function saveProject(project: Project): Promise<void> {
  await (await db()).put('projects', project)
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id)
}

/**
 * Every project cached locally.
 *
 * This is the offline view of the project list. The authoritative list comes
 * from Supabase when signed in, but a cold start with no network still has to
 * show something openable.
 */
export async function listProjects(): Promise<Project[]> {
  return (await db()).getAll('projects')
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete('projects', id)
}

/**
 * The word pages: languages, and the words filed under them.
 *
 * Two stores rather than languages holding their words, because the words are
 * the part that grows — a language is a name, and rewriting a document holding
 * every word of it each time one video is relabelled is a great deal of writing
 * to record a very small fact.
 */
export async function putLanguage(language: Language): Promise<void> {
  await (await db()).put('languages', language)
}

export async function listLanguages(): Promise<Language[]> {
  return (await db()).getAll('languages')
}

export async function deleteLanguage(id: string): Promise<void> {
  await (await db()).delete('languages', id)
}

export async function putWord(word: Word): Promise<void> {
  await (await db()).put('words', word)
}

export async function listWords(): Promise<Word[]> {
  return (await db()).getAll('words')
}

export async function deleteWord(id: string): Promise<void> {
  await (await db()).delete('words', id)
}

/** Rough total of stored bytes, for the storage readout in Settings. */
export async function estimateUsage(): Promise<{ used: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage, quota } = await navigator.storage.estimate()
  return { used: usage ?? 0, quota: quota ?? 0 }
}

/** Wipes everything. Used by the "clear all data" button in Settings. */
export async function clearAll(): Promise<void> {
  const database = await db()
  await Promise.all([
    database.clear('blobs'),
    database.clear('assets'),
    database.clear('projects'),
    database.clear('languages'),
    database.clear('words'),
  ])
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
