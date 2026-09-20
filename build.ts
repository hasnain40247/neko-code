#!/usr/bin/env bun
/**
 * Build neko as a standalone binary.
 *
 * Uses OpenTUI's Solid transform plugin at build time so JSX in packages/view/tui
 * gets lowered before bundling — the same plugin preload.ts registers at runtime.
 */

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"

const TARGET = process.env.BUILD_TARGET ?? "bun-darwin-arm64"
const OUTFILE = process.env.BUILD_OUTFILE ?? "./dist/neko"

console.log(`[build] target=${TARGET} outfile=${OUTFILE}`)

const gifBase64Plugin: BunPlugin = {
  name: "gif-base64",
  setup(build) {
    build.onLoad({ filter: /\.gif$/ }, async ({ path }) => {
      const bytes = await Bun.file(path).bytes()
      const base64 = Buffer.from(bytes).toString("base64")
      return {
        contents: `export default "data:image/gif;base64,${base64}"`,
        loader: "js",
      }
    })
  },
}

const result = await Bun.build({
  entrypoints: ["packages/controller/cli/src/index.ts"],
  compile: {
    target: TARGET as any,
    outfile: OUTFILE,
  },
  plugins: [createSolidTransformPlugin(), gifBase64Plugin],
})

if (!result.success) {
  console.error("[build] failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`[build] wrote ${OUTFILE}`)
