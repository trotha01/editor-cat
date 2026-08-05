/**
 * The project: what is on the timeline and where the playhead is.
 *
 * Every mutation persists to IndexedDB so a refresh, a crash, or a closed tab
 * does not lose work the user paid a provider to generate.
 */
import { create } from 'zustand'
import { loadProject, saveProject } from '../lib/db'
import { clipForAsset, layoutClips, reorder, totalDuration, trimClip } from '../lib/timeline'
import {
  audioEnd,
  createTrack,
  defaultTracks,
  insertTrack,
  migrateProject,
  moveAudioClip,
  placeAudioClip,
} from '../lib/audioTracks'
import { newId } from '../lib/media'
import type {
  Asset,
  AudioClip,
  AudioTrack,
  AudioTrackKind,
  Clip,
  PositionedClip,
  Project,
} from '../lib/types'

/**
 * The id every project had before this app could hold more than one.
 *
 * Still used as the local-only project id when there is no account to own a
 * real one, and adopted as the user's first cloud project on first sign-in so
 * existing work is not stranded.
 */
export const LOCAL_PROJECT_ID = 'default'

export function emptyProject(id = LOCAL_PROJECT_ID, name = 'Untitled project'): Project {
  return {
    id,
    name,
    clips: [],
    audioTracks: defaultTracks(newId('track'), newId('track')),
    audioClips: [],
    width: 1280,
    height: 720,
    fps: 30,
  }
}

/** What `addRecording` did, so the UI can say where the take landed. */
export interface PlacementOutcome {
  trackId: string
  trackName: string
  createdTrack: boolean
}

interface ProjectState {
  project: Project
  selectedClipId: string | null
  selectedAudioClipId: string | null
  loaded: boolean

  /** Opens the local project. Used when signed out or running unconfigured. */
  load: () => Promise<void>
  /** Replaces the open project wholesale, e.g. with one fetched from Supabase. */
  adopt: (project: Project) => void
  /** Opens a project from the local cache by id. */
  open: (id: string) => Promise<void>
  rename: (name: string) => void
  setResolution: (width: number, height: number) => void

  addClip: (asset: Asset) => void
  removeClip: (clipId: string) => void
  selectClip: (clipId: string | null) => void
  moveClip: (from: number, to: number) => void
  trim: (clipId: string, asset: Asset | undefined, edge: 'start' | 'end', value: number) => void
  setImageDuration: (clipId: string, seconds: number) => void

  /** Places audio, adding a track only if every existing one is busy there. */
  addAudioClip: (kind: AudioTrackKind, clip: Omit<AudioClip, 'id' | 'trackId'>) => PlacementOutcome
  updateAudioClip: (id: string, patch: Partial<AudioClip>) => void
  moveAudioClipTo: (id: string, startTime: number, trackId?: string) => boolean
  removeAudioClip: (id: string) => void
  selectAudioClip: (id: string | null) => void

  addTrack: (kind: AudioTrackKind) => void
  updateTrack: (id: string, patch: Partial<AudioTrack>) => void
  removeTrack: (id: string) => void

  clearTimeline: () => void

  positioned: () => PositionedClip[]
  duration: () => number
}

function persist(project: Project): void {
  void saveProject(project).catch(() => {
    // Persistence is best-effort; losing it must not break editing.
  })
}

