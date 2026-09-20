import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { plugin } from "bun"

ensureSolidTransformPlugin()

// Embed GIF files as base64 data URLs so they work in compiled binaries
plugin({
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
})
