// Dev-only: writes hooks/schemas.gen.ts (built-in tool input schemas, committed) and, when an MCP
// declaration file is present, hooks/schemas.mcp.gen.json (git-ignored; the hooks module reads it with
// $.fs.read, a missing file being normal), from the engine's .d.ts files. With --check it writes nothing,
// and exits 1 when the committed hooks/schemas.gen.ts is missing or was generated on another engine
// version. A committed file of this engine version that differs from what it would write passes with a
// warning: the laid declarations are the loading session's tools, and sessions of one build differ (a
// feature-gated parameter such as Agent's run_in_background, or a description such as Agent's effort
// note on forks).
//
//   bun scripts/gen-schemas.ts [--tools <file.d.ts>] [--mcp <file.d.ts>] [--check]
//
// --tools defaults to the engine-laid .claude-plugin/types/claude-code-tools/index.d.ts. Before the mod
// has ever loaded, pass the plugin-authoring skill's types/claude-code.d.ts, whose BuiltinToolInputs
// block is the same declaration. --mcp defaults to the laid .claude-plugin/types/claude-code-mcp/index.d.ts
// and is skipped when absent.
//
// Each tool's TypeScript input type becomes a JSON Schema: property JSDoc becomes `description`, an
// optional property is left out of `required`, string-literal unions become `enum`, and object types
// are closed (`additionalProperties: false`). TypeScript cannot express min/max, patterns or formats,
// so those are absent. Any other type construct stops the run with its path.
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

type Schema = Record<string, unknown>

const ROOT = join(import.meta.dir, '..')
const LAID = join(ROOT, '.claude-plugin', 'types')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// The JSDoc comment's raw text: tag parsing would cut a description at its first `@` ("bare @-mention").
function jsDoc(node: ts.Node): string | undefined {
  const texts = ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map(doc =>
      doc
        .getText()
        .replace(/^\/\*\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim(),
    )
    .filter(t => t.length > 0)
  return texts.length > 0 ? texts.join('\n') : undefined
}

function propName(name: ts.PropertyName, path: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  throw new Error(`unsupported property name at ${path}`)
}

function literal(node: ts.LiteralTypeNode, path: string): Schema {
  const lit = node.literal
  if (ts.isStringLiteral(lit)) return { type: 'string', const: lit.text }
  if (ts.isNumericLiteral(lit)) return { type: 'number', const: Number(lit.text) }
  if (lit.kind === ts.SyntaxKind.TrueKeyword) return { type: 'boolean', const: true }
  if (lit.kind === ts.SyntaxKind.FalseKeyword) return { type: 'boolean', const: false }
  if (lit.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' }
  throw new Error(`unsupported literal ${ts.SyntaxKind[lit.kind]} at ${path}`)
}

function objectSchema(members: ts.NodeArray<ts.TypeElement>, path: string): Schema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  let additional: Schema | false = false
  for (const m of members) {
    if (ts.isIndexSignatureDeclaration(m)) {
      additional = toSchema(m.type, `${path}[key]`)
      continue
    }
    if (!ts.isPropertySignature(m) || !m.type) throw new Error(`unsupported member at ${path}`)
    const name = propName(m.name, path)
    const description = jsDoc(m)
    properties[name] = { ...toSchema(m.type, `${path}.${name}`), ...(description ? { description } : {}) }
    if (!m.questionToken) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: additional,
  }
}

function toSchema(node: ts.TypeNode, path: string): Schema {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: 'string' }
    case ts.SyntaxKind.NumberKeyword:
      return { type: 'number' }
    case ts.SyntaxKind.BooleanKeyword:
      return { type: 'boolean' }
    case ts.SyntaxKind.NullKeyword:
      return { type: 'null' }
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword:
      return {}
  }
  if (ts.isParenthesizedTypeNode(node)) return toSchema(node.type, path)
  if (ts.isLiteralTypeNode(node)) return literal(node, path)
  if (ts.isTypeLiteralNode(node)) return objectSchema(node.members, path)
  if (ts.isArrayTypeNode(node)) return { type: 'array', items: toSchema(node.elementType, `${path}[]`) }
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map(t => toSchema(t, path))
    const strings = members.every(m => m.type === 'string' && 'const' in m && Object.keys(m).length === 2)
    return strings ? { type: 'string', enum: members.map(m => m.const) } : { anyOf: members }
  }
  if (ts.isIntersectionTypeNode(node)) {
    const members = node.types.map(t => toSchema(t, path)).filter(m => Object.keys(m).length > 0)
    return members.length === 0 ? {} : members.length === 1 ? members[0]! : { allOf: members }
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText()
    const [a, b] = node.typeArguments ?? []
    if (name === 'Array' && a && !b) return { type: 'array', items: toSchema(a, `${path}[]`) }
    if (name === 'Record' && a?.kind === ts.SyntaxKind.StringKeyword && b) {
      return { type: 'object', additionalProperties: toSchema(b, `${path}[key]`) }
    }
  }
  throw new Error(`unsupported type ${ts.SyntaxKind[node.kind]} at ${path}: ${node.getText()}`)
}

