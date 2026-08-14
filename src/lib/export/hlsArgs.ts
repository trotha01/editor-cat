/**
 * Packaging a finished MP4 as HLS, as argv and as text.
 *
 * Pure, like buildGraph.ts and for the same reason: everything here can be
 * asserted without loading thirty megabytes of wasm, so the parts that are easy
 * to get subtly wrong — the segment duration, the shape of the playlist, the
 * form of a segment URI — are checked by fast tests rather than by watching a
 * video and hoping.
 *
 * One rendition, stream-copied. `-c copy` means this is a remux rather than a
 * re-encode: seconds of work, no quality lost, and no second trip through the
 * single-threaded encoder. What it buys is segmented delivery — a player starts
 * on the first segment instead of waiting for a moov atom, and seeks by fetching
 * a segment rather than range-requesting into a progressive file. What it does
 * not buy is adaptive bitrate, which would need a full encode per rung.
 */

/**
 * Seconds per segment.
 *
 * **This number appears twice and the two must agree**: here, as `-hls_time`,
 * and in the encoder's `-force_key_frames` expression. `-c copy` can only cut
 * at a keyframe, so a segmenter asked for four-second segments over a stream
 * whose keyframes land every eight will quietly produce eight-second ones. Both
 * uses derive from this constant, and a test pins that they do.
 *
 * Four is the usual VOD choice: short enough that a player can start quickly and
 * switch soon, long enough that the playlist and the per-segment overhead stay
 * small.
 */
export const HLS_SEGMENT_SECONDS = 4

/** Names inside the packaging directory. Bare, because URIs are relative. */
export const PLAYLIST_NAME = 'index.m3u8'
export const INIT_NAME = 'init.mp4'
export const SEGMENT_PATTERN = 'seg%05d.m4s'
export const POSTER_NAME = 'poster.jpg'

/** Content types the uploader pins into each object's signature. */
export const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  jpg: 'image/jpeg',
}

export function contentTypeFor(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

export interface HlsArgsOptions {
  /** The finished MP4, already in ffmpeg's filesystem. */
  input: string
  /** Directory the playlist and segments are written into, relative to cwd. */
  dir: string
  segmentSeconds?: number
}

/**
 * The packaging command.
 *
 * Every path is **relative**. That is not tidiness: ffmpeg derives the segment
 * URIs it writes into the playlist from `-hls_segment_filename`, so an absolute
 * `/hls/seg%05d.m4s` can put an absolute `/seg00001.m4s` in the playlist — which
 * resolves against the *CDN root* rather than against the playlist, 404s in
 * production, and works perfectly on a local server rooted at the same place.
 * `normalizePlaylistUris` checks the result rather than trusting this.
 *
 * `-hls_base_url` is deliberately never set. Relative URIs mean one playlist
 * works on any domain, and a domain change later does not strand every video
 * already published.
 */
export function buildHlsArgs(options: HlsArgsOptions): string[] {
  const seconds = options.segmentSeconds ?? HLS_SEGMENT_SECONDS

  return [
    '-i',
    options.input,
    // The whole point: no re-encode. Both streams are already what we want.
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    String(seconds),
    // A finished export is complete when it is written, so the playlist is a
    // VOD one and carries an ENDLIST. Without this a player treats it as live
    // and keeps asking for more.
    '-hls_playlist_type',
    'vod',
    // Keep every segment in the playlist. The default drops old entries, which
    // is right for a live stream and wrong for a video somebody scrubs.
    '-hls_list_size',
    '0',
    // fMP4 rather than MPEG-TS: the same codecs the MP4 already holds, so the
    // copy is a repackage rather than a re-container, and no audio is padded.
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    INIT_NAME,
    '-hls_segment_filename',
    `${options.dir}/${SEGMENT_PATTERN}`,
    `${options.dir}/${PLAYLIST_NAME}`,
  ]
}

/** One still, for the feed card to show before the manifest resolves. */
export function buildPosterArgs(input: string, output: string): string[] {
  return [
    '-i',
    input,
    // The first frame. `-frames:v 1` after the input is the cheap form: it
    // stops decoding immediately rather than seeking.
    '-frames:v',
    '1',
    '-q:v',
    '3',
    output,
  ]
}

/**
 * The `-force_key_frames` expression the encoder needs for `-c copy` to work.
 *
 * Without it libx264's defaults apply — a 250-frame GOP, so 8.33s at 30fps,
 * plus scene-cut keyframes wherever the edit happens to put them. The segmenter
 * can only cut at a keyframe, so `-hls_time 4` is silently ignored and segment
 * length becomes a function of the user's edit rather than of configuration.
 *
 * Chosen over `-sc_threshold 0`, which is the reflex recipe and wrong here:
 * suppressing scene-cut keyframes costs visible quality at exactly the frames a
 * cuts-based editor produces most, and buys nothing, since extra keyframes
 * between the forced boundaries are simply ignored by the segmenter.
 */
export function forceKeyframesExpr(seconds: number): string {
  return `expr:gte(t,n_forced*${seconds})`
}

/**
 * Rewrites a playlist so every URI is a bare filename.
 *
 * The invariant this enforces is that a segment is resolved *against the
 * playlist*, so the same playlist works under any prefix on any domain. ffmpeg
 * is asked for relative paths above; this is what makes it a guarantee rather
 * than an expectation, because the failure mode is a 404 only in production.
 *
 * Two kinds of line carry a URI: a bare one after `#EXTINF`, and the quoted
 * `URI="…"` inside `#EXT-X-MAP`.
 */
export function normalizePlaylistUris(playlist: string): string {
  return playlist
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()

      if (trimmed.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]*)"/, (_, uri: string) => `URI="${basename(uri)}"`)
      }

      // Any other tag, a comment, or a blank line is left exactly as it is.
      if (trimmed.startsWith('#') || trimmed === '') return line

      return basename(trimmed)
    })
    .join('\n')
}

function basename(uri: string): string {
  // Query strings and fragments have no business in a VOD playlist we wrote,
  // but stripping the path is the job here, so do it on the path alone.
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri
  const lastSlash = withoutQuery.lastIndexOf('/')
  return lastSlash === -1 ? withoutQuery : withoutQuery.slice(lastSlash + 1)
}

/** Every segment URI a playlist references, in order. */
export function segmentUris(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** The init segment named by `#EXT-X-MAP`, if the playlist has one. */
export function initUri(playlist: string): string | null {
  const match = /#EXT-X-MAP:[^\n]*URI="([^"]*)"/.exec(playlist)
  return match?.[1] ?? null
}
