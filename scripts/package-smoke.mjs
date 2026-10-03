import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const installDirectory = mkdtempSync(join(tmpdir(), "opencode-tiered-dispatch-pack-"))

try {
  const pack = run("npm", ["pack", "--silent"], root)
  const tarball = pack.trim().split("\n").at(-1)
  if (!tarball) throw new Error("npm pack did not return a tarball name")

  run("npm", ["install", "--ignore-scripts", "--prefix", installDirectory, join(root, tarball)], root)
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
  rmSync(installDirectory, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`)
  return result.stdout
}
