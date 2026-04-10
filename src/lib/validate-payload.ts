export type FileMeta = {
	id: string
	name: string
	lastModified: number
	size: number
	type: string
	/** Chunk indices still needed; empty when the file is fully available. */
	pending: Array<number>
}

export type Chunk = {
	file: string
	id: number
	blob: Blob
}

export type NowPlaying = {
	fileId: string
	isPlaying: boolean
	/** Audio position (seconds) at the moment the state was broadcast. */
	currentTime: number
	/** Wall-clock timestamp (ms) when this state was last updated. */
	actionTime: number
}

export type AppState = {
	files: Array<FileMeta>
	nowPlaying: NowPlaying | null
	playlistName?: string
}

export type PeerRequest = {
	time: number
	file: string
	chunk: number
	peer: string
}

export type PeerResponse = {
	file: string
	lastModified: number
	chunk: number
	data: Uint8Array
}

export type AppPayload = { request: PeerRequest } | { response: PeerResponse }

export function isRequest(
	payload: unknown
): payload is { request: PeerRequest } {
	if (typeof payload !== 'object' || payload === null) return false
	const p = payload as Record<string, unknown>
	return typeof p['request'] === 'object' && p['request'] !== null
}

export function isResponse(
	payload: unknown
): payload is { response: PeerResponse } {
	if (typeof payload !== 'object' || payload === null) return false
	const p = payload as Record<string, unknown>
	return typeof p['response'] === 'object' && p['response'] !== null
}
