/** Domain types shared across the app. */

export type AssetKind = 'image' | 'video' | 'audio'

/**
 * A piece of media we own the bytes for. Blobs live in IndexedDB under
 * `blobKey`; everything here is the metadata we can cheaply keep in memory.
 */
export interface Asset {
  id: string
  kind: AssetKind
  blobKey: string
  mimeType: string
  /** Display name in the library. */
  name: string
  width?: number
  height?: number
  /** Seconds. Present for video and audio. */
  duration?: number
  /**
   * The provider URL this came from, if any. Kept for two reasons: it lets us
   * hand a URL straight back to the video model instead of re-uploading bytes,
   * and it is the fallback source if byte ingestion failed.
   */
  sourceUrl?: string
  /** What prompt produced this, for provenance in the library. */
  prompt?: string
  /**
   * The file's id in the user's Drive, once it has been backed up there (or if
   * it was imported from there). Its presence is what stops the uploader from
   * sending the same bytes back to Drive a second time.
   */
  driveFileId?: string
  createdAt: number
}

/**
 * One entry on the visual track. Clips are laid end to end with no gaps, so a
 * clip's start time is just the sum of the durations before it.
 */
export interface Clip {
  id: string
  assetId: string
  /**
   * Seconds into the source asset. Normally 0 for images, which have no source
   * time to seek into — but a cut carries it forward there too, so the second
   * half of a cut still can be told apart from a separate copy of the same
   * picture, and the cut can be undone.
   */
  inPoint: number
  /** Seconds into the source asset. For images this is where it stops showing. */
  outPoint: number
  /**
   * Silences whatever sound the source carries. Absent means audible: a clip
   * saved before clips had sound should start playing it, not stay mute.
   */
  muted?: boolean
  /** Gain for that sound. Absent is unity, matching the audio tracks. */
  volume?: number
}

/**
 * Voice and music live on separate kinds of track because they are mixed
 * differently: narration wants to sit on top at full level, score wants to sit
 * underneath. Keeping the kind on the track means a new recording can never
 * land in the middle of the music bed.
 */
export type AudioTrackKind = 'voice' | 'music'

/** One lane of audio. Layering is just having more than one of these. */
export interface AudioTrack {
  id: string
  kind: AudioTrackKind
  name: string
  muted: boolean
  /** Playback and export gain. 1 is unity; music defaults lower. */
  volume: number
}

/** A piece of audio placed at a point in time on a track. */
export interface AudioClip {
  id: string
  trackId: string
  /** The source recording or music file. Never replaced by a conversion. */
  assetId: string
  /** The ElevenLabs speech-to-speech result, once converted. */
  convertedAssetId?: string
  /** Which of the two to play and export. */
  useConverted: boolean
  /** Where this clip starts on the timeline, in seconds. */
  startTime: number
  /** Seconds into the source to start from. */
  inPoint: number
  /** How long the clip plays for. */
  duration: number
  /** Name of the ElevenLabs voice used, for display. */
  voiceName?: string
  /** Display label, e.g. the music file's name. */
  label?: string
}

/**
 * The pre-multitrack shape, kept only so stored projects can be migrated.
 * Nothing new should be written in this form.
 *
 * @deprecated Superseded by AudioTrack + AudioClip.
 */
export interface LegacyVoiceoverTake {
  id: string
  assetId: string
  convertedAssetId?: string
  useConverted: boolean
  startTime: number
  duration: number
  voiceName?: string
}

export interface Project {
  id: string
  name: string
  clips: Clip[]
  audioTracks: AudioTrack[]
  audioClips: AudioClip[]
  width: number
  height: number
  fps: number
  /** Present only on projects saved before multitrack. Read by migrateProject. */
  voiceovers?: LegacyVoiceoverTake[]
}

/**
 * The part of a project that gets stored as one value.
 *
 * `id` and `name` are columns of their own so the project list can be rendered
 * without pulling every timeline down with it.
 */
export type ProjectDoc = Omit<Project, 'id' | 'name' | 'voiceovers'>

/**
 * The shape version written alongside a stored document.
 *
 * 1 was the flat `voiceovers` list; 2 is multitrack audio. Recorded explicitly
 * so `migrateProject` upgrades from a known version rather than inferring one
 * from the shape.
 */
export const SCHEMA_VERSION = 2

/** A clip with its resolved timeline position. Produced by `layoutClips`. */
export interface PositionedClip {
  clip: Clip
  index: number
  /** Seconds from the start of the timeline. */
  start: number
  /** Seconds from the start of the timeline. */
  end: number
  duration: number
}
