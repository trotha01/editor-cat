/**
 * The project: what is on the timeline and where the playhead is.
 *
 * Every mutation persists to IndexedDB so a refresh, a crash, or a closed tab
 * does not lose work the user paid a provider to generate.
 */
import { create } from 'zustand'
import { loadProject, saveProject } from '../lib/db'
import { clipForAsset, layoutClips, reorder, totalDuration, trimClip } from '../lib/timeline'
import { newId } from '../lib/media'
import type { Asset, Clip, PositionedClip, Project, VoiceoverTake } from '../lib/types'

const PROJECT_ID = 'default'

const EMPTY_PROJECT: Project = {
  id: PROJECT_ID,
  name: 'Untitled project',
  clips: [],
  voiceovers: [],
  width: 1280,
  height: 720,
  fps: 30,
}

interface ProjectState {
  project: Project
  selectedClipId: string | null
  loaded: boolean

  load: () => Promise<void>
  rename: (name: string) => void
  setResolution: (width: number, height: number) => void

  addClip: (asset: Asset) => void
  removeClip: (clipId: string) => void
  selectClip: (clipId: string | null) => void
  moveClip: (from: number, to: number) => void
  trim: (clipId: string, asset: Asset | undefined, edge: 'start' | 'end', value: number) => void
  setImageDuration: (clipId: string, seconds: number) => void

  addVoiceover: (take: VoiceoverTake) => void
  updateVoiceover: (id: string, patch: Partial<VoiceoverTake>) => void
  removeVoiceover: (id: string) => void

  clearTimeline: () => void

  /** Derived helpers. */
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
    project: EMPTY_PROJECT,
    selectedClipId: null,
    loaded: false,

    load: async () => {
      try {
        const stored = await loadProject(PROJECT_ID)
        set({ project: stored ?? EMPTY_PROJECT, loaded: true })
      } catch {
        set({ project: EMPTY_PROJECT, loaded: true })
      }
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

    addVoiceover: (take) =>
      mutate((project) => ({ ...project, voiceovers: [...project.voiceovers, take] })),

    updateVoiceover: (id, patch) =>
      mutate((project) => ({
        ...project,
        voiceovers: project.voiceovers.map((take) =>
          take.id === id ? { ...take, ...patch } : take,
        ),
      })),

    removeVoiceover: (id) =>
      mutate((project) => ({
        ...project,
        voiceovers: project.voiceovers.filter((take) => take.id !== id),
      })),

    clearTimeline: () => {
      mutate((project) => ({ ...project, clips: [], voiceovers: [] }))
      set({ selectedClipId: null })
    },

    positioned: () => layoutClips(get().project.clips),
    duration: () => {
      const project = get().project
      const visual = totalDuration(project.clips)
      const voice = project.voiceovers.reduce(
        (max, take) => Math.max(max, take.startTime + take.duration),
        0,
      )
      return Math.max(visual, voice)
    },
  }
})

/** Convenience selector: the currently selected clip, if any. */
export function selectSelectedClip(state: ProjectState): Clip | undefined {
  return state.project.clips.find((clip) => clip.id === state.selectedClipId)
}
