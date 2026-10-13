# The inspector reads class and method names from stack traces for call sites; keep app frames readable
# in builds that shrink. Debug builds are not minified, so this only matters with enableInRelease.
-keepattributes SourceFile,LineNumberTable
