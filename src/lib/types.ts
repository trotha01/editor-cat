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
  createdAt: number
}

/**
 * One entry on the visual track. Clips are laid end to end with no gaps, so a
 * clip's start time is just the sum of the durations before it.
 */
export interface Clip {
  id: string
  assetId: string
  /** Seconds into the source asset. Always 0 for images. */
  inPoint: number
  /** Seconds into the source asset. For images this is the authored duration. */
  outPoint: number
}

/** A single voiceover recording, optionally with an ElevenLabs conversion. */
export interface VoiceoverTake {
  id: string
  /** The raw microphone recording. Never destroyed by conversion. */
  assetId: string
  /** The ElevenLabs speech-to-speech result, once converted. */
  convertedAssetId?: string
  /** Which of the two to play and export. */
  useConverted: boolean
  /** Where this take starts on the timeline, in seconds. */
  startTime: number
  duration: number
  /** Name of the ElevenLabs voice used, for display. */
  voiceName?: string
}

export interface Project {
  id: string
  name: string
  clips: Clip[]
  voiceovers: VoiceoverTake[]
  width: number
  height: number
  fps: number
}

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
