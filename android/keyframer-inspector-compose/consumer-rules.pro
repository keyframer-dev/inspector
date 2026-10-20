# keyframer-inspector finds this module by name when it starts (Keyframer.start), so a shrunk build
# with enableInRelease keeps it.
-keep class dev.keyframer.inspector.compose.KeyframerCompose { public static void install(); }
