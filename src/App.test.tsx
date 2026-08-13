/**
 * The order App draws things in, which is the only claim it makes on its own.
 *
 * The numbers on the tabs are a promise about what you do when — captions come
 * off audio that already exists — so the order they are drawn in and the order
 * they are numbered have to agree. The header makes a smaller promise: Settings
 * ends it, here and on the words page both. Nothing else in App is asserted
 * here; the panels themselves are tested next to their own components.
 */
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App step nav', () => {
  it('numbers the tabs in the order they are drawn', () => {
    render(<App />)

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim() ?? '')
      .filter((label) => /^\d+ · /.test(label))

    expect(labels).toEqual(['1 · Idea', '2 · Image', '3 · Video', '4 · Captions', '5 · Audio'])
  })
})

describe('App header', () => {
  it('draws Settings last', () => {
    render(<App />)

    // The first banner is the page header; the timeline draws a header of its
    // own further down. Links as well as buttons: the header holds both, and
    // Export — what used to sit to the right of Settings — is only one of them.
    const [header] = screen.getAllByRole('banner')
    const controls = [...(header?.querySelectorAll('button, a') ?? [])]

    expect(controls.at(-1)).toHaveTextContent('Settings')
  })
})
