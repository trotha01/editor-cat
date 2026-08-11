/**
 * The Google Drive connection: whose it is, which folder we write to, and what
 * is currently uploading.
 *
 * Granting it is `connect`, and it is a screen of its own: Auth0 files a login's
 * provider tokens against the user's identity, which is not the store Token
 * Vault reads, so the folder permission has to be asked for as a connected
 * account rather than ridden in on the sign-in. Auth0 keeps what comes back —
 * which is why `restore` asks our own server what this account has rather than
 * asking Google, and a browser that has never seen them still picks it up.
 *
 * The chosen folder belongs to the account too, for the same reason and by the
 * same route: it is a preference rather than a credential, but a preference
 * stored in one browser is one the next sign-in has to ask for again. It lives
 * in a table of its own (lib/supabase/driveFolder.ts), with localStorage kept as
 * a cache for the moment the account cannot be reached.
 */
import { create } from 'zustand'
import {
  accessToken,
  invalidateToken,
  isDriveConfigured,
  loadConnectionStatus,
  NeedsConsentError,
} from '../lib/google/gis'
import { currentUser, DriveError, uploadFile, type DriveFolder } from '../lib/google/drive'
import { connectDrive } from '../lib/auth0/client'
import { clearDriveFolder, getDriveFolder, saveDriveFolder } from '../lib/supabase/driveFolder'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { useAuthStore } from './useAuthStore'
import { toDisplayMessage } from '../lib/errors'
import { recordAsset } from '../lib/sync/assetSync'
import { useAssetStore } from './useAssetStore'
import type { Asset } from '../lib/types'

const FOLDER_KEY = 'editor-cat.drive.folder.v1'

/**
 * `needs-reconnect` is distinct from `disconnected`: the connection existed and
 * stopped working, which is worth telling someone mid-session. Both are answered
 * the same way — signing in again — but only one is a surprise.
 */
export type DriveStatus =
  'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'needs-reconnect'

export interface UploadJob {
  assetId: string
  name: string
  /** 0 to 1. */
  progress: number
  error?: string
}

interface DriveState {
  status: DriveStatus
  account: { email: string; name: string } | null
  folder: DriveFolder | null
  error: string | null
  uploads: UploadJob[]
  /**
   * Whether this deployment can store connections at all. Null until the first
   * status check answers. False means an operator has not finished setting the
   * site up, and the gate says so rather than offering a sign-in that cannot work.
   */
  durable: boolean | null

  /** Resumes the account's connection without prompting. Safe to call on mount. */
  restore: () => Promise<void>
  /**
   * Asks Google for the folder permission. Leaves the page.
   *
   * A step of its own, because a login's provider tokens land somewhere Token
   * Vault cannot read — see lib/auth0/client.ts. The account stays signed in
   * throughout: what is missing is a permission, not a session.
   */
  connect: () => void
  /**
   * Drops this browser's Drive state on sign-out, leaving the grant and the
   * chosen folder alone — both belong to the account, and signing back in
   * resumes them.
   */
  forget: () => void
  /**
   * Records where new media goes, on the account as well as in this browser.
   *
   * Null is an unsetting rather than a forgetting: it clears the account's
   * record too, so the next sign-in is asked. Signing out does not go through
   * here, for exactly that reason.
   */
  setFolder: (folder: DriveFolder | null) => void
  clearError: () => void

  /** Fire-and-forget upload of a freshly ingested asset. */
  uploadAsset: (asset: Asset, blob: Blob) => void
}

/** Whether a failure means "sign in again" rather than "that one went wrong". */
function isExpiredSession(cause: unknown): boolean {
  if (cause instanceof NeedsConsentError) return true
  return cause instanceof DriveError && cause.status === 401
}

/** This browser's copy of the choice, and which account made it. */
interface CachedFolder {
  folder: DriveFolder
  /**
   * The Auth0 subject that chose it, or null in a record written before the
   * folder became an account setting.
   */
  account: string | null
}

