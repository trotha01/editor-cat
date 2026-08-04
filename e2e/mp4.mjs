/**
 * A very small MP4 box reader, used to check that an export is really a valid
 * video rather than just a file that arrived.
 *
 * Why parse it by hand rather than shell out to ffmpeg: the ffmpeg that ships
 * with Playwright is a minimal build with only the WebM demuxer and no H.264
 * decoder, and headless Chromium likewise has no proprietary codec support. So
 * neither can open a correct H.264 MP4, and using either as the oracle would
 * report a perfectly good export as broken. Reading the container directly
 * checks exactly what we control.
 */

/** Parses the top-level box structure and pulls out the details we care about. */
export function unpack(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const boxes = []

  let offset = 0
  let complete = false
  while (offset + 8 <= buffer.length) {
    const size = view.getUint32(offset)
    const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8))
    boxes.push(type)
    if (size < 8) break
    offset += size
    if (offset === buffer.length) {
      complete = true
      break
    }
  }

  return {
    boxes,
    complete,
    hasVideo: indexOfAscii(buffer, 'avc1', 32) > 0,
    hasAudio: indexOfAscii(buffer, 'mp4a', 32) > 0,
    ...readMovieHeader(buffer, view),
    ...readVisualSampleEntry(buffer, view),
  }
}

function readMovieHeader(buffer, view) {
  const at = indexOfAscii(buffer, 'mvhd', 0)
  if (at < 0) return { durationSeconds: 0 }
  // mvhd v0: 4 type + 4 version/flags + 4 created + 4 modified + 4 timescale + 4 duration
  const timescale = view.getUint32(at + 16)
  const duration = view.getUint32(at + 20)
  return { durationSeconds: timescale ? duration / timescale : 0 }
}

function readVisualSampleEntry(buffer, view) {
  const at = indexOfAscii(buffer, 'avc1', 32)
  if (at < 0) return { width: 0, height: 0 }
  // VisualSampleEntry: 8 reserved + 2 ref index... width/height sit 24 bytes in.
  return { width: view.getUint16(at + 28), height: view.getUint16(at + 30) }
}

function indexOfAscii(buffer, needle, from) {
  return buffer.indexOf(Buffer.from(needle, 'ascii'), from)
}
