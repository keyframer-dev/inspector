import { createContext, useContext } from 'react'

/**
 * Bumped by the inspector's Replay (and the Replay buttons): a screen keys its root on it, so it
 * re-mounts and every entrance runs again, without leaving the screen.
 */
export const ReplayContext = createContext(0)
export const useReplayKey = () => useContext(ReplayContext)
