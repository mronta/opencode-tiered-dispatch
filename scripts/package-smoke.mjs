import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name
const installDirectory = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-pack-"))
let tarballPath

try {
  const pack = run("npm", ["pack", "--silent"], root)
  const tarball = pack.trim().split("\n").at(-1)
  if (!tarball) throw new Error("npm pack did not return a tarball name")
  tarballPath = join(root, tarball)

  const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], root)).at(0)
  const files = dryRun?.files?.map((file) => file.path) ?? []
  for (const required of ["index.js", "dist/index.js", "dist/index.d.ts", "tiers.json"]) {
    if (!files.includes(required)) throw new Error(`packed package is missing ${required}`)
  }
  const stale = files.filter((file) => /dist\/(dispatch|permissions|result)\./.test(file))
  if (stale.length > 0) throw new Error(`packed package contains removed implementation files: ${stale.join(", ")}`)

  run("npm", ["install", "--ignore-scripts", "--prefix", installDirectory, join(root, tarball)], root)
  const packageDirectory = join(installDirectory, "node_modules", ...packageName.split("/"))
  verifyPackagedSourceMaps(packageDirectory)
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import plugin from "opencode-tiered-dispatch"; if (plugin.id !== "tiered-dispatch" || typeof plugin.setup !== "function") throw new Error("invalid plugin export")',
    ],
    installDirectory,
  )
  console.log(`package smoke passed: ${tarball}`)
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true })
  rmSync(installDirectory, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  return result.stdout
}

function verifyPackagedSourceMaps(packageDirectory) {
  const mapFiles = collectFiles(packageDirectory).filter((file) => file.endsWith(".map"))
  if (mapFiles.length === 0) throw new Error("packed package contains no source maps")

  const buildConfig = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8"))
  const declarationMapsExpected = buildConfig.compilerOptions?.declarationMap !== false
  if (declarationMapsExpected && !mapFiles.some((file) => file.endsWith(".d.ts.map"))) {
    throw new Error("packed package is missing declaration maps")
  }

  for (const mapFile of mapFiles) {
    const mapPath = join(packageDirectory, mapFile)
    const map = JSON.parse(readFileSync(mapPath, "utf8"))
    if (!Array.isArray(map.sources)) throw new Error(`invalid source map: ${mapFile}`)

    for (const [index, source] of map.sources.entries()) {
      const inlineSource = Array.isArray(map.sourcesContent) ? map.sourcesContent[index] : undefined
      if (typeof inlineSource === "string") continue
      if (typeof source !== "string") throw new Error(`invalid source map target: ${mapFile}`)

      const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : ""
      const target = resolve(dirname(mapPath), sourceRoot, source)
      if (!isInside(packageDirectory, target) || !existsSync(target)) {
        throw new Error(`packed source map target is missing: ${mapFile} -> ${source}`)
      }
    }
  }
}

function collectFiles(directory, prefix = "") {
  const files = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(directory, path))
    else files.push(path)
  }
  return files
}

function isInside(directory, target) {
  const path = relative(directory, target)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
}
