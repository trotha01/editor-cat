/**
 * The step nav, which is the only claim App makes about the order of the work.
 *
 * The numbers on the tabs are a promise about what you do when — captions come
 * off audio that already exists — so the order they are drawn in and the order
 * they are numbered have to agree. Nothing else in App is asserted here; the
 * panels themselves are tested next to their own components.
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