// The members of every `interface <name>` under `declare module 'claude-code'`, merged in order.
function extract(file: string, iface: string): Record<string, Schema> {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: Record<string, Schema> = {}
  for (const stmt of src.statements) {
    if (!ts.isModuleDeclaration(stmt) || stmt.name.getText() !== "'claude-code'" || !stmt.body) continue
    if (!ts.isModuleBlock(stmt.body)) continue
    for (const decl of stmt.body.statements) {
      if (!ts.isInterfaceDeclaration(decl) || decl.name.text !== iface) continue
      for (const m of decl.members) {
        if (!ts.isPropertySignature(m) || !m.type || !ts.isTypeLiteralNode(m.type)) {
          throw new Error(`unsupported ${iface} member in ${basename(file)}`)
        }
        const tool = propName(m.name, iface)
        out[tool] = objectSchema(m.type.members, tool)
      }
    }
  }
  return out
}

// The engine version from the "// Written by Claude Code <version>." first line of the file, or of the
// API declaration laid beside it.
function engineVersion(file: string): string {
  const read = (f: string) => /^\/\/ Written by Claude Code (\S+?)\.?$/m.exec(readFileSync(f, 'utf8').split('\n', 1)[0] ?? '')?.[1]
  const sibling = join(dirname(file), '..', 'claude-code', 'index.d.ts')
  const v = read(file) ?? (existsSync(sibling) ? read(sibling) : undefined)
  if (!v) throw new Error(`no "Written by Claude Code <version>" header in ${file} or ${sibling}`)
  return v
}

const byName = (schemas: Record<string, Schema>) => Object.fromEntries(Object.keys(schemas).sort().map(n => [n, schemas[n]]))
const CHECK = process.argv.includes('--check')

// hooks/schemas.gen.ts. Its tableHash covers every tool's whole schema, descriptions included.
function emitBuiltins(from: string, schemas: Record<string, Schema>, version: string) {
  const out = join(ROOT, 'hooks', 'schemas.gen.ts')
  const table = JSON.stringify(byName(schemas), null, 2)
  const names = Object.keys(schemas).length
  const tableHash = createHash('sha256').update(table).digest('hex').slice(0, 16)
  const text =
    `// Generated by scripts/gen-schemas.ts from ${from}; do not edit. Regenerate after a Claude Code upgrade.\n` +
    `export const STAMP = { engineVersion: ${JSON.stringify(version)}, tableHash: ${JSON.stringify(tableHash)}, tools: ${names} }\n\n` +
    `export const SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = ${table}\n`
  if (CHECK) {
    const committed = existsSync(out) ? readFileSync(out, 'utf8') : undefined
    if (committed === text) {
      console.log(`${basename(out)}: up to date (${names} tools, engine ${version}, tableHash ${tableHash})`)
      return
    }
    // The engine lays the schemas of the session that loaded the mod, and one build's sessions differ in
    // feature-gated parameters and descriptions; only a schema table from another build is stale.
    const stamped = committed === undefined ? undefined : /engineVersion: "([^"]*)"/.exec(committed)?.[1]
    if (stamped === version) {
      console.warn(`warning: ${basename(out)} differs from ${from} as this session laid it (engine ${version}, tableHash ${tableHash}); sessions of one build lay different tool schemas, so this passes. Regenerate with bun scripts/gen-schemas.ts to take this session's`)
      return
    }
    console.error(`${basename(out)} is stale against ${from} (engine ${version}, tableHash ${tableHash}): run bun scripts/gen-schemas.ts`)
    process.exit(1)
  }
  writeFileSync(out, text)
  console.log(`${basename(out)}: ${names} tools, engine ${version}, tableHash ${tableHash}`)
}

const tools = arg('--tools') ?? join(LAID, 'claude-code-tools', 'index.d.ts')
if (!existsSync(tools)) {
  throw new Error(`${tools} is absent: pass --tools <plugin-authoring types/claude-code.d.ts> until the engine has laid .claude-plugin/types/`)
}
emitBuiltins(`${basename(tools)} (BuiltinToolInputs)`, extract(tools, 'BuiltinToolInputs'), engineVersion(tools))

// The MCP table is one JSON object, tool name to schema. It is git-ignored and local, so --check skips it.
const mcp = arg('--mcp') ?? join(LAID, 'claude-code-mcp', 'index.d.ts')
if (!CHECK && existsSync(mcp)) {
  const out = join(ROOT, 'hooks', 'schemas.mcp.gen.json')
  const schemas = extract(mcp, 'McpToolInputs')
  writeFileSync(out, `${JSON.stringify(byName(schemas), null, 2)}\n`)
  console.log(`${basename(out)}: ${Object.keys(schemas).length} tools`)
} else if (!CHECK) {
  console.log(`${mcp} is absent: no MCP schemas generated`)
}
