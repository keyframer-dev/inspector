// Runs the CLI from source, without building dist/: `bun run cli symbols upload --dsym …`.
import { main } from '../src/cli'

main(process.argv.slice(2)).then((code) => process.exit(code))
