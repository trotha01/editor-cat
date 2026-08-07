/**
 * The project: what is on the timeline and where the playhead is.
 *
 * Every mutation persists to IndexedDB so a refresh, a crash, or a closed tab
 * does not lose work the user paid a provider to generate.
 */
import { create } from 'zustand'
import { loadProject, saveProject } from '../lib/db'
import {
  clampLeadIn,
  clipForAsset,
  joinCutAt,
  layoutClips,
  leadInOf,
  projectDuration,
  reorder,
  splitClipAt,
  trimClip,
} from '../lib/timeline'
import {
  createTrack,
  defaultTracks,
  insertTrack,
  migrateProject,
  moveAudioClip,
  placeAudioClip,
} from '../lib/audioTracks'
import {
  captionCuesOf,
  captionTracksOf,
  createCaptionTrack,
  cuesFromWords,
  cuesOnTrack,
  fitBetweenNeighbours,
  mergeCues,
  moveCue,
  setCueText,
  setWordTiming,
  splitCue,
  spreadWordsEvenly,
  trimCue,
  type TimedWord,
} from '../lib/captions'
import { newId } from '../lib/media'
import type {
  Asset,
  AudioClip,
  AudioTrack,
  AudioTrackKind,
  CaptionCue,
  CaptionStyle,
  CaptionTrack,
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
    // Vertical by default: short-form is what most of these get made for, and
    // it is far easier to notice and flip than to discover afterwards that a
    // 9:16 clip has been letterboxed into a landscape frame.
    width: 720,
    height: 1280,
    fps: 30,
  }
}

/** What `addRecording` did, so the UI can say where the take landed. */
export interface PlacementOutcome {
  trackId: string
  trackName: string
  createdTrack: boolean
}

/** Which caption, and which word inside it, the editor is working on. */
export interface CaptionSelection {
  cueId: string
  /** Null when the whole caption is selected rather than one of its words. */
  wordId: string | null
}

interface ProjectState {
  project: Project
  selectedClipId: string | null
  selectedAudioClipId: string | null
  selectedCaption: CaptionSelection | null
  loaded: boolean

  /** Opens the local project. Used when signed out or running unconfigured. */
  load: () => Promise<void>
  /** Replaces the open project wholesale, e.g. with one fetched from Supabase. */
  adopt: (project: Project) => void
  /** Opens a project from the local cache by id. */
  open: (id: string) => Promise<void>
  rename: (name: string) => void
  setResolution: (width: number, height: number) => void
  /**
   * Slides the whole picture track later, leaving black in front of it.
   *
   * Audio stays where it is: the point of the gap is to have something play
   * over it, and nothing placed by hand should move on its own.
   */
  setLeadIn: (seconds: number) => void

  addClip: (asset: Asset) => void
  removeClip: (clipId: string) => void
  selectClip: (clipId: string | null) => void
  moveClip: (from: number, to: number) => void
  trim: (clipId: string, asset: Asset | undefined, edge: 'start' | 'end', value: number) => void
  /**
   * Cuts the clip under the playhead in two at the nearest frame. False when
   * there was nothing to cut there, so the caller can leave it at that.
   */
  cutAt: (time: number) => boolean
  /** Undoes the cut in front of a clip, merging it back onto its other half. */
  removeCut: (clipId: string) => boolean
  setImageDuration: (clipId: string, seconds: number) => void
  /** Mutes or levels the sound a clip carries in its own file. */
  setClipAudio: (clipId: string, patch: { muted?: boolean; volume?: number }) => void

  /** Places audio, adding a track only if every existing one is busy there. */
  addAudioClip: (kind: AudioTrackKind, clip: Omit<AudioClip, 'id' | 'trackId'>) => PlacementOutcome
  updateAudioClip: (id: string, patch: Partial<AudioClip>) => void
  moveAudioClipTo: (id: string, startTime: number, trackId?: string) => boolean
  removeAudioClip: (id: string) => void
  selectAudioClip: (id: string | null) => void

  addTrack: (kind: AudioTrackKind) => void
  updateTrack: (id: string, patch: Partial<AudioTrack>) => void
  removeTrack: (id: string) => void

  /** The caption track, creating the first one if there is none yet. */
  ensureCaptionTrack: () => string
  updateCaptionTrack: (id: string, patch: Partial<Omit<CaptionTrack, 'id' | 'style'>>) => void
  setCaptionStyle: (id: string, patch: Partial<CaptionStyle>) => void
  removeCaptionTrack: (id: string) => void

