import { fire, press, registerScenario, waitForTestId } from '@keyframerdev/inspector/devtools'
import { router } from 'expo-router'
import { emitBus } from './bus'

/**
 * Reproducible interactions for the inspector: an agent (keyframer-inspect mcp, run_scenario) or the
 * panel runs one while recording, before and after a change, and compares. Each opens its screen and
 * presses the same buttons a person would, so the same handlers run.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open(path: '/welcome' | '/feed' | '/sheet' | '/hold' | '/glitches' | '/carousel' | '/props', ready: string, prop?: string | null) {
  router.navigate(path)
  await waitForTestId(ready, { prop })
  // Let the screen's entrance settle before the interaction starts.
  await wait(700)
}

if (__DEV__) {
  registerScenario('welcome: replay the entrance', async () => {
    await open('/welcome', 'welcome-replay')
    press('welcome-replay')
    await wait(1600)
  })
  registerScenario('sheet: open halfway, fully, then close', async () => {
    await open('/sheet', 'sheet-open-half')
    press('sheet-open-half')
    await wait(900)
    press('sheet-open-full')
    await wait(900)
    press('sheet-close')
    await wait(900)
  })
  registerScenario('feed: scroll with slow rows', async () => {
    await open('/feed', 'feed-slow', 'onValueChange')
    fire('feed-slow', 'onValueChange', true)
    await wait(300)
    emitBus('feed:scroll', 2400)
    await wait(1500)
    emitBus('feed:scroll', 0)
    await wait(1200)
    fire('feed-slow', 'onValueChange', false)
  })
  registerScenario('carousel: page through and back', async () => {
    await open('/carousel', 'carousel', null)
    for (const page of [1, 2, 3, 4, 0]) {
      emitBus('carousel:page', page)
      await wait(700)
    }
  })
  registerScenario('from props: css, layout animations and a js list', async () => {
    await open('/props', 'props-toggle')
    press('props-toggle')
    await wait(500)
    press('props-add')
    await wait(400)
    press('props-remove')
    await wait(500)
    emitBus('props:scroll', 400)
    await wait(800)
    press('props-toggle')
    await wait(500)
  })
  registerScenario('long press: hold to delete', async () => {
    await open('/hold', 'hold-delete', 'onPressIn')
    fire('hold-delete', 'onPressIn')
    await wait(1300)
    fire('hold-delete', 'onPressOut')
    await wait(400)
  })
  registerScenario('glitch lab: block the JS thread', async () => {
    await open('/glitches', 'glitch-block-js')
    press('glitch-block-js')
    await wait(500)
  })
  registerScenario('glitch lab: render storm', async () => {
    await open('/glitches', 'glitch-storm')
    press('glitch-storm')
    await wait(1800)
  })
  registerScenario('glitch lab: block the UI thread', async () => {
    await open('/glitches', 'glitch-block-ui')
    press('glitch-block-ui')
    await wait(500)
  })
  registerScenario('glitch lab: start an animation, then block JS', async () => {
    await open('/glitches', 'glitch-anim-then-block')
    press('glitch-anim-then-block')
    await wait(800)
  })
  registerScenario('glitch lab: log an error', async () => {
    await open('/glitches', 'glitch-error')
    press('glitch-error')
    await wait(200)
  })
}
