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
 * How one clip gives way to the next.
 *
 * `dissolve` is the one everybody means: the outgoing picture blends straight
 * into the incoming one. The rest are the same idea with a different shape —
 * through black, through white, wiped, slid, blurred, or opened out from the
 * middle.
 */
export type TransitionKind =
  | 'dissolve'
  | 'dipToBlack'
  | 'dipToWhite'
  | 'blur'
  | 'wipeLeft'
  | 'wipeRight'
  | 'slideLeft'
  | 'slideRight'
  | 'iris'

/**
 * A transition at the boundary between two clips.
 *
 * `duration` is how long the two clips are on screen together, and it is
 * material both of them give up: a dissolve is the tail of one shot playing at
 * the same time as the head of the next, so the timeline gets shorter by
 * exactly this much. That is what a dissolve *is* — the alternative, holding a
 * frozen frame either side to keep the length, is a different effect that looks
 * wrong for the reason it is not what any editor does.
 */
export interface Transition {
  kind: TransitionKind
  /** Seconds the two clips overlap for. */
  duration: number
}

/**
 * One entry on the visual track. Clips are laid end to end with no gaps, so a
 * clip's start time is just the sum of the durations before it — less whatever
 * transitions overlap it with its neighbours.
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
  /**
   * How this clip comes in from the one before it. Absent is a straight cut,
   * which is every boundary in every project saved before transitions existed —
   * read through `transitionOf` rather than directly.
   *
   * It lives on the incoming clip rather than in a list of its own because a
   * transition belongs to a *boundary*, and the thing that survives a reorder,
   * a trim or a cut still meaning the same boundary is the clip on the far side
   * of it. The first clip never carries one: there is no boundary in front of
   * it, and `fitTransitions` drops any that ends up there.
   */
  transition?: Transition
}

/**
 * One lane of picture above the main track.
 *
 * The track of `clips` above is still the picture: gapless, cuttable, and the
 * thing the export is built around. These lanes are what goes *over* it —
 * B-roll, an insert, a logo held in a corner of the frame — so they are
 * positioned in time like audio rather than laid end to end, and they may sit
 * over black as happily as over a clip.
 *
 * Later tracks draw over earlier ones, which is the only stacking rule there
 * is: the order in this array is the order up the screen. Nothing on the track
 * itself records where it sits, so restacking the picture is only ever moving a
 * lane along this array — and everything that draws the lanes reverses it, so
 * that the last entry, the top of the stack, is the one nearest the top of the
 * screen.
 */
export interface VideoTrack {
  id: string
  name: string
  /** Kept out of the preview and the export alike, without being deleted. */
  hidden: boolean
  /** 0 to 1, blended over whatever is beneath. 1 covers it completely. */
  opacity: number
}

/**
 * A piece of picture placed at a point in time on a video track.
 *
 * Shaped like an `AudioClip` rather than like a `Clip`, because that is how it
 * behaves: it has a start time of its own instead of following the clip before
 * it, and two of them on one lane are refused rather than rippled apart.
 */
