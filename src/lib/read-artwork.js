/**
 * Attempts to extract the first embedded image from an ID3v2 tag. Supports
 * ID3v2.2 (PIC), ID3v2.3, and ID3v2.4 (APIC).
 *
 * @param {ArrayBuffer} buffer - The beginning of an MP3 file (first chunk is
 *   sufficient).
 *
 * @returns {{ blob: Blob; mimeType: string } | null}
 */
export function readArtwork(buffer) {
	const data = new Uint8Array(buffer)

	// Must start with "ID3"
	if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return null

	const majorVersion = data[3]
	if (majorVersion < 2 || majorVersion > 4) return null

	// Tag size is a syncsafe integer (7 bits per byte)
	const tagSize =
		((data[6] & 0x7f) << 21) |
		((data[7] & 0x7f) << 14) |
		((data[8] & 0x7f) << 7) |
		(data[9] & 0x7f)

	const tagEnd = 10 + tagSize
	let offset = 10

	// Skip extended header if present (flag bit 6)
	if (data[5] & 0x40) {
		if (majorVersion === 4) {
			const extSize =
				((data[offset] & 0x7f) << 21) |
				((data[offset + 1] & 0x7f) << 14) |
				((data[offset + 2] & 0x7f) << 7) |
				(data[offset + 3] & 0x7f)
			offset += extSize
		} else {
			const extSize =
				(data[offset] << 24) |
				(data[offset + 1] << 16) |
				(data[offset + 2] << 8) |
				data[offset + 3]
			offset += 4 + extSize
		}
	}

	if (majorVersion === 2) {
		return readArtworkV22(data, offset, tagEnd)
	}
	return readArtworkV23V24(data, offset, tagEnd, majorVersion === 4)
}

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number} tagEnd
 *
 * @returns {{ blob: Blob; mimeType: string } | null}
 */
function readArtworkV22(data, offset, tagEnd) {
	while (offset + 6 <= tagEnd) {
		if (data[offset] === 0) break // padding

		const frameId = String.fromCharCode(
			data[offset],
			data[offset + 1],
			data[offset + 2]
		)
		const frameSize =
			(data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5]
		offset += 6

		if (frameId === 'PIC' && frameSize > 5) {
			const frameStart = offset
			const encoding = data[offset]
			// 3-char image format e.g. "JPG", "PNG"
			const imgFmt = String.fromCharCode(
				data[offset + 1],
				data[offset + 2],
				data[offset + 3]
			).toUpperCase()
			offset += 5 // encoding(1) + format(3) + picture type(1)

			// Skip description (encoding-dependent, null-terminated)
			offset = skipNullTerminated(
				data,
				offset,
				encoding,
				frameStart + frameSize
			)

			const mimeType =
				imgFmt === 'JPG'
					? 'image/jpeg'
					: imgFmt === 'PNG'
						? 'image/png'
						: `image/${imgFmt.toLowerCase()}`

			const imageData = data.slice(offset, frameStart + frameSize)
			if (imageData.length > 0) {
				return { blob: new Blob([imageData], { type: mimeType }), mimeType }
			}
		}

		offset += frameSize
	}
	return null
}

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number} tagEnd
 * @param {boolean} syncsafeSize Whether frame sizes are syncsafe (ID3v2.4)
 *
 * @returns {{ blob: Blob; mimeType: string } | null}
 */
function readArtworkV23V24(data, offset, tagEnd, syncsafeSize) {
	while (offset + 10 <= tagEnd) {
		if (data[offset] === 0) break // padding

		const frameId = String.fromCharCode(
			data[offset],
			data[offset + 1],
			data[offset + 2],
			data[offset + 3]
		)
		const frameSize = syncsafeSize
			? ((data[offset + 4] & 0x7f) << 21) |
				((data[offset + 5] & 0x7f) << 14) |
				((data[offset + 6] & 0x7f) << 7) |
				(data[offset + 7] & 0x7f)
			: (data[offset + 4] << 24) |
				(data[offset + 5] << 16) |
				(data[offset + 6] << 8) |
				data[offset + 7]
		offset += 10 // 4 (id) + 4 (size) + 2 (flags)

		if (frameId === 'APIC' && frameSize > 0) {
			const frameStart = offset
			const encoding = data[offset]
			offset++

			// MIME type: null-terminated ASCII
			let mimeEnd = offset
			while (mimeEnd < frameStart + frameSize && data[mimeEnd] !== 0) mimeEnd++
			const mimeType =
				new TextDecoder().decode(data.slice(offset, mimeEnd)) || 'image/jpeg'
			offset = mimeEnd + 1 // skip null terminator

			offset++ // skip picture type byte

			// Skip description (encoding-dependent, null-terminated)
			offset = skipNullTerminated(
				data,
				offset,
				encoding,
				frameStart + frameSize
			)

			const imageData = data.slice(offset, frameStart + frameSize)
			if (imageData.length > 0) {
				return { blob: new Blob([imageData], { type: mimeType }), mimeType }
			}

			offset = frameStart + frameSize
		} else {
			offset += frameSize
		}
	}
	return null
}

/**
 * Advances past a null-terminated string, handling UTF-16 (encodings 1 and 2)
 * vs. single-byte (encodings 0 and 3).
 *
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number} encoding
 * @param {number} limit
 *
 * @returns {number} Offset after the null terminator(s)
 */
function skipNullTerminated(data, offset, encoding, limit) {
	if (encoding === 1 || encoding === 2) {
		// UTF-16: terminated by 0x00 0x00 (aligned to 2 bytes)
		while (
			offset + 1 < limit &&
			(data[offset] !== 0 || data[offset + 1] !== 0)
		) {
			offset += 2
		}
		return Math.min(offset + 2, limit)
	}
	// Latin-1 or UTF-8: terminated by 0x00
	while (offset < limit && data[offset] !== 0) offset++
	return Math.min(offset + 1, limit)
}
