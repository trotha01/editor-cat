import { describe, expect, it } from 'vitest'
import {
  HLS_SEGMENT_SECONDS,
  buildHlsArgs,
  buildPosterArgs,
  contentTypeFor,
  forceKeyframesExpr,
  initUri,
  normalizePlaylistUris,
  segmentUris,
} from './hlsArgs'
import { buildExportPlan } from './buildGraph'

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

describe('buildHlsArgs', () => {
  const args = buildHlsArgs({ input: 'hls-input.mp4', dir: 'hls' })

  it('stream copies rather than re-encoding', () => {
    // The whole reason packaging is affordable in a single-threaded wasm build:
    // a remux takes seconds and loses nothing.
    expect(argAfter(args, '-c')).toBe('copy')
  })

  it('asks for VOD segments of the shared length', () => {
    expect(argAfter(args, '-hls_time')).toBe(String(HLS_SEGMENT_SECONDS))
    expect(argAfter(args, '-hls_playlist_type')).toBe('vod')
    // The default drops old entries from the playlist, which is right for live
    // and wrong for a video somebody scrubs backwards through.
    expect(argAfter(args, '-hls_list_size')).toBe('0')
  })

  it('writes fMP4 segments beside their init segment', () => {
    expect(argAfter(args, '-hls_segment_type')).toBe('fmp4')
    expect(argAfter(args, '-hls_fmp4_init_filename')).toBe('init.mp4')
  })

  it('keeps every path relative', () => {
    // An absolute segment pattern can put an absolute URI in the playlist,
    // which resolves against the CDN root instead of the playlist — a 404 in
    // production that works locally.
    for (const arg of args) {
      expect(arg.startsWith('/'), `"${arg}" should not be absolute`).toBe(false)
    }
  })

  it('never sets a base URL, so one playlist works on any domain', () => {
    expect(args).not.toContain('-hls_base_url')
  })

  it('honours an explicit segment length', () => {
    expect(
      argAfter(buildHlsArgs({ input: 'i.mp4', dir: 'h', segmentSeconds: 6 }), '-hls_time'),
    ).toBe('6')
  })
})

describe('the segment length is one number in two places', () => {
  it('drives both the encoder keyframes and the segmenter', () => {
    // This is the drift guard. `-c copy` cuts only at keyframes, so if these two
    // ever disagree the segmenter silently produces whatever the GOP allows and
    // -hls_time becomes decorative.
    const plan = buildExportPlan({
      clips: [{ file: 'a.mp4', kind: 'video', inPoint: 0, duration: 5 }],
      audio: [],
      width: 1080,
      height: 1920,
      fps: 30,
      outputFile: 'out.mp4',
      keyframeSeconds: HLS_SEGMENT_SECONDS,
    })

    expect(argAfter(plan.args, '-force_key_frames')).toBe(forceKeyframesExpr(HLS_SEGMENT_SECONDS))
    expect(argAfter(buildHlsArgs({ input: 'out.mp4', dir: 'hls' }), '-hls_time')).toBe(
      String(HLS_SEGMENT_SECONDS),
    )
  })
})

describe('forceKeyframesExpr', () => {
  it('forces a keyframe on every multiple of the segment length', () => {
    expect(forceKeyframesExpr(4)).toBe('expr:gte(t,n_forced*4)')
  })
})

describe('buildPosterArgs', () => {
  it('takes a single frame', () => {
    const args = buildPosterArgs('in.mp4', 'poster.jpg')
    expect(argAfter(args, '-frames:v')).toBe('1')
    expect(args.at(-1)).toBe('poster.jpg')
  })
})

describe('contentTypeFor', () => {
  it('names what each part of a package is', () => {
    expect(contentTypeFor('index.m3u8')).toBe('application/vnd.apple.mpegurl')
    expect(contentTypeFor('init.mp4')).toBe('video/mp4')
    expect(contentTypeFor('seg00001.m4s')).toBe('video/iso.segment')
    expect(contentTypeFor('poster.jpg')).toBe('image/jpeg')
  })

  it('does not guess at something it does not know', () => {
    // A wrong content type is pinned into the upload signature, so guessing
    // would fail the PUT rather than merely mislabel the object.
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream')
  })
})

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
seg00001.m4s
#EXTINF:3.500000,
seg00002.m4s
#EXT-X-ENDLIST
`

describe('normalizePlaylistUris', () => {
  it('leaves an already-relative playlist alone', () => {
    expect(normalizePlaylistUris(PLAYLIST)).toBe(PLAYLIST)
  })

  it('strips a leading path off segment URIs', () => {
    // The failure this exists for: ffmpeg derived the URI from an absolute
    // segment pattern, so the player resolves it against the CDN root.
    const absolute = PLAYLIST.replace(/seg0000/g, '/hls/seg0000')
    expect(normalizePlaylistUris(absolute)).toBe(PLAYLIST)
  })

  it('strips a path out of the EXT-X-MAP URI too', () => {
    const absolute = PLAYLIST.replace('URI="init.mp4"', 'URI="/hls/init.mp4"')
    expect(normalizePlaylistUris(absolute)).toBe(PLAYLIST)
  })

  it('handles a relative directory prefix as well as an absolute one', () => {
    const nested = PLAYLIST.replace(/seg0000/g, 'hls/seg0000')
    expect(normalizePlaylistUris(nested)).toBe(PLAYLIST)
  })

  it('does not touch tags, comments or blank lines', () => {
    const withBlanks = '#EXTM3U\n\n# a comment\n#EXT-X-ENDLIST\n'
    expect(normalizePlaylistUris(withBlanks)).toBe(withBlanks)
  })

  it('leaves the trailing newline where it was', () => {
    // A playlist is compared byte for byte by the e2e test; gaining or losing a
    // newline here would be a confusing failure a long way from the cause.
    expect(normalizePlaylistUris('#EXTM3U\nseg.m4s\n')).toBe('#EXTM3U\nseg.m4s\n')
  })
})

describe('reading a playlist back', () => {
  it('lists the segments in order', () => {
    expect(segmentUris(PLAYLIST)).toEqual(['seg00001.m4s', 'seg00002.m4s'])
  })

  it('finds the init segment', () => {
    expect(initUri(PLAYLIST)).toBe('init.mp4')
  })

  it('says so when there is no init segment', () => {
    expect(initUri('#EXTM3U\nseg.m4s\n')).toBeNull()
  })
})
