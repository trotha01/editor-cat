import { describe, expect, it } from 'vitest'
import { isSafeName } from '../../../netlify/lib/r2Keys'
import { contentTypeOf, isSetId, nameSelection, numberedName, storageName, toSetId } from './names'

/**
 * The names a camera roll turns into.
 *
 * `isSafeName` is imported from the endpoint's own module rather than
 * re-expressed here, because the whole point of this file is that the two agree:
 * a name this module produces and that one refuses is four hundred photos
 * failing one at a time, and a test with its own copy of the rule would not
 * notice.
 */

/** A stand-in for `File`, which is all these functions read of one. */
function file(name: string, type = ''): { name: string; type: string } {
  return { name, type }
}

describe('contentTypeOf', () => {
  it('believes the browser when it says something usable', () => {
    expect(contentTypeOf(file('a.jpg', 'image/jpeg'))).toBe('image/jpeg')
    expect(contentTypeOf(file('clip.mov', 'video/quicktime'))).toBe('video/quicktime')
  })

  it('falls back to the extension, which is how a camera roll arrives', () => {
    // The case this exists for: browsers do not all have HEIC in their table,
    // so most of an iPhone's photos turn up with no type at all.
    expect(contentTypeOf(file('IMG_0142.HEIC'))).toBe('image/heic')
    expect(contentTypeOf(file('IMG_0142.JPG'))).toBe('image/jpeg')
    expect(contentTypeOf(file('clip.MOV', ''))).toBe('video/quicktime')
  })

  it('ignores a parameter on the type', () => {
    expect(contentTypeOf(file('a.jpg', 'image/jpeg; charset=binary'))).toBe('image/jpeg')
  })

  it('refuses what a training set does not hold', () => {
    expect(contentTypeOf(file('notes.txt', 'text/plain'))).toBeNull()
    expect(contentTypeOf(file('song.mp3', 'audio/mpeg'))).toBeNull()
    expect(contentTypeOf(file('page.html', 'text/html'))).toBeNull()
    // An unhelpful type and an unknown extension is not a photo either.
    expect(contentTypeOf(file('mystery', 'application/octet-stream'))).toBeNull()
  })
})

describe('storageName', () => {
  it('leaves a name that is already fine alone', () => {
    expect(storageName(file('img-0001.jpg', 'image/jpeg'), 0, 'image/jpeg')).toBe('img-0001.jpg')
  })

  it('takes the spaces, brackets and case out of a real filename', () => {
    expect(storageName(file('IMG_0142 (1).HEIC'), 0, 'image/heic')).toBe('img_0142-1.heic')
  })

  it('folds accents rather than replacing them with dashes', () => {
    expect(storageName(file('Grandma’s café.jpg'), 0, 'image/jpeg')).toBe('grandma-s-cafe.jpg')
  })

  it('numbers a name with nothing left of it', () => {
    // A stem in a script with no ASCII form sanitises to nothing, which is the
    // one case a positional fallback is needed for.
    expect(storageName(file('写真.png'), 6, 'image/png')).toBe('photo-0007.png')
  })

  it('supplies an extension when the file has none', () => {
    expect(storageName(file('portrait', 'image/jpeg'), 0, 'image/jpeg')).toBe('portrait.jpg')
  })

  it('truncates the stem and never the extension', () => {
    const long = storageName(file(`${'a'.repeat(200)}.jpeg`), 0, 'image/jpeg')
    expect(long.endsWith('.jpeg')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(64)
  })

  it('produces a name the endpoint will store, for anything at all', () => {
    const awkward = [
      '../../etc/passwd.jpg',
      '..',
      '.hidden.png',
      '   .jpg',
      'emoji🙂.png',
      '写真.png',
      `${'x'.repeat(300)}.jpeg`,
      'a\\b.jpg',
      '%2e%2e.jpg',
    ]

    for (const name of awkward) {
      expect(isSafeName(storageName(file(name), 0, 'image/jpeg')), `for "${name}"`).toBe(true)
    }
  })
})

describe('numberedName', () => {
  it('counts up before the extension', () => {
    expect(numberedName('photo.jpg', 2)).toBe('photo-2.jpg')
    expect(numberedName('photo.jpg', 11)).toBe('photo-11.jpg')
  })

  it('stays inside the cap', () => {
    const name = numberedName(`${'a'.repeat(60)}.jpg`, 2)
    expect(name.length).toBeLessThanOrEqual(64)
    expect(isSafeName(name)).toBe(true)
  })
})

describe('nameSelection', () => {
  it('is a pure function of the filenames, so re-picking a folder lines up', () => {
    // The property the whole page rests on: an interrupted upload is resumed by
    // picking the same folder again, which only skips what is already there if
    // the same file gets the same name both times.
    const folder = [file('IMG_0001.HEIC'), file('IMG_0002.HEIC'), file('IMG_0003.HEIC')]
    const once = nameSelection(folder).named.map((entry) => entry.name)
    const twice = nameSelection([...folder]).named.map((entry) => entry.name)
    expect(once).toEqual(twice)
    expect(once).toEqual(['img_0001.heic', 'img_0002.heic', 'img_0003.heic'])
  })

  it('numbers two files that would land on the same name', () => {
    const result = nameSelection([file('a b.jpg', 'image/jpeg'), file('a-b.jpg', 'image/jpeg')])
    expect(result.named.map((entry) => entry.name)).toEqual(['a-b.jpg', 'a-b-2.jpg'])
  })

  it('sets aside what the bucket will not take, and keeps the rest', () => {
    const result = nameSelection([
      file('one.jpg', 'image/jpeg'),
      file('notes.txt', 'text/plain'),
      file('two.png', 'image/png'),
    ])

    expect(result.named.map((entry) => entry.name)).toEqual(['one.jpg', 'two.png'])
    expect(result.rejected.map((entry) => entry.file.name)).toEqual(['notes.txt'])
  })

  it('carries the content type each file will be signed for', () => {
    // It has to be the one the PUT sends, or R2 answers SignatureDoesNotMatch.
    const result = nameSelection([file('IMG_1.HEIC'), file('clip.mov')])
    expect(result.named.map((entry) => entry.contentType)).toEqual([
      'image/heic',
      'video/quicktime',
    ])
  })
})

describe('toSetId', () => {
  it('turns what somebody types into a folder name', () => {
    expect(toSetId('My Cat LoRA')).toBe('my-cat-lora')
    expect(toSetId('café v2')).toBe('cafe-v2')
  })

  it('produces something the endpoint accepts, or nothing at all', () => {
    for (const typed of ['My Cat LoRA', '../..', '...', 'a.b', '   ', '写真', 'x'.repeat(200)]) {
      const id = toSetId(typed)
      expect(id === '' || isSetId(id), `for "${typed}"`).toBe(true)
    }
  })

  it('leaves a name already in the right shape untouched', () => {
    expect(toSetId('my-cat-lora')).toBe('my-cat-lora')
    expect(toSetId('lora_2')).toBe('lora_2')
  })
})
