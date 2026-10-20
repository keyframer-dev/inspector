# Motion Vitals needs no keep rules: it reads no app classes by reflection. Call sites in minified
# builds are R8 names, resolved on the server from the mapping the dev.keyframer.vitals Gradle plugin
# uploads; keeping line numbers makes them exact:
#   -keepattributes SourceFile,LineNumberTable
