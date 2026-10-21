module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV)
  const dev = process.env.NODE_ENV !== 'production'
  return {
    presets: ['babel-preset-expo'],
    plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), '@keyframerdev/vitals/babel'],
  }
}
