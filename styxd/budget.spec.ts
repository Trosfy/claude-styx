// The line budgets that keep the code lean: no hooks module over 400 lines (the generated tables aside), and
// styxd's production code (everything but specs and fixtures) within 1,320 lines in all (1,150 until prompt caching,
// signed thinking carry-over and the alias overlay's merge layer arrived; 1,235 until thinking blocks kept in
// their place, a byte-bounded thinking store, the idle limit for long caches and the second cache mark did; 1,300
// until a failed decoder ending its request, the cut token dropped before redaction and the escaped debug line did).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const lines = (path: string) => readFileSync(join(root, path), 'utf8').split('\n').length - 1
const files = (dir: string) => readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.gen.ts') && !f.includes('fixtures'))

test('no hooks module is over 400 lines', () => {
  const over = files('hooks').flatMap(f => (lines(`hooks/${f}`) > 400 ? [`${f}: ${lines(`hooks/${f}`)}`] : []))
  expect(over).toEqual([])
})

test("styxd's production code is within 1,320 lines", () => {
  expect(files('styxd').reduce((sum, f) => sum + lines(`styxd/${f}`), 0)).toBeLessThanOrEqual(1320)
})
