import { useFocusEffect } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

/**
 * The inspector's Replay re-mounts the screen on top, so its entrances run again without leaving it.
 * Screens underneath stay as they are, and do not replay later when the app goes back to them: a
 * replay counts for a screen only if it was focused when the replay came.
 */
export type Replays = { replay(): void; subscribe(fn: () => void): () => void }

export function createReplays(): Replays {
  const listeners = new Set<() => void>()
  return {
    replay: () => {
      for (const fn of listeners) fn()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

export const ReplayContext = createContext<Replays>(createReplays())

/** A key for the screen's root: it changes when the inspector replays while this screen is focused. */
export function useReplayKey(): number {
  const replays = useContext(ReplayContext)
  // Focus from navigation's own events, not a render: they arrive even while a screen is frozen.
  const focused = useRef(false)
  useFocusEffect(
    useCallback(() => {
      focused.current = true
      return () => {
        focused.current = false
      }
    }, []),
  )
  const [key, setKey] = useState(0)
  useEffect(() => replays.subscribe(() => focused.current && setKey((k) => k + 1)), [replays])
  return key
}
