// Runs the wizard from source, without building dist/: `bun run wizard --dry-run`, or `bun src/main.ts --root ../app`.
import { main } from './cli'

main(process.argv.slice(2)).then((code) => process.exit(code))
