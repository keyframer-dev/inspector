module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Reanimated's plugin, last.
      'react-native-worklets/plugin',
    ],
  };
};
