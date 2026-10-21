import { startVitals, VitalsRoot } from '@keyframerdev/vitals'
import Constants from 'expo-constants'
import { Stack, useNavigationContainerRef } from 'expo-router'
import { useEffect } from 'react'

export default function Layout() {
  const navigationRef = useNavigationContainerRef()
  useEffect(() => {
    if (__DEV__) {
      const { connectDevTools } = require('@keyframerdev/inspector/devtools')
      connectDevTools({ app: 'Done' })
    }
    startVitals({ key: 'kfp_live_DONE0000000000000000000a', appVersion: Constants.expoConfig?.version ?? '0', navigationRef })
  }, [navigationRef])
  return (
    <VitalsRoot>
      <Stack />
    </VitalsRoot>
  )
}
