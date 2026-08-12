/**
 * The images the Image tab has generated, newest first.
 *
 * Kept outside the panel for the same reason the Idea tab's state is (see
 * `useIdeaStore`): switching tabs unmounts the panel, and a strip of results
 * that disappears the moment you glance at the timeline is barely worth
 * showing. Only ids are held — the images themselves belong to the library, so
 * one deleted there simply stops appearing here.
 */
import { create } from 'zustand'

interface ImageResultsState {
  /** Asset ids, most recently generated first. */
  ids: string[]
  /** Records one generation's images. */
  add: (ids: string[]) => void
}

export const useImageResultsStore = create<ImageResultsState>((set) => ({
  ids: [],

  // A batch goes on top as a batch: newest generation above older ones, but the
  // images within it in the order the model returned them, so "the second one"
  // is still the second one down.
  add: (ids) => set((state) => ({ ids: [...ids, ...state.ids] })),
}))
