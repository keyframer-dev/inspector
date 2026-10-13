/**
 * Shares a recording as a file through the system share sheet (AirDrop, Slack, mail), with Expo's
 * file system and sharing modules. Both ship in Expo Go.
 *
 *   npx expo install expo-file-system expo-sharing
 *
 *   import { shareRecording } from '@keyframerdev/inspector/expo-share'
 *   configureRecorder({ share: shareRecording })
 */

import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import type { InspectorRecording } from '../../protocol/inspector'

export async function shareRecording(_recording: InspectorRecording, json: string, filename: string): Promise<void> {
  const file = new File(Paths.cache, filename)
  if (file.exists) file.delete()
  file.create()
  file.write(json)
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Share recording' })
}