  /**
   * Replaces a track's captions with a freshly grouped transcript. Replaces
   * rather than appends: transcribing again is how you redo a bad take, and
   * ending up with two overlapping copies of the same words is nobody's intent.
   */
  setCaptionsFromWords: (trackId: string, words: readonly TimedWord[]) => number
  selectCaption: (selection: CaptionSelection | null) => void
  updateCue: (cueId: string, update: (cue: CaptionCue) => CaptionCue | null) => void
  /** Retimes a caption, refusing a move that would land on another one. */
  moveCueTo: (cueId: string, startTime: number) => boolean
  trimCueEdge: (cueId: string, edge: 'start' | 'end', value: number) => boolean
  setCueWordTiming: (cueId: string, wordId: string, patch: { start?: number; end?: number }) => void
  setCueTextAt: (cueId: string, text: string) => void
  splitCueAt: (cueId: string, wordIndex: number) => boolean
  /** Joins a caption onto the one before it on the same track. */
  mergeCueBack: (cueId: string) => boolean
  respaceCue: (cueId: string) => void
  removeCue: (cueId: string) => void

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
    selectedCaption: null,
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
        set({
          project,
          loaded: true,
          selectedClipId: null,
          selectedAudioClipId: null,
          selectedCaption: null,
        })
      } catch {
        set({ project: emptyProject(id), loaded: true })
      }
    },

    adopt: (project) => {
      persist(project)
      set({
        project,
        loaded: true,
        selectedClipId: null,
        selectedAudioClipId: null,
        selectedCaption: null,
      })
    },

    rename: (name) => mutate((project) => ({ ...project, name })),

    setResolution: (width, height) => mutate((project) => ({ ...project, width, height })),

    setLeadIn: (seconds) => mutate((project) => ({ ...project, leadIn: clampLeadIn(seconds) })),

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

    // Nothing about a cut is stored beyond the clips themselves: two clips
    // meeting mid-source *is* the cut, so it persists with the timeline and
    // comes back with the project.
    cutAt: (time) => {
      const { project } = get()
      const result = splitClipAt(
        project.clips,
        time,
        project.fps,
        () => newId('clip'),
        leadInOf(project),
      )
      if (!result) return false
      mutate((current) => ({ ...current, clips: result.clips }))
      set({ selectedClipId: result.clipId })
      return true
    },

    removeCut: (clipId) => {
      const { project } = get()
      const result = joinCutAt(project.clips, clipId)
      if (!result) return false
      mutate((current) => ({ ...current, clips: result.clips }))
      // The clip that was selected has just been absorbed, so follow the merge
      // rather than leaving the selection pointing at an id that is gone.
      set((state) => ({
        selectedClipId: state.selectedClipId === clipId ? result.clipId : state.selectedClipId,
      }))
      return true
    },

    setImageDuration: (clipId, seconds) =>
      mutate((project) => ({
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === clipId ? { ...clip, inPoint: 0, outPoint: Math.max(0.2, seconds) } : clip,
        ),
      })),

    setClipAudio: (clipId, patch) =>
      mutate((project) => ({
        ...project,
        clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
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

    // --- Captions ---------------------------------------------------------

    ensureCaptionTrack: () => {
      const existing = captionTracksOf(get().project)[0]
      if (existing) return existing.id

      const track = createCaptionTrack(newId('ctrack'))
      mutate((project) => ({
        ...project,
        captionTracks: [...captionTracksOf(project), track],
        captionCues: [...captionCuesOf(project)],
      }))
      return track.id
    },

    updateCaptionTrack: (id, patch) =>
      mutate((project) => ({
        ...project,
        captionTracks: captionTracksOf(project).map((track) =>
          track.id === id ? { ...track, ...patch } : track,
        ),
      })),

    setCaptionStyle: (id, patch) =>
      mutate((project) => ({
        ...project,
        captionTracks: captionTracksOf(project).map((track) =>
          track.id === id ? { ...track, style: { ...track.style, ...patch } } : track,
        ),
      })),

    removeCaptionTrack: (id) => {
      mutate((project) => ({
        ...project,
        captionTracks: captionTracksOf(project).filter((track) => track.id !== id),
        captionCues: captionCuesOf(project).filter((cue) => cue.trackId !== id),
      }))
      set({ selectedCaption: null })
    },

    setCaptionsFromWords: (trackId, words) => {
      const cues = cuesFromWords(words, trackId, newId)
      mutate((project) => ({
        ...project,
        captionCues: [...captionCuesOf(project).filter((cue) => cue.trackId !== trackId), ...cues],
      }))
      set({ selectedCaption: cues[0] ? { cueId: cues[0].id, wordId: null } : null })
      return cues.length
    },

    selectCaption: (selection) => set({ selectedCaption: selection }),

    // Every caption edit funnels through here, so there is one place that knows
    // how a cue is replaced, one place where returning null deletes it — which
    // is how an emptied line stops being a caption at all — and one place that
    // keeps a growing cue off the one after it.
    updateCue: (cueId, update) => {
      let removed = false
      mutate((project) => {
        const cues = captionCuesOf(project)
        const next: CaptionCue[] = []
        for (const cue of cues) {
          if (cue.id !== cueId) {
            next.push(cue)
            continue
          }
          const result = update(cue)
          if (result) next.push(fitBetweenNeighbours(result, cues))
          else removed = true
        }
        return { ...project, captionCues: next }
      })
      if (removed) {
        set((state) => ({
          selectedCaption: state.selectedCaption?.cueId === cueId ? null : state.selectedCaption,
        }))
      }
    },

    moveCueTo: (cueId, startTime) => {
      const { project } = get()
      const cue = captionCuesOf(project).find((entry) => entry.id === cueId)
      if (!cue) return false
      const moved = moveCue(cue, startTime)
      if (overlapsAnother(captionCuesOf(project), moved)) return false
      get().updateCue(cueId, () => moved)
      return true
    },

    trimCueEdge: (cueId, edge, value) => {
      const { project } = get()
      const cue = captionCuesOf(project).find((entry) => entry.id === cueId)
      if (!cue) return false
      const trimmed = trimCue(cue, edge, value)
      if (overlapsAnother(captionCuesOf(project), trimmed)) return false
      get().updateCue(cueId, () => trimmed)
      return true
    },

    setCueWordTiming: (cueId, wordId, patch) =>
      get().updateCue(cueId, (cue) => setWordTiming(cue, wordId, patch)),

    setCueTextAt: (cueId, text) => get().updateCue(cueId, (cue) => setCueText(cue, text, newId)),

    splitCueAt: (cueId, wordIndex) => {
      const { project } = get()
      const cue = captionCuesOf(project).find((entry) => entry.id === cueId)
      if (!cue) return false
      const halves = splitCue(cue, wordIndex, newId)
      if (!halves) return false

      mutate((current) => ({
        ...current,
        captionCues: captionCuesOf(current).flatMap((entry) =>
          entry.id === cueId ? halves : [entry],
        ),
      }))
      // Follow the split: the half you were aiming at is the second one.
      set({ selectedCaption: { cueId: halves[1].id, wordId: null } })
      return true
    },

    mergeCueBack: (cueId) => {
      const { project } = get()
      const cues = captionCuesOf(project)
      const cue = cues.find((entry) => entry.id === cueId)
      if (!cue) return false

      const onTrack = cuesOnTrack(cues, cue.trackId)
      const index = onTrack.findIndex((entry) => entry.id === cueId)
      const previous = onTrack[index - 1]
      if (!previous) return false

      const merged = mergeCues(previous, cue)
      mutate((current) => ({
        ...current,
        captionCues: captionCuesOf(current)
          .filter((entry) => entry.id !== cueId)
          .map((entry) => (entry.id === previous.id ? merged : entry)),
      }))
      // The cue that was selected has just been absorbed, so follow the merge
      // rather than leaving the selection pointing at an id that is gone.
      set({ selectedCaption: { cueId: merged.id, wordId: null } })
      return true
    },

    respaceCue: (cueId) => get().updateCue(cueId, spreadWordsEvenly),

    removeCue: (cueId) => get().updateCue(cueId, () => null),

    clearTimeline: () => {
      mutate((project) => ({ ...project, clips: [], audioClips: [], captionCues: [] }))
      set({ selectedClipId: null, selectedAudioClipId: null, selectedCaption: null })
    },

    positioned: () => {
      const { project } = get()
      return layoutClips(project.clips, leadInOf(project))
    },
    duration: () => projectDuration(get().project),
  }
})

/** Convenience selector: the currently selected clip, if any. */
export function selectSelectedClip(state: ProjectState): Clip | undefined {
  return state.project.clips.find((clip) => clip.id === state.selectedClipId)
}

/**
 * Whether a retimed cue would land on top of another on its own track.
 *
 * Refused rather than allowed, for the same reason two audio clips may not share
 * a lane: two captions on screen at once cannot both be the caption, and which
 * one wins would depend on array order — an invisible property of the document.
 */
function overlapsAnother(cues: readonly CaptionCue[], cue: CaptionCue): boolean {
  return cues.some(
    (other) =>
      other.id !== cue.id &&
      other.trackId === cue.trackId &&
      cue.start < other.end - 1e-6 &&
      other.start < cue.end - 1e-6,
  )
}
