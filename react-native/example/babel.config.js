module.exports = function (api) {
  api.cache.using(() => `${process.env.NODE_ENV}:${process.env.KEYFRAMER_INSPECTOR}`)
  // Development, or a preview build for testers (KEYFRAMER_INSPECTOR=1, set in an EAS build profile).
  const inspect = process.env.NODE_ENV !== 'production' || process.env.KEYFRAMER_INSPECTOR === '1'
  return {
    presets: ['babel-preset-expo'],
    // The inspector tags every Reanimated call. babel-preset-expo adds react-native-worklets/plugin
    // itself, after these, which is the order the inspector needs.
    plugins: inspect ? ['@keyframerdev/inspector/babel'] : [],
  }
}