export interface VideoClip {
  id: string
  trackId: string
  assetId: string
  /** Where this clip starts on the timeline, in seconds. */
  startTime: number
  /** Seconds into the source to start from. Always 0 for a still. */
  inPoint: number
  /** How long it is on screen. */
  duration: number
  /** Silences whatever sound the source carries. Absent means audible. */
  muted?: boolean
  /** Gain for that sound. Absent is unity. */
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

/**
 * Why a piece of audio exists, when it exists to replace a clip's own sound.
 *
 * Generated speech laid under a clip is not a take somebody recorded: it was
 * asked for in words, and the words are the thing you correct when the result
 * is still wrong. Keeping them means a second go starts from the last spelling
 * rather than from a blank box, and it is what tells the clip's menu that this
 * clip has been fixed once already — which is the difference between "fix" and
 * "redo", and between laying a second voice over the first and replacing it.
 */
export interface SpeechFix {
  /** What ElevenLabs was asked to say. */
  text: string
  /** ISO-639-1 code, when a language was enforced rather than detected. */
  language?: string
  /** The voice it was said in, or the clip's own voice when it was cloned. */
  voiceName?: string
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
  /**
   * The picture clip this audio belongs to, so it goes where that clip goes.
   *
   * Set on voice and countdown clips, which are performed *against* a shot: a
   * line read over the third clip is about the third clip, and leaving it behind
   * when that clip moves is never what was meant. Music is the exception and
   * carries no anchor — a bed runs under the whole piece and belongs to the
   * timeline rather than to any one shot.
   *
   * Absent on everything saved before this existed, and on audio dropped past
   * the end of the picture where there is no clip to belong to.
   */
  anchorClipId?: string
  /** Seconds into the source to start from. */
  inPoint: number
  /** How long the clip plays for. */
  duration: number
  /** Name of the ElevenLabs voice used, for display. */
  voiceName?: string
  /** Display label, e.g. the music file's name. */
  label?: string
  /**
   * Set on speech generated to stand in for a clip's own sound, which is muted
   * in the same edit. Absent on every recording, every music bed, and every
   * count-in — read it as "this clip is a correction of the picture above it".
   */
  speechFix?: SpeechFix
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
  /**
   * Picture layered over `clips`. Optional because every project saved before
   * layering existed has none — read through `videoTracksOf`/`videoClipsOf`
   * rather than directly.
   */
  videoTracks?: VideoTrack[]
  videoClips?: VideoClip[]
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
  /**
   * Mintspace posts this project has already been published as.
   *
   * On the project document, and therefore synced, because the question it
   * answers — "is this already up?" — is one a second machine has to be able to
   * answer too. Kept out of the undo history for the opposite reason: it
   * records something that happened in the world, and Ctrl+Z cannot unpublish
   * a video. See `recordPublication` in state/useProjectStore.ts.
   *
   * Absent on everything saved before publishing existed, which is why it is
   * optional and read through `publicationsOf`.
   */
  publications?: Publication[]
  /** Present only on projects saved before multitrack. Read by migrateProject. */
  voiceovers?: LegacyVoiceoverTake[]
}

/**
 * One video of this project, live in the Mintspace feed.
 *
 * Everything needed to find it again and to take it down is held here rather
 * than looked up, because taking it down needs two things Mintspace will not
 * tell us later: the storage object behind the row, and which account may
 * delete it. The row's id alone would leave the file orphaned in the bucket.
 */
export interface Publication {
  /** The `mintspace.videos` row id. */
  videoId: string
  /** The object in the Mintspace bucket, so the file goes with the row. */
  storagePath: string
  /** Public URL of the file, which plays on its own. */
  videoUrl: string
  /**
   * SHA-256 of the exported file, hex.
   *
   * What makes "the same video" an exact question rather than a guess: a
   * project re-exported unchanged hashes the same and is refused, while one
   * that has been edited hashes differently and is a new video, which is what
   * it is. Empty when the browser would not hash it — see lib/digest.ts.
   */
  digest: string
  /**
   * Hash of what the video was *made from* — the timeline and the export
   * settings — as opposed to `digest`, which is what it came out as.
   *
   * The two answer the same question at different moments. This one is
   * knowable before anything is rendered, so the dialog can say "already in the
   * feed" while the button is still unpressed rather than after a minute of
   * encoding. The digest is the exact one and stays the final word, because a
   * timeline can change in ways the picture does not: edit a hidden caption
   * track and this differs while the file does not.
   *
   * Absent on anything recorded before it existed, which is why it is optional.
   */
  sourceKey?: string
  caption: string | null
  /** ISO 8601, as `new Date().toISOString()` writes it. */
  publishedAt: string
  /** The Mintspace account it belongs to, which is the only one that can delete it. */
  accountId: string
  username: string
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
 * 1 was the flat `voiceovers` list; 2 is multitrack audio; 3 adds captions;
 * 4 adds video tracks layered over the picture; 5 adds transitions between
 * clips. Recorded explicitly so `migrateProject` upgrades from a known version
 * rather than inferring one from the shape.
 */
export const SCHEMA_VERSION = 5

/** A clip with its resolved timeline position. Produced by `layoutClips`. */
export interface PositionedClip {
  clip: Clip
  index: number
  /** Seconds from the start of the timeline. */
  start: number
  /** Seconds from the start of the timeline. */
  end: number
  duration: number
  /**
   * The transition into this clip, already fitted to what its neighbours can
   * afford — which is not always what the clip stores, because trimming a clip
   * shorter than its transition must not be able to produce an impossible one.
   * Null on the first clip and on every straight cut.
   *
   * It runs from `start` to `start + duration`, which is also exactly where the
   * clip before it ends: laying the clips out is what turns a stored length into
   * a stretch of timeline, so this is the only honest place to read it from.
   */
  transition: Transition | null
}
