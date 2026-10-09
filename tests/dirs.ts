// The directories of a stand-in filesystem that is only a map of absolute file paths to text: what a directory
// holds, as a listing names it. Shared by the kit world, the harness and the port-level tests.

// The entries of `dir` as `{ name, kind }` (a path beneath a subdirectory makes that subdirectory an entry), or
// undefined when no file is under `dir`, which is when it is not there.
export function dirEntries(files: Readonly<Record<string, string>>, dir: string): { name: string; kind: 'file' | 'dir' }[] | undefined {
  const entries = new Map<string, 'file' | 'dir'>()
  for (const path of Object.keys(files)) {
    if (!path.startsWith(`${dir}/`)) continue
    const rest = path.slice(dir.length + 1)
    const slash = rest.indexOf('/')
    entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
  }
  return entries.size === 0 ? undefined : [...entries].map(([name, kind]) => ({ name, kind }))
}
