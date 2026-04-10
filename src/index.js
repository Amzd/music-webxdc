import { RealTime } from '@webxdc/realtime'
import { parseBlob } from 'music-metadata'

import { CHUNK_SIZE, db, getDownloadProgress } from './lib/storage'
import { isRequest, isResponse } from './lib/validate-payload'

init()

async function init() {
	const uploadBtn = /** @type {HTMLButtonElement} */ (
		document.getElementById('upload-btn')
	)
	const fileInput = /** @type {HTMLInputElement} */ (
		document.getElementById('file-input')
	)
	const playlist = /** @type {HTMLElement} */ (
		document.getElementById('playlist')
	)
	const emptyMsg = /** @type {HTMLElement} */ (
		document.getElementById('empty-msg')
	)
	const nowPlaying = /** @type {HTMLElement} */ (
		document.getElementById('now-playing')
	)
	const playBtn = /** @type {HTMLButtonElement} */ (
		document.getElementById('play-btn')
	)
	const prevBtn = /** @type {HTMLButtonElement} */ (
		document.getElementById('prev-btn')
	)
	const nextBtn = /** @type {HTMLButtonElement} */ (
		document.getElementById('next-btn')
	)
	const progressBar = /** @type {HTMLInputElement} */ (
		document.getElementById('progress-bar')
	)
	const currentTimeEl = /** @type {HTMLElement} */ (
		document.getElementById('current-time')
	)
	const durationEl = /** @type {HTMLElement} */ (
		document.getElementById('duration')
	)

	/** @type {string[]} File IDs in playlist order. */
	let trackIds = []
	let currentIndex = -1
	let isPlaying = false
	/** @type {string | null} */
	let currentObjectUrl = null

	const audio = new Audio()

	/** Map from file ID to its playlist button element. */
	/** @type {Map<string, HTMLButtonElement>} */
	const trackElements = new Map()

	/**
	 * Cache of parsed metadata per file ID. Stores both the raw common tags and
	 * the pre-computed artwork data URLs.
	 *
	 * @type {Map<
	 * 	string,
	 * 	{
	 * 		common: import('music-metadata').ICommonTagsResult
	 * 		artwork: MediaImage[]
	 * 	}
	 * >}
	 */
	const metadataCache = new Map()
	// ── helpers ────────────────────────────────────────────────────────────

	/** @param {Blob} blob @returns {Promise<string>} */
	function blobToDataURL(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(/** @type {string} */ (reader.result))
			reader.onerror = reject
			reader.readAsDataURL(blob)
		})
	}

	const ICON_PLAY =
		'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
	const ICON_PAUSE =
		'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'

	/** @param {number} seconds */
	function formatTime(seconds) {
		if (!isFinite(seconds)) return '0:00'
		const m = Math.floor(seconds / 60)
		const s = Math.floor(seconds % 60)
		return `${m}:${s.toString().padStart(2, '0')}`
	}

	function updatePlayButton() {
		playBtn.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY
		playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
	}

	/** @param {number} index */
	function highlightTrack(index) {
		document
			.querySelectorAll('.playlist-item')
			.forEach((el, i) => el.classList.toggle('active', i === index))
	}

	/**
	 * Updates a playlist button to show current download progress.
	 *
	 * @param {HTMLButtonElement} el
	 * @param {import('./lib/validate-payload').FileMeta} file
	 */
	function updateTrackElement(el, file) {
		const pct = getDownloadProgress(file)
		if (pct < 100) {
			el.textContent = pct + '% \u2014 ' + file.name
			el.classList.add('downloading')
		} else {
			el.textContent = file.name
			el.classList.remove('downloading')
		}
	}

	/**
	 * Adds a new track button to the playlist.
	 *
	 * @param {import('./lib/validate-payload').FileMeta} file
	 */
	function addTrackToPlaylist(file) {
		emptyMsg.hidden = true
		const item = document.createElement('button')
		item.className = 'playlist-item'
		item.type = 'button'
		updateTrackElement(item, file)
		const fileId = file.id
		item.addEventListener('click', () => {
			if (item.classList.contains('downloading')) return
			const index = trackIds.indexOf(fileId)
			if (index !== -1) playTrack(index)
		})
		playlist.appendChild(item)
		trackIds.push(file.id)
		trackElements.set(file.id, item)
	}

	/**
	 * Syncs the playlist DOM with the given file list. Adds buttons for new
	 * tracks and updates progress indicators on existing ones.
	 *
	 * @param {import('./lib/validate-payload').FileMeta[]} files
	 */
	function refreshPlaylist(files) {
		for (const file of files) {
			if (file.size <= 0) continue
			const el = trackElements.get(file.id)
			if (!el) {
				addTrackToPlaylist(file)
			} else {
				updateTrackElement(el, file)
			}
		}
	}

	/** @param {number} index */
	async function playTrack(index) {
		if (index < 0 || index >= trackIds.length) return

		const id = trackIds[index]
		if (!id) return

		// Don't attempt playback if the track is still downloading.
		const el = trackElements.get(id)
		if (el?.classList.contains('downloading')) return

		/** @type {import('./lib/validate-payload').Chunk[]} */
		const chunks = await db.chunks.where('file').equals(id).sortBy('id')
		if (!chunks.length) return

		if (currentObjectUrl) {
			URL.revokeObjectURL(currentObjectUrl)
			currentObjectUrl = null
		}

		const blob = new Blob(
			chunks.map((c) => c.blob),
			{ type: 'audio/mpeg' }
		)

		const file = (realtime.getState()?.files ?? []).find((f) => f.id === id)

		// Start playback immediately — iOS requires audio.play() to be called
		// synchronously within the user-gesture handler. Any await before play()
		// causes iOS to reject the call and the media session never activates.
		currentObjectUrl = URL.createObjectURL(blob)
		audio.src = currentObjectUrl
		audio.play()

		currentIndex = index
		isPlaying = true
		nowPlaying.textContent = file?.name ?? id
		playBtn.disabled = false
		updatePlayButton()
		highlightTrack(index)

		// Update the media session metadata asynchronously after playback has
		// started. iOS will pick up metadata set while audio is already playing.
		if ('mediaSession' in navigator) {
			if (!metadataCache.has(id)) {
				const { common } = await parseBlob(blob)
				const artwork = await Promise.all(
					(common?.picture ?? []).map(async (pic) => {
						const dataUrl = await blobToDataURL(
							new Blob([pic.data], { type: pic.format })
						)
						return /** @type {MediaImage} */ ({
							src: dataUrl,
							type: pic.format,
						})
					})
				)
				metadataCache.set(id, { common, artwork })
			}
			const { common, artwork } =
				/** @type {NonNullable<ReturnType<typeof metadataCache.get>>} */ (
					metadataCache.get(id)
				)
			navigator.mediaSession.metadata = new MediaMetadata({
				title: common?.title || (file?.name ?? id),
				artist: common?.artist || 'Unknown',
				album: common?.album || 'Unknown',
				artwork,
			})
		}
	}

	function togglePlay() {
		if (currentIndex === -1 && trackIds.length > 0) {
			playTrack(0)
			return
		}
		if (isPlaying) {
			audio.pause()
			isPlaying = false
		} else {
			audio.play()
			isPlaying = true
		}
		updatePlayButton()
	}

	// ── audio events ───────────────────────────────────────────────────────

	audio.addEventListener('ended', () => {
		const nextIndex = currentIndex + 1
		if (nextIndex < trackIds.length) {
			playTrack(nextIndex)
		} else {
			isPlaying = false
			updatePlayButton()
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'none'
			}
		}
	})

	audio.addEventListener('timeupdate', () => {
		if (!isFinite(audio.duration)) return
		const pct = (audio.currentTime / audio.duration) * 100
		progressBar.value = String(pct)
		currentTimeEl.textContent = formatTime(audio.currentTime)
	})

	audio.addEventListener('loadedmetadata', () => {
		durationEl.textContent = formatTime(audio.duration)
		progressBar.value = '0'
	})

	audio.addEventListener('play', () => {
		isPlaying = true
		updatePlayButton()
		if ('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = 'playing'
		}
	})

	audio.addEventListener('pause', () => {
		isPlaying = false
		updatePlayButton()
		if ('mediaSession' in navigator) {
			navigator.mediaSession.playbackState = 'paused'
		}
	})

	// ── Media Session action handlers ──────────────────────────────────────

	if ('audioSession' in navigator) {
		navigator.audioSession.type = 'play'
	}

	if ('mediaSession' in navigator) {
		navigator.mediaSession.setActionHandler('play', () => {
			audio.play()
		})
		navigator.mediaSession.setActionHandler('pause', () => {
			audio.pause()
		})
		navigator.mediaSession.setActionHandler('previoustrack', () => {
			if (currentIndex > 0) playTrack(currentIndex - 1)
		})
		navigator.mediaSession.setActionHandler('nexttrack', () => {
			if (currentIndex < trackIds.length - 1) playTrack(currentIndex + 1)
		})
	}

	// ── controls ───────────────────────────────────────────────────────────

	playBtn.addEventListener('click', togglePlay)

	prevBtn.addEventListener('click', () => {
		if (currentIndex > 0) playTrack(currentIndex - 1)
	})

	nextBtn.addEventListener('click', () => {
		if (currentIndex < trackIds.length - 1) playTrack(currentIndex + 1)
	})

	progressBar.addEventListener('input', () => {
		if (!isFinite(audio.duration)) return
		audio.currentTime = (Number(progressBar.value) / 100) * audio.duration
	})

	// ── upload ─────────────────────────────────────────────────────────────

	uploadBtn.addEventListener('click', () => fileInput.click())

	fileInput.addEventListener('change', async () => {
		if (!fileInput.files) return
		for (const file of Array.from(fileInput.files)) {
			if (!file.type.includes('audio') && !file.name.endsWith('.mp3')) continue
			await sendFile(file)
		}
		fileInput.value = ''
	})

	/**
	 * Stores a file as chunks in IndexedDB and advertises it to peers via
	 * realtime state so they can pull it chunk by chunk.
	 *
	 * @param {File} file
	 */
	async function sendFile(file) {
		const id = crypto.randomUUID()
		const lastModified = file.lastModified || Date.now()

		/** @satisfies {import('./lib/validate-payload').FileMeta} */
		const meta = {
			id,
			name: file.name,
			lastModified,
			size: file.size,
			type: file.type,
			pending: [],
		}

		await db.files.add(meta)

		const chunkCount = Math.ceil(file.size / CHUNK_SIZE)
		for (let i = 0; i < chunkCount; i++) {
			const start = i * CHUNK_SIZE
			const end = Math.min(start + CHUNK_SIZE, file.size)
			await db.chunks.add({ file: id, id: i, blob: file.slice(start, end) })
		}

		const currentFiles = realtime.getState()?.files ?? []
		realtime.setState({ files: [...currentFiles, meta] })
		refreshPlaylist([meta])
	}

	// ── realtime sync ──────────────────────────────────────────────────────

	// currentRequest is read/written only in syncChunks and handlePayload, both
	// of which run on the JS single-threaded event loop, so no locking is needed.
	/** @type {import('./lib/validate-payload').PeerRequest | null} */
	let currentRequest = null

	/** Milliseconds before a chunk request is considered timed-out. */
	const CHUNK_REQUEST_TIMEOUT_MS = 10_000
	/** Poll interval while a chunk request is in flight. */
	const SYNC_POLL_ACTIVE_MS = 10
	/** Poll interval while no chunk request is in flight. */
	const SYNC_POLL_IDLE_MS = 100

	/**
	 * Fisher-Yates shuffle - returns a new array.
	 *
	 * @template T
	 * @param {T[]} arr
	 *
	 * @returns {T[]}
	 */
	function shuffle(arr) {
		const a = arr.slice()
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			const tmp = a[i]
			a[i] = /** @type {T} */ (a[j])
			a[j] = /** @type {T} */ (tmp)
		}
		return a
	}

	/**
	 * Tries to find a peer that has the given chunk. Returns null if none found.
	 *
	 * @param {import('./lib/validate-payload').FileMeta} file
	 * @param {number} chunkId
	 *
	 * @returns {import('./lib/validate-payload').PeerRequest | null}
	 */
	function createRequest(file, chunkId) {
		for (const peer of shuffle(realtime.getPeers())) {
			const peerFile = peer.state?.files?.find((f) => f.id === file.id)
			if (
				peerFile &&
				peerFile.lastModified === file.lastModified &&
				peerFile.pending.indexOf(chunkId) < 0
			) {
				return {
					time: Date.now(),
					file: file.id,
					chunk: chunkId,
					peer: peer.id,
				}
			}
		}
		return null
	}

	/**
	 * Periodic loop: requests one missing chunk from a peer that has it. Runs
	 * every 100 ms when idle, 10 ms while a request is in flight.
	 */
	function syncChunks() {
		if (
			!currentRequest ||
			Date.now() - currentRequest.time > CHUNK_REQUEST_TIMEOUT_MS
		) {
			let request = null
			const files = realtime.getState()?.files ?? []
			outer: for (const file of files) {
				if (file.pending.length > 0) {
					for (const chunkId of shuffle(file.pending)) {
						request = createRequest(file, chunkId)
						if (request) break outer
					}
				}
			}
			if (request) {
				currentRequest = request
				realtime.sendPayload({ request })
			}
		}
		setTimeout(
			syncChunks,
			currentRequest ? SYNC_POLL_ACTIVE_MS : SYNC_POLL_IDLE_MS
		)
	}

	/**
	 * Discovers new tracks from connected peers and queues them for download.
	 *
	 * @param {import('@webxdc/realtime').Peer<
	 * 	import('./lib/validate-payload').AppState
	 * >[]} peers
	 */
	async function syncFileList(peers) {
		const files = realtime.getState()?.files ?? []
		let changed = false

		for (const peer of peers) {
			const peerFiles = peer.state?.files ?? []
			for (let peerFile of peerFiles) {
				const myFile = files.find((f) => f.id === peerFile.id)
				if (!myFile) {
					// New file from peer - queue all chunks for download.
					peerFile = { ...peerFile, pending: [] }
					const chunkCount = Math.ceil(peerFile.size / CHUNK_SIZE)
					for (let i = 0; i < chunkCount; i++) {
						peerFile.pending.push(i)
					}
					await db.files.add(peerFile)
					files.push(peerFile)
					changed = true
				} else if (myFile.lastModified < peerFile.lastModified) {
					// File was updated - reset and re-download all chunks.
					peerFile = { ...peerFile, pending: [] }
					if (peerFile.size > 0) {
						const chunkCount = Math.ceil(peerFile.size / CHUNK_SIZE)
						for (let i = 0; i < chunkCount; i++) {
							peerFile.pending.push(i)
						}
					}
					await db.files.put(peerFile)
					await db.chunks.where('file').equals(peerFile.id).delete()
					myFile.name = peerFile.name
					myFile.pending = peerFile.pending
					myFile.lastModified = peerFile.lastModified
					myFile.size = peerFile.size
					myFile.type = peerFile.type
					changed = true
				}
			}
		}

		if (changed) {
			realtime.setState({ files })
			refreshPlaylist(files)
		}
	}

	/**
	 * Handles an incoming realtime payload (chunk request or chunk response).
	 *
	 * @param {string} _deviceId
	 * @param {unknown} payload
	 */
	async function handlePayload(_deviceId, payload) {
		if (isRequest(payload)) {
			const { request: req } = payload
			// Only the targeted peer responds.
			if (req.peer !== realtime.getDeviceId()) return

			const file = await db.files.where('id').equals(req.file).first()
			if (file) {
				const chunk = await db.chunks
					.where({ file: req.file, id: req.chunk })
					.first()
				if (chunk) {
					const data = new Uint8Array(await chunk.blob.arrayBuffer())
					realtime.sendPayload({
						response: {
							file: req.file,
							lastModified: file.lastModified,
							chunk: req.chunk,
							data,
						},
					})
				}
			}
		} else if (isResponse(payload)) {
			const { response: res } = payload
			const files = realtime.getState()?.files ?? []
			const file = files.find((f) => f.id === res.file)
			if (
				file &&
				file.lastModified === res.lastModified &&
				file.pending.indexOf(res.chunk) >= 0
			) {
				file.pending = file.pending.filter((c) => c !== res.chunk)
				await db.files.put(file)
				await db.chunks.put({
					file: res.file,
					id: res.chunk,
					blob: new Blob([res.data]),
				})
				if (
					currentRequest?.file === res.file &&
					currentRequest?.chunk === res.chunk
				) {
					currentRequest = null
				}
				realtime.setState({ files })
				refreshPlaylist(files)
			}
		}
	}

	/**
	 * @type {import('@webxdc/realtime').RealTime<
	 * 	import('./lib/validate-payload').AppState,
	 * 	import('./lib/validate-payload').AppPayload
	 * >}
	 */
	const realtime = new RealTime({
		onPeersChanged: (peers) => {
			void syncFileList(peers)
		},
		onPayload: (_deviceId, payload) => {
			void handlePayload(_deviceId, payload)
		},
	})

	// ── startup ────────────────────────────────────────────────────────────

	const allFiles = await db.files.toArray()
	realtime.setState({ files: allFiles })
	realtime.connect()
	window.addEventListener('beforeunload', () => realtime.disconnect())
	refreshPlaylist(allFiles)
	setTimeout(syncChunks, 100)
}
