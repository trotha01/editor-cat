/**
 * Karaoke captions as an ASS subtitle file, for ffmpeg to burn in.
 *
 * ASS has karaoke tags of its own (`\k`), and they are the wrong tool here: they
 * fill a line progressively, leaving every word already sung in the highlight
 * colour. What this editor shows — and what short-form captions mean by
 * karaoke — is a single word lit at a time, with the rest of the line plain.
 *
 * So each word gets a subtitle event of its own carrying the *whole* line, with
 * only that word recoloured. The text is identical every time, which is what
 * keeps the line from re-wrapping or shifting as the highlight moves across it;
 * only the colour changes. A minute of speech is a couple of hundred events,
 * which libass renders without noticing.
 *
 * The events come from `wordSpans`, the same function the preview highlights
 * from, so the burnt-in captions cannot drift from what was edited.
 *
 * Pure: cues and a style in, a string out. Export bugs are filtergraph and file
 * format bugs, and this way they are caught by asserting on the text rather than
 * by rendering a video and squinting at it.
 */
import { cuesOnTrack, wordSpans } from '../captions'
import type { CaptionCue, CaptionStyle, CaptionTrack } from '../types'

/**
 * The family name inside the shipped font file, which is what libass matches a
 * style against — not the CSS family the preview asks for, which is suffixed to
 * stay clear of an installed copy. The two name the same bytes.
 */
const FONT_NAME = 'Lindy Toon Wide'

/** One ASS style per caption track, since style is a property of the track. */
function styleNameFor(index: number): string {
  return `Cap${index}`
}

export interface AssSpec {
  /** Caption tracks to burn in. Hidden ones are expected to be dropped already. */
  tracks: readonly CaptionTrack[]
  cues: readonly CaptionCue[]
  /** Output frame size. The file is authored in these units. */
  width: number
  height: number
}

/**
 * `#rrggbb` to the `&HAABBGGRR` ASS wants — byte-reversed from every other
 * colour notation, and with alpha inverted so 00 is opaque.
 */
export function assColor(hex: string, alpha = 0): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const rgb = match?.[1] ?? 'ffffff'
  const r = rgb.slice(0, 2)
  const g = rgb.slice(2, 4)
  const b = rgb.slice(4, 6)
  const a = Math.round(Math.min(255, Math.max(0, alpha)))
    .toString(16)
    .padStart(2, '0')
  return `&H${a}${b}${g}${r}`.toUpperCase()
}

/** Seconds as ASS's `h:mm:ss.cc`, which is centiseconds and no more. */
export function assTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  // Rounded to the precision the format has, so the last event does not end a
  // hundredth of a second before the frame it is meant to cover.
  const total = Math.round(safe * 100) / 100
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const rest = total - hours * 3600 - minutes * 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`
}

/**
 * Escapes text for an event line.
 *
 * Braces open an override block and a backslash starts a tag, so a caption
 * containing either would be silently reinterpreted as formatting. Newlines end
 * the event outright. None of these are common in speech, and all of them are
 * possible once the transcript is editable by hand.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '∖') // set minus: looks like a backslash, is not a tag
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/[\r\n]+/g, ' ')
}

function displayText(text: string, uppercase: boolean): string {
  return escapeAssText(uppercase ? text.toUpperCase() : text)
}

/**
 * Where the line sits.
 *
 * ASS positions a bottom-aligned block by its margin from the bottom edge, so
 * the style's 0-at-the-top fraction has to be turned around. Half the font size
 * is taken off so `position` refers to the middle of the line rather than to its
 * baseline, which is what dragging it in the preview appears to do.
 */
function bottomMargin(style: CaptionStyle, height: number): number {
  const fontSize = style.fontScale * height
  return Math.max(0, Math.round(height * (1 - style.position) - fontSize / 2))
}

export function buildAssFile({ tracks, cues, width, height }: AssSpec): string {
  const styles: string[] = []
  const events: string[] = []

  tracks.forEach((track, index) => {
    const styleName = styleNameFor(index)
    styles.push(styleLine(styleName, track.style, width, height))

    for (const cue of cuesOnTrack(cues, track.id)) {
      const spans = wordSpans(cue)

      // A cue can be brought up before its first word. Show the line unlit for
      // that beat rather than leaving the screen empty until someone speaks.
      const first = spans[0]
      if (first && first.start > cue.start + 0.01) {
        events.push(event(styleName, cue.start, first.start, line(cue, -1, track.style)))
      }
      for (const span of spans) {
        events.push(event(styleName, span.start, span.end, line(cue, span.index, track.style)))
      }
      if (spans.length === 0 && cue.words.length > 0) {
        events.push(event(styleName, cue.start, cue.end, line(cue, -1, track.style)))
      }
    }
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Authoring in output pixels means the sizes here are the sizes rendered:
    // no scaling factor to get wrong when the export resolution changes.
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    // Outlines scale with the resolution rather than staying a fixed number of
    // pixels, which is the same promise the style's fractions make.
    'ScaledBorderAndShadow: yes',
    // Balanced wrapping: a two-line caption reads far better split evenly than
    // with one full line and one orphan.
    'WrapStyle: 0',
    // Stops libass from second-guessing the colours as broadcast-range YUV,
    // which shifts every one of them.
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

function styleLine(name: string, style: CaptionStyle, width: number, height: number): string {
  const fontSize = Math.max(1, Math.round(style.fontScale * height))
  const outline = Math.max(0, Math.round(fontSize * style.outlineScale * 10) / 10)
  // A soft drop under the outline: it lifts pale text off a bright frame in the
  // one case an outline alone does not, which is a thin stroke on white.
  const shadow = Math.max(0, Math.round(fontSize * 0.03 * 10) / 10)

  return [
    `Style: ${name}`,
    FONT_NAME,
    fontSize,
    assColor(style.color),
    // SecondaryColour is only read by ASS's own karaoke tags, which this file
    // does not use — the highlight is an inline override per event instead.
    assColor(style.highlightColor),
    assColor(style.outlineColor),
    assColor('#000000', 128),
    style.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    outline,
    shadow,
    // 2 = bottom centre. The line is positioned by its bottom margin.
    2,
    // Side margins keep long lines off the edge of a vertical frame.
    Math.round(width * 0.06),
    Math.round(width * 0.06),
    bottomMargin(style, height),
    1,
  ].join(',')
}

function event(styleName: string, start: number, end: number, text: string): string {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${text}`
}

/**
 * The whole line, with one word recoloured.
 *
 * `\c` overrides only the fill, leaving outline and shadow to the style, so a
 * highlighted word keeps exactly the same silhouette as the rest of the line and
 * nothing shifts as the highlight moves. Passing -1 renders the line unlit.
 */
function line(cue: CaptionCue, activeIndex: number, style: CaptionStyle): string {
  const plain = assColor(style.color)
  const highlight = assColor(style.highlightColor)
  return cue.words
    .map((word, index) => {
      const text = displayText(word.text, style.uppercase)
      return index === activeIndex ? `{\\c${highlight}}${text}{\\c${plain}}` : text
    })
    .join(' ')
}
