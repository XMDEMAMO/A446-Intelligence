import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceCode = fs.readFileSync(path.resolve(__dirname, '../src/lan-token.ts'), 'utf8')
const transpiled = ts.transpileModule(sourceCode, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { selectLanAccessToken } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
)

test('a newly supplied LAN pairing token replaces a stale session token', () => {
  assert.deepEqual(selectLanAccessToken('?lanToken=new-token', 'stale-token'), {
    token: 'new-token',
    source: 'query',
  })
})

test('the stored LAN token is reused when the URL does not supply one', () => {
  assert.deepEqual(selectLanAccessToken('?view=workflow', ' session-token '), {
    token: 'session-token',
    source: 'session',
  })
  assert.deepEqual(selectLanAccessToken('', ''), { token: '', source: 'none' })
})
