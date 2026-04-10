import type { Webxdc } from '@webxdc/types'

declare global {
    interface Window {
        webxdc: Webxdc<unknown>
    }
}
