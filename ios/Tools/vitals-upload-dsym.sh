#!/bin/sh
# Motion Vitals: uploads this build's dSYMs so the dashboard names `native` call sites (file, line,
# function) instead of code offsets. Add it as the last Run Script build phase of the app target:
#
#   "${BUILD_DIR%/Build/*}/SourcePackages/checkouts/inspector/ios/Tools/vitals-upload-dsym.sh"
#
# (or a copy of this file in your repository), with these Input Files so Xcode runs it after the dSYM
# exists:
#
#   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}
#
# The project's CI upload key (kft_…, from the Motion Vitals dashboard, never the kfp_ key the app
# ships) comes from KEYFRAMER_VITALS_UPLOAD_KEY: set it in CI, or in a build setting of the same
# name. Without it, or for builds without a dSYM (Debug with plain DWARF), the script says so and
# succeeds, so local builds never fail. KEYFRAMER_VITALS_SYMBOLS=off skips it; =required makes a
# failed upload fail the build (for release CI).
#
# Needs Node (npx). Archives upload the same way; for builds with dSYMs from elsewhere (Bitcode-era
# downloads, Fastlane), run the CLI directly:
#   npx -y @keyframerdev/vitals-cli symbols upload --dsym path/to/App.dSYM
set -u

mode="${KEYFRAMER_VITALS_SYMBOLS:-auto}"
[ "$mode" = "off" ] && { echo "Motion Vitals: symbol upload off (KEYFRAMER_VITALS_SYMBOLS=off)"; exit 0; }

fail() {
  if [ "$mode" = "required" ]; then echo "error: Motion Vitals: $1"; exit 1; fi
  echo "warning: Motion Vitals: $1"
  exit 0
}

if [ "${DEBUG_INFORMATION_FORMAT:-}" != "dwarf-with-dsym" ]; then
  echo "Motion Vitals: no dSYM in this build (DEBUG_INFORMATION_FORMAT=${DEBUG_INFORMATION_FORMAT:-unset}), nothing to upload"
  exit 0
fi
[ -n "${KEYFRAMER_VITALS_UPLOAD_KEY:-}" ] || fail "KEYFRAMER_VITALS_UPLOAD_KEY is not set: dSYMs not uploaded, native call sites will show as offsets"

dsyms="${DWARF_DSYM_FOLDER_PATH:-}"
[ -d "$dsyms" ] || fail "no dSYM folder at '${dsyms}'"

# Xcode's Run Script environment has a short PATH: add the usual Node locations.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.bun/bin"
command -v npx >/dev/null 2>&1 || fail "npx not found (install Node), dSYMs not uploaded"

# Every .dSYM of the build: the app's, its frameworks' and its extensions'.
found=0
args=""
for d in "$dsyms"/*.dSYM; do
  [ -d "$d" ] || continue
  found=1
  args="$args --dsym \"$d\""
done
[ "$found" = 1 ] || fail "no .dSYM bundles in ${dsyms}"

echo "Motion Vitals: uploading dSYMs from ${dsyms}"
eval "npx -y @keyframerdev/vitals-cli symbols upload $args" || fail "the dSYM upload failed (see above)"
