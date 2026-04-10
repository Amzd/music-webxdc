import Dexie from 'dexie'

/** Chunk size used when splitting tracks for P2P transfer. */
export const CHUNK_SIZE = 1024 * 1024

/** @type {any} */
export const db = new Dexie('music')
db.version(1).stores({ files: 'id', chunks: '[file+id]' })

/**
 * Returns download progress for a file as a 0–100 integer.
 *
 * @param {import('./validate-payload').FileMeta} file
 *
 * @returns {number}
 */
export function getDownloadProgress(file) {
    const total = Math.ceil(file.size / CHUNK_SIZE)
    const done = total - file.pending.length
    return Math.floor((done / total) * 100)
}
