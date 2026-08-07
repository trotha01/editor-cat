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
 * Voice, music and cues live on separate kinds of track because they are mixed
 * differently: narration wants to sit on top at full level, score wants to sit
 * underneath. Keeping the kind on the track means a new recording can never
 * land in the middle of the music bed.
 *
 * `countdown` is the count-in beeps. They get a lane of their own for the same
 * reason, plus one more: a cue you want to nudge to an exact spot should never
 * be blocked by a take that happens to be under it, and on its own lane it
 * never is. It also makes them one click to mute if you want them out of a
 * particular export.
 */
export type AudioTrackKind = 'voice' | 'music' | 'countdown'

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

/**
 * One spoken word, with the stretch of timeline it is *the* word for.
 *
 * Word times are absolute timeline seconds rather than offsets into a cue, so
 * moving a cue and retiming a word are the same kind of edit and neither can
 * leave the other stale. `start` is what the highlight moves on; `end` is where
 * the word stops being spoken, which is not always where the next one starts —
 * people pause.
 */
export interface CaptionWord {
  id: string
  text: string
  /** Seconds from the start of the timeline. */
  start: number
  /** Seconds from the start of the timeline. Never before `start`. */
  end: number
}

/**
 * A caption: the group of words shown together on screen, one line's worth.
 *
 * Its own `start`/`end` are stored rather than derived from the words because
 * they are separately editable — a caption can be brought up a beat before the
 * first word and held after the last, which is what stops fast speech reading
 * as a flicker.
 */
/**
 * Which clip a caption was transcribed from.
 *
 * Provenance, kept because a caption on the timeline otherwise says nothing
 * about where its words came from — and with several takes layered over the same
 * seconds, "which one is this" is the first question worth being able to answer.
 * The label is a snapshot taken when the transcript was made, so a caption whose
 * clip has since been deleted still says where it came from rather than holding
 * a dangling id.
 */
export interface CaptionSource {
  /** The clip's id: an audio clip on a voice track, or a video clip. */
  id: string
  /** What that clip's media was called at the time. */
  label: string
}

export interface CaptionCue {
  id: string
  trackId: string
  /** Seconds from the start of the timeline. */
  start: number
  end: number
  words: CaptionWord[]
  /**
   * Where these words were heard. Absent on a caption typed by hand, and on
   * every project captioned before this was recorded.
   */
  source?: CaptionSource
}

/** How captions are drawn, on screen and in the export alike. */
export interface CaptionStyle {
  /**
   * Cap height as a fraction of the frame height, not a point size: a project
   * exported at 1080 and previewed at 300px high has to look the same, and the
   * export resolution is changed from the export dialog after the fact.
   */
  fontScale: number
  bold: boolean
  uppercase: boolean
  /** Words not currently being spoken. `#rrggbb`. */
  color: string
  /** The word being spoken right now. `#rrggbb`. */
  highlightColor: string
  /** Outline drawn around every glyph, so text survives a bright background. */
  outlineColor: string
  /** Outline thickness, as a fraction of the font size. */
  outlineScale: number
  /**
   * Where the baseline block sits, 0 at the top of the frame and 1 at the
   * bottom. Captions default low but clear of the very edge, where phone UI
   * lives.
   */
  position: number
}

/**
 * A lane of captions.
 *
 * Style lives on the track rather than on each cue: captions are meant to look
 * like one thing, and a second track is how you get a second look (a
 * translation, a title band) without restyling every line.
 */
export interface CaptionTrack {
  id: string
  name: string
  /** Kept out of the preview and the export, without deleting the words. */
  hidden: boolean
  style: CaptionStyle
}

export interface Project {
  id: string
  name: string
  clips: Clip[]
  audioTracks: AudioTrack[]
  audioClips: AudioClip[]
  /**
   * Captions. Optional because every project saved before they existed has
   * none — read through `captionsOf` rather than directly.
   */
  captionTracks?: CaptionTrack[]
  captionCues?: CaptionCue[]
  /**
   * Seconds of black before the first clip, so something can be heard before
   * anything is seen — a count-in, a slate, a beat of silence.
   *
   * One number on the project rather than a gap between clips: clips still sit
   * end to end with nothing between them, and all this moves is where the
   * strip starts. Absent on everything saved before it existed, which is why
   * it is optional and read through `leadInOf`.
   */
  leadIn?: number
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
 * 1 was the flat `voiceovers` list; 2 is multitrack audio; 3 adds captions.
 * Recorded explicitly so `migrateProject` upgrades from a known version rather
 * than inferring one from the shape.
 */
export const SCHEMA_VERSION = 3

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
