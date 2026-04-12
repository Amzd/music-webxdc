import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { buildXDC, eruda, mockWebxdc } from '@webxdc/vite-plugins'
import { defineConfig } from 'vite'

function svgToPng(svgPath, pngName) {
    return {
        name: 'svg-to-png',
        closeBundle() {
            try {
                const svg = readFileSync(svgPath)
                const resvg = new Resvg(svg, {
                    fitTo: { mode: 'width', value: 512 },
                })
                const png = resvg.render().asPng()
                writeFileSync(resolve('dist', pngName), png)
            } catch (err) {
                throw new Error(
                    `svg-to-png: failed to convert "${svgPath}" to "${pngName}": ${err.message}`
                )
            }
        },
    }
}

export default defineConfig({
    plugins: [
        buildXDC(),
        eruda(),
        mockWebxdc(),
        svgToPng('src/icon.svg', 'icon.png'),
    ],
    build: {
        rollupOptions: {
            // audio@2.2.0/dist/audio.js has a dynamic import("audio-buffer") as
            // a Node.js fallback. In the browser AudioBuffer is a global so the
            // import never executes, but Rollup can't resolve it at build time.
            // Externalising it lets the try/catch in the library handle it safely.
            external: ['audio-buffer'],
        },
    },
})
