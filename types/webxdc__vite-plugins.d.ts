// TODO: Fix upstream
declare module '@webxdc/vite-plugins' {
    import type { PluginOption, UserConfig } from 'vite'
    export { default as secureContext } from '@vitejs/plugin-basic-ssl'

    export function buildXDC(opts?: {
        outDir?: string
        outFileName?: string
        filter?: (
            fileName: string,
            filePath: string,
            isDirectory: boolean
        ) => boolean
    }): PluginOption
    export function eruda(debug?: boolean): PluginOption
    export function mockWebxdc(path?: string): PluginOption
    export function legacy(opts?: { targets?: Array<string> }): PluginOption

    export function webxdcViteConfig(options?: UserConfig): UserConfig
    export function webxdcViteConfigNoLegacy(options?: UserConfig): UserConfig
}
