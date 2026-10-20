# Motion Vitals symbol fixtures

Small symbol files and what `keyframer-vitals symbols upload --dry-run` makes of them: the manifest and
chunks of `src/vitals.ts` (`VitalsSymbolManifest`, `VitalsSymbolChunk`, `VitalsR8Chunk`,
`VitalsSitesChunk`). The Rust crate (`inspector/symbols`, `cargo test`) and the CLI
(`inspector/packages/vitals-cli`, `bun run test`) both check their output against `expected/`
byte for byte. The Android Gradle plugin writes r8 chunks itself: its tests should match
`expected/r8` and `expected/r8-sharded`.

## Layout

```
inputs/                      what the CLI reads
expected/<case>/<kind>/<debugId>/manifest.json, 0000.json, …
src/                         the programs the binaries were built from
```

Every manifest here has `createdAt` `1970-01-01T00:00:00.000Z` and `cli` `{ name: "keyframer-vitals",
version: "0.0.0-fixture" }`; the CLI's test sets `SOURCE_DATE_EPOCH=0` and compares manifests with
`cli.version` replaced. Chunks are compact JSON, uploaded as they are (gzipped).

| Case | Input | CLI | Shows |
| --- | --- | --- | --- |
| `dsym-tiny` | `inputs/Tiny.dSYM` (fat: x86_64 + arm64, C and C++) | `--dsym inputs/Tiny.dSYM` | one manifest per architecture keyed by its LC_UUID, offsets from `__TEXT`, C++ demangled, an inlined call's lines inside its caller |
| `dsym-card` | `inputs/Card.dSYM` (arm64, Swift) | `--dsym inputs/Card.dSYM --no-swift-demangle` | Swift names kept mangled, `mangled: ["swift"]` in the manifest (on macOS the CLI demangles them with `xcrun swift-demangle --compact --simplified` and the flag is absent) |
| `elf` | `inputs/app.android-arm64.symbols` (ELF, aarch64) | `--elf inputs/app.android-arm64.symbols` | GNU build id as debug id, offsets from the first PT_LOAD (0x200000) |
| `r8` | `inputs/mapping.txt` | `--mapping inputs/mapping.txt --app-version 1.4.0 --build 212` | classes by obfuscated name, line ranges, inline stacks, source files |
| `r8-sharded` | the same | the same plus `--chunk-budget 600` | how classes are cut into chunks |
| `rn-sites` | `inputs/sites-1.4.0+212.json` | `--rn-sites inputs/sites-1.4.0+212.json` | hashed sites by hash, debug id `<version>+<build>` |

## How chunks are cut

The same rule everywhere, so another writer (the Gradle plugin) produces the same files: entries are
added in sorted order (offsets for macho/elf; obfuscated class names and site hashes by code point) and
a new chunk starts before an entry that would make the chunk's compact JSON longer than the budget
(512 KiB by default, which keeps a chunk under about 256 KB gzipped; the CLI refuses a chunk over
256 KiB gzipped). For keyed chunks the length counted is the JSON `{"classes":{` + entries joined by
commas + `}}` (`"sites"` for rn-sites); a single entry larger than the budget gets a chunk of its own.
Native chunks count an estimate and never cut between two entries at the same offset.

## How the inputs were made

On macOS 26 with Xcode 26 (Apple clang 21, Swift 6.4), Homebrew LLVM 21 and the lld that ships with
rustup (`rust-lld`), in a scratch folder `$S` holding a copy of `src/`:

```sh
# Tiny.dSYM: fat C + C++
for a in arm64 x86_64; do
  clang   -arch $a -g -O1 -ffile-prefix-map=$S=/src/app -c tiny.c   -o tiny-$a.o
  clang++ -arch $a -g -O1 -ffile-prefix-map=$S=/src/app -c anim.cpp -o anim-$a.o
  clang++ -arch $a tiny-$a.o anim-$a.o -o Tiny-$a
done
lipo -create Tiny-arm64 Tiny-x86_64 -output Tiny && dsymutil Tiny -o Tiny.dSYM

# Card.dSYM: Swift
swiftc -g -O -file-prefix-map $S=/src/app -c Card.swift -o Card.o -module-name Card
swiftc Card.o -o Card && dsymutil Card -o Card.dSYM

# app.android-arm64.symbols: freestanding C, linked for aarch64 Linux with a GNU build id
/opt/homebrew/opt/llvm/bin/clang --target=aarch64-linux-gnu -ffreestanding -fno-stack-protector \
  -g -O1 -ffile-prefix-map=$S=/src/app -c elf.c -o elf.o
~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld \
  -flavor gnu -nostdlib --build-id=sha1 -e _start -o app.android-arm64.symbols elf.o
```

Only each dSYM's `Info.plist` and DWARF file were kept (not `Relocations/`). `mapping.txt` and the
sites file are written by hand in the formats R8 8.x and the React Native Babel plugin produce. Rebuilt
binaries get new UUIDs and build ids, so after rebuilding one, regenerate `expected/` with
`UPDATE_GOLDEN=1 cargo test --test golden` in `inspector/symbols` and check the diff.
