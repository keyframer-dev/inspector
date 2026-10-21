import { describe, expect, it } from 'vitest'
import { wrapWords } from './ioClack'

describe('wrapWords', () => {
  it('breaks between words, never inside one', () => {
    const line = "Start the app (or reload it: press r in Metro). The wizard listens on Metro's ports 8081-8090."
    const out = wrapWords(line, 85)
    expect(out).toBe("Start the app (or reload it: press r in Metro). The wizard listens on Metro's ports\n8081-8090.")
    expect(out.split('\n').every((l) => l.length <= 85)).toBe(true)
  })

  it('keeps a word longer than the width whole, keeps line breaks, and leaves short text alone', () => {
    expect(wrapWords('see https://keyframer.dev/inspector/docs/getting-started/react-native now', 30)).toBe('see\nhttps://keyframer.dev/inspector/docs/getting-started/react-native\nnow')
    expect(wrapWords('one\ntwo', 40)).toBe('one\ntwo')
    expect(wrapWords('a b c', 10)).toBe('a b c')
  })
})