function loadFolder(): CachedFolder | null {
  try {
    const raw = window.localStorage.getItem(FOLDER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DriveFolder> & { account?: unknown }
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null
    return {
      folder: { id: parsed.id, name: parsed.name },
      account: typeof parsed.account === 'string' ? parsed.account : null,
    }
  } catch {
    return null
  }
}

function persistFolder(folder: DriveFolder | null, account: string | null): void {
  try {
    // The account is only recorded when there is one, so a local-only build
    // writes exactly the two keys it always did.
    if (folder) {
      window.localStorage.setItem(
        FOLDER_KEY,
        JSON.stringify({ ...folder, ...(account ? { account } : {}) }),
      )
    } else window.localStorage.removeItem(FOLDER_KEY)
  } catch {
    // Private browsing can refuse storage. The folder still works this session.
  }
}

/** The signed-in subject, which is what the folder is filed under. */
function currentSubject(): string | null {
  return useAuthStore.getState().account?.id ?? null
}

/** Whether there is an account to keep the folder against right now. */
function canReachAccount(): boolean {
  return isSupabaseConfigured() && currentSubject() !== null
}

/**
 * Writes the choice to the account, ignoring failures.
 *
 * Best-effort on purpose: the folder already works for this session, and a
 * failed write costs the question being asked once more rather than an edit
 * interrupted by a dialog about a preference.
 */
async function recordFolder(folder: DriveFolder | null): Promise<void> {
  if (!canReachAccount()) return
  try {
    if (folder) await saveDriveFolder(folder)
    else await clearDriveFolder()
  } catch {
    // Deliberately swallowed — see above.
  }
}

/**
 * Which folder this account writes into, settled before the editor opens.
 *
 * The account is the authority; this browser's copy is a cache, and is only
 * consulted for an account that cannot be asked. Never throws: a folder that
 * could not be established is `null`, which is the folder step, not an error.
 */
async function settleFolder(): Promise<DriveFolder | null> {
  const subject = currentSubject()
  const cached = loadFolder()

  // A cached folder counts only if it is this account's. Somebody else's is an
  // id in a Drive this user cannot reach, so inheriting it would open the editor
  // onto uploads that fail. An unstamped record predates this being recorded at
  // all, and belongs to the last person signed in on this browser — which,
  // because signing out clears it, is this one.
  const mine =
    cached && (cached.account === null || cached.account === subject) ? cached.folder : null

  if (!canReachAccount()) return mine

  try {
    const stored = await getDriveFolder()
    if (stored) {
      // Whatever this browser thought, the account has the answer — including
      // when the folder was changed on another machine.
      persistFolder(stored, subject)
      return stored
    }

    // Nothing recorded yet: a first visit, or a choice made on this browser
    // before the account started keeping it. Adopting the cached one costs a
    // single write and saves asking a question that already has an answer.
    if (mine) void recordFolder(mine)
    return mine
  } catch {
    // The account could not be asked. The cache is a better guess than none:
    // clearing it here would put the folder step in front of someone whose
    // answer is sitting in a table nobody could reach this minute.
    return mine
  }
}

export const useDriveStore = create<DriveState>((set, get) => ({
  status: isDriveConfigured() ? 'disconnected' : 'unconfigured',
  account: null,
  // The cached copy, unverified: `restore` replaces it with the account's own
  // answer before the gate lets anyone in. It is here so a local-only build,
  // which never calls `restore`, still keeps the folder across reloads.
  folder: loadFolder()?.folder ?? null,
  error: null,
  uploads: [],
  durable: null,

  restore: async () => {
    if (!isDriveConfigured()) return
    // A connection may already be in hand, or on its way from the consent the
    // user is in the middle of giving. Asking the server again would at best
    // duplicate work and at worst overwrite a fresher answer with a stale one.
    if (get().status === 'connected' || get().status === 'connecting') return

    const { durable, connected } = await loadConnectionStatus()
    set({ durable })

    // The account is the only authority: it says whether there is anything to
    // resume, so a browser that has never seen this user still picks the
    // connection up, and one that has seen them cannot claim a connection the
    // account no longer holds.
    if (!durable || !connected) {
      set({ status: 'disconnected' })
      return
    }

    set({ status: 'connecting', error: null })
    try {
      await accessToken()
      // The folder is settled before the status moves, not after it. The gate
      // draws the folder step the moment it sees `connected`, so a folder that
      // arrives a paint later is the question asked and answered in front of
      // someone who had already answered it.
      const [account, folder] = await Promise.all([currentUser(), settleFolder()])
      set({ status: 'connected', account, folder })
    } catch (cause) {
      // A stored connection that has stopped working is the normal path for a
      // revoked grant, so it is not surfaced as an error — just as a prompt to
      // sign in again.
      set({
        status: 'needs-reconnect',
        ...(cause instanceof NeedsConsentError ? {} : { error: toDisplayMessage(cause) }),
      })
    }
  },

  connect: () => {
    set({ status: 'connecting', error: null })
    // Navigates away, so nothing after it runs — but the navigation happens
    // inside the SDK after a round trip to Auth0, and a refusal there would
    // otherwise leave the gate spinning at `connecting` with nothing to show.
    void connectDrive(useAuthStore.getState().account?.email).catch((cause: unknown) => {
      set({ status: 'disconnected', error: toDisplayMessage(cause) })
    })
  },

  forget: () => {
    // The access token has to go, or the next account to sign in on this
    // browser inherits the last one's Drive for as long as it stays valid.
    invalidateToken()
    // The folder goes with it for the same reason: it is an id in someone
    // else's Drive, and uploading into it would fail in a way nobody could read.
    //
    // This browser's copy only. The account's record is deliberately left
    // standing — it is what lets the same person sign back in without being
    // asked where their media goes for a second time.
    persistFolder(null, null)
    set({
      status: isDriveConfigured() ? 'disconnected' : 'unconfigured',
      account: null,
      folder: null,
      error: null,
      uploads: [],
      durable: null,
    })
  },

  setFolder: (folder) => {
    persistFolder(folder, currentSubject())
    set({ folder })
    // Where it actually has to land. The local copy makes this reload cheap;
    // the account is what makes the next sign-in — here or on another machine —
    // skip the question entirely.
    void recordFolder(folder)
  },

  clearError: () => set({ error: null }),

  uploadAsset: (asset, blob) => {
    const { status, folder } = get()
    // Already in Drive: this asset was imported from there in the first place.
    if (asset.driveFileId) return
    if (status !== 'connected' || !folder) return

    const job: UploadJob = { assetId: asset.id, name: asset.name, progress: 0 }
    set((state) => ({ uploads: [...state.uploads, job] }))

    const patch = (change: Partial<UploadJob>) =>
      set((state) => ({
        uploads: state.uploads.map((entry) =>
          entry.assetId === asset.id ? { ...entry, ...change } : entry,
        ),
      }))

    void (async () => {
      try {
        const file = await uploadFile(blob, {
          name: asset.name,
          parentId: folder.id,
          onProgress: (progress) => patch({ progress }),
        })

        // Recording the id is what makes the backup idempotent: an asset that
        // carries one is never uploaded again. The dependency only points this
        // way — the asset store knows nothing about Drive.
        await useAssetStore.getState().update(asset.id, { driveFileId: file.id })

        // Second catalogue write. The first one, at ingest, had no Drive id to
        // record — and that id is the only thing that makes these bytes
        // recoverable on another machine.
        void recordAsset({ ...asset, driveFileId: file.id }, blob.size)

        set((state) => ({
          uploads: state.uploads.filter((entry) => entry.assetId !== asset.id),
        }))
      } catch (cause) {
        // The bytes are still in IndexedDB, so a failed upload costs the user
        // nothing but the backup. Leave the job visible with its reason.
        patch({ error: toDisplayMessage(cause) })

        // An expired session will fail every later upload the same way, so it
        // is worth promoting to the connection state — otherwise Settings goes
        // on claiming everything is connected while nothing is being saved.
        if (isExpiredSession(cause) && get().status === 'connected') {
          set({ status: 'needs-reconnect' })
        }
      }
    })()
  },
}))

/** Drops a finished-with upload row from the list. */
export function dismissUpload(assetId: string): void {
  useDriveStore.setState((state) => ({
    uploads: state.uploads.filter((entry) => entry.assetId !== assetId),
  }))
}