export const useProjectStore = create<ProjectState>((set, get) => {
  const mutate = (fn: (project: Project) => Project) => {
    set((state) => {
      const next = fn(state.project)
      persist(next)
      return { project: next }
    })
  }

  return {
    project: emptyProject(),
    selectedClipId: null,
    selectedAudioClipId: null,
    loaded: false,

    load: async () => {
      await get().open(LOCAL_PROJECT_ID)
    },

    open: async (id) => {
      try {
        const stored = await loadProject(id)
        // Projects saved before multitrack carry a flat `voiceovers` list;
        // migrating on read means old work opens with its layers intact.
        const project = stored ? migrateProject(stored, newId) : emptyProject(id)
        if (stored && project !== stored) persist(project)
        set({ project, loaded: true, selectedClipId: null, selectedAudioClipId: null })
      } catch {
        set({ project: emptyProject(id), loaded: true })
      }
    },

    adopt: (project) => {
      persist(project)
      set({ project, loaded: true, selectedClipId: null, selectedAudioClipId: null })
    },

    rename: (name) => mutate((project) => ({ ...project, name })),

    setResolution: (width, height) => mutate((project) => ({ ...project, width, height })),

    addClip: (asset) => {
      const clip = clipForAsset(asset, newId('clip'))
      mutate((project) => ({ ...project, clips: [...project.clips, clip] }))
      set({ selectedClipId: clip.id })
    },

    removeClip: (clipId) => {
      mutate((project) => ({
        ...project,
        clips: project.clips.filter((clip) => clip.id !== clipId),
      }))
      set((state) => ({
        selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      }))
    },

    selectClip: (clipId) => set({ selectedClipId: clipId }),

    moveClip: (from, to) =>
      mutate((project) => ({ ...project, clips: reorder(project.clips, from, to) })),

    trim: (clipId, asset, edge, value) =>
      mutate((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === clipId ? trimClip(clip, asset, edge, value) : clip,
        ),
      })),

    setImageDuration: (clipId, seconds) =>
      mutate((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === clipId ? { ...clip, inPoint: 0, outPoint: Math.max(0.2, seconds) } : clip,
        ),
      })),

    addAudioClip: (kind, clip) => {
      const id = newId('aclip')
      const { project } = get()

      const result = placeAudioClip(project.audioTracks, project.audioClips, {
        kind,
        newTrackId: newId('track'),
        clip: { ...clip, id },
      })

      mutate((current) => ({
        ...current,
        audioTracks: result.tracks,
        audioClips: result.clips,
      }))
      set({ selectedAudioClipId: id })

      const track = result.tracks.find((entry) => entry.id === result.trackId)
      return {
        trackId: result.trackId,
        trackName: track?.name ?? 'Track',
        createdTrack: result.createdTrack,
      }
    },

    updateAudioClip: (id, patch) =>
      mutate((project) => ({
        ...project,
        audioClips: project.audioClips.map((clip) =>
          clip.id === id ? { ...clip, ...patch } : clip,
        ),
      })),

    moveAudioClipTo: (id, startTime, trackId) => {
      const { project } = get()
      const result = moveAudioClip(project.audioClips, id, {
        startTime,
        ...(trackId ? { trackId } : {}),
      })
      // A blocked move leaves state untouched, so skip the write entirely
      // rather than persisting an identical project on every rejected drag.
      if (!result.moved) return false
      mutate((current) => ({ ...current, audioClips: result.clips }))
      return true
    },

    removeAudioClip: (id) => {
      mutate((project) => ({
        ...project,
        audioClips: project.audioClips.filter((clip) => clip.id !== id),
      }))
      set((state) => ({
        selectedAudioClipId: state.selectedAudioClipId === id ? null : state.selectedAudioClipId,
      }))
    },

    selectAudioClip: (id) => set({ selectedAudioClipId: id }),

    addTrack: (kind) =>
      mutate((project) => ({
        ...project,
        audioTracks: insertTrack(
          project.audioTracks,
          createTrack(newId('track'), kind, project.audioTracks),
        ),
      })),

    updateTrack: (id, patch) =>
      mutate((project) => ({
        ...project,
        audioTracks: project.audioTracks.map((track) =>
          track.id === id ? { ...track, ...patch } : track,
        ),
      })),

    removeTrack: (id) =>
      // Removing a track takes its clips with it. Leaving them orphaned would
      // keep them audible in the mix with nothing on screen to explain why.
      mutate((project) => ({
        ...project,
        audioTracks: project.audioTracks.filter((track) => track.id !== id),
        audioClips: project.audioClips.filter((clip) => clip.trackId !== id),
      })),

    clearTimeline: () => {
      mutate((project) => ({ ...project, clips: [], audioClips: [] }))
      set({ selectedClipId: null, selectedAudioClipId: null })
    },

    positioned: () => layoutClips(get().project.clips),
    duration: () => {
      const { project } = get()
      return Math.max(totalDuration(project.clips), audioEnd(project.audioClips))
    },
  }
})

/** Convenience selector: the currently selected clip, if any. */
export function selectSelectedClip(state: ProjectState): Clip | undefined {
  return state.project.clips.find((clip) => clip.id === state.selectedClipId)
}
