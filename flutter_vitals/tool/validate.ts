// Runs the shared report validator (inspector/protocol/vitals-validate.ts) over JSON files:
// `bun tool/validate.ts report.json…`. The golden test calls it when bun is installed.
import { readFileSync } from 'node:fs'
import { validateVitalsReport } from '../../protocol/vitals-validate'

let failed = false
for (const file of process.argv.slice(2)) {
  const result = validateVitalsReport(JSON.parse(readFileSync(file, 'utf8')))
  if (result.ok) console.log(`ok ${file}`)
  else {
    failed = true
    console.log(`invalid ${file}\n  ${result.errors.join('\n  ')}`)
  }
}
process.exit(failed ? 1 : 0)
