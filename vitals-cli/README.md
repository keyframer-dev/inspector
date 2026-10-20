# @keyframerdev/vitals-cli

`keyframer-vitals`: symbol uploads for [Motion Vitals](https://keyframer.dev), so slow frames from
release builds are shown with function names, files and lines. Node 18 or later; no native modules
(the symbol reader is WebAssembly, inside the package).

```sh
npx @keyframerdev/vitals-cli symbols upload --dsym path/to/App.app.dSYM          # iOS
npx @keyframerdev/vitals-cli symbols upload --elf build/debug-info                # Flutter Android (--split-debug-info)
npx @keyframerdev/vitals-cli symbols upload --dsym build/debug-info/app.ios-arm64.symbols   # Flutter iOS (Mach-O)
npx @keyframerdev/vitals-cli symbols upload --mapping app/build/outputs/mapping/release/mapping.txt \
  --app-version 1.4.0 --build 212                                                 # Android R8
npx @keyframerdev/vitals-cli symbols upload --rn-sites .keyframer/sites-1.4.0+212.json   # React Native hashSites
npx @keyframerdev/vitals-cli symbols inspect path/to/App.app.dSYM                 # debug ids and architectures
```

The upload key is the project's CI key (`kft_…`), in `--key` or `KEYFRAMER_VITALS_UPLOAD_KEY`.
`--dry-run --out <dir>` writes what would be uploaded instead. `keyframer-vitals --help` lists every
option.

Symbol files are read on your machine: functions and line tables from DWARF (dSYMs, fat binaries
per architecture, ELF), classes and line ranges from R8 mappings, then split into small JSON chunks.
Only those chunks are sent. Swift names are demangled with `xcrun swift-demangle` when it is
available (macOS with Xcode); elsewhere they are uploaded mangled.

## Development

```sh
bun run test            # golden fixtures in ../protocol/fixtures/vitals/symbols
bun run build           # dist/cli.js
bun run build:wasm      # after changing ../symbols (Rust); writes src/symbolsWasm/
```

MIT
