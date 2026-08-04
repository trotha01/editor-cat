/**
 * IndexedDB persistence.
 *
 * Two stores: raw media blobs, and the project document that references them.
 * Keeping the bytes locally is what makes the editor refresh-safe and lets you
 * come back to a project later without re-generating (and re-paying for)
 * anything.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Asset, Project } from './types'

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
}

const DB_NAME = 'editor-cat'
const DB_VERSION = 1

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

/** Rough total of stored bytes, for the storage readout in Settings. */
export async function estimateUsage(): Promise<{ used: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage, quota } = await navigator.storage.estimate()
  return { used: usage ?? 0, quota: quota ?? 0 }
}

/** Wipes everything. Used by the "clear all data" button in Settings. */
export async function clearAll(): Promise<void> {
  const database = await db()
  await Promise.all([database.clear('blobs'), database.clear('assets'), database.clear('projects')])
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
