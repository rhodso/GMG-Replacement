const API_URL = 'https://richard.keithsoft.com/GMG_Rep/api.php'
const REQUEST_TIMEOUT_MS = 15000

export interface Statblock {
	filename: string
	name: string
	HP: number
	MxHP: number
	TmpHP: number
	AC: number
	Group: string
	AttachedPlayer: string
	initiativeBonus?: number
}

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string, requestDescription: string): unknown {
	const cleaned = text.replace(/^\uFEFF/, '').trim()

	if (!cleaned) {
		throw new Error(`${requestDescription} returned an empty response.`)
	}

	try {
		return JSON.parse(cleaned) as unknown
	} catch {
		const preview = cleaned.slice(0, 180).replace(/\s+/g, ' ')
		throw new Error(
			`${requestDescription} did not return valid JSON. Response began: ${preview}`
		)
	}
}

async function requestApi(params: Record<string, string>): Promise<unknown> {
	const url = new URL(API_URL)

	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}

	const controller = new AbortController()
	const timeout = window.setTimeout(
		() => controller.abort(),
		REQUEST_TIMEOUT_MS
	)

	try {
		const response = await fetch(url, {
			method: 'GET',
			mode: 'cors',
			headers: {
				Accept: 'application/json'
			},
			cache: 'no-store',
			signal: controller.signal
		})

		const body = await response.text()

		if (!response.ok) {
			throw new Error(
				`Statblock API returned HTTP ${response.status} ${response.statusText}.`
			)
		}

		return parseJson(body, `Statblock API request ${params.request}`)
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw new Error(`Statblock API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`)
		}

		if (error instanceof TypeError) {
			throw new Error(
				`Could not reach the statblock API. Check the network connection and that the API allows cross-origin (CORS) requests from Owlbear Rodeo. ${error.message}`
			)
		}

		throw error
	} finally {
		window.clearTimeout(timeout)
	}
}

function unwrapResponse(value: unknown, preferredKeys: string[]): unknown {
	let current = value

	// The API may return the payload directly or inside a conventional wrapper.
	for (let depth = 0; depth < 4 && isRecord(current); depth++) {
		const record = current
		if (record.success === false || record.status === 'error') {
			const message = typeof record.message === 'string'
				? record.message
				: typeof record.error === 'string'
					? record.error
					: 'The API reported an error.'
			throw new Error(message)
		}

		const key = preferredKeys.find(candidate => candidate in record)
		if (!key) break
		current = record[key]
	}

	return current
}

function extractFilename(value: unknown): string | null {
	if (typeof value === 'string') {
		const filename = value.trim()
		return filename || null
	}

	if (!isRecord(value)) return null

	for (const key of ['filename', 'fileName', 'file', 'Filename', 'FileName', 'File']) {
		if (typeof value[key] === 'string' && value[key].trim()) {
			return value[key].trim()
		}
	}

	if (typeof value.name === 'string' && value.name.trim()) {
		return value.name.trim()
	}

	return null
}

function parseFilenameList(response: unknown): string[] {
	const payload = unwrapResponse(response, [
		'data', 'files', 'filenames', 'statblocks', 'result', 'list'
	])

	let entries: unknown[]

	if (Array.isArray(payload)) {
		entries = payload
	} else if (isRecord(payload)) {
		// Support a PHP associative object keyed by filename as well as arrays.
		const values = Object.values(payload)
		entries = values.every(value => typeof value === 'string' || isRecord(value))
			? values
			: []
	} else {
		entries = []
	}

	const filenames = entries
		.map(extractFilename)
		.filter((filename): filename is string => filename !== null)

	if (filenames.length === 0) {
		throw new Error('The statblock API returned an unrecognised or empty filename list.')
	}

	return [...new Set(filenames)]
}

function readNumber(
	data: JsonObject,
	keys: string[],
	fieldName: string,
	defaultValue?: number
): number {
	for (const key of keys) {
		const value = data[key]
		if (typeof value === 'number' && Number.isFinite(value)) return value

		if (typeof value === 'string' && value.trim()) {
			const parsed = Number(value)
			if (Number.isFinite(parsed)) return parsed
		}
	}

	if (defaultValue !== undefined) return defaultValue
	throw new Error(`The statblock is missing a valid ${fieldName} value.`)
}

function readString(
	data: JsonObject,
	keys: string[],
	fieldName: string,
	defaultValue?: string
): string {
	for (const key of keys) {
		const value = data[key]
		if (typeof value === 'string') return value
	}

	if (defaultValue !== undefined) return defaultValue
	throw new Error(`The statblock is missing a valid ${fieldName} value.`)
}

function parseStatblockResponse(response: unknown, filename: string): Statblock | null {
	const payload = unwrapResponse(response, [
		'data', 'statblock', 'character', 'result'
	])

	if (payload === null || payload === false) return null

	const data = Array.isArray(payload) ? payload[0] : payload

	if (!isRecord(data)) {
		throw new Error(`The API returned an invalid statblock for "${filename}".`)
	}

	return {
		filename,
		name: readString(data, ['name', 'Name'], 'name', filename),
		HP: readNumber(data, ['HP', 'hp'], 'HP'),
		MxHP: readNumber(data, ['MxHP', 'maxHp', 'MaxHP'], 'maximum HP'),
		TmpHP: readNumber(data, ['TmpHP', 'tempHp', 'TempHP'], 'temporary HP', 0),
		AC: readNumber(data, ['AC', 'ac'], 'AC'),
		Group: readString(data, ['Group', 'group'], 'Group', 'Ungrouped'),
		AttachedPlayer: readString(
			data,
			['AttachedPlayer', 'attachedPlayer'],
			'AttachedPlayer',
			''
		),
		initiativeBonus: readNumber(
			data,
			['initiativeBonus', 'InitiativeBonus', 'InitBonus'],
			'initiative bonus',
			0
		)
	}
}

export async function getStatblockList(): Promise<string[]> {
	const response = await requestApi({ request: '0' })
	return parseFilenameList(response)
}

export async function getStatblock(filename: string): Promise<Statblock | null> {
	// The list endpoint returns filenames such as 'M1.json', but the
	// individual lookup endpoint expects the basename 'M1'.
	const apiStatblockName = filename.replace(/\.json$/i, '')

	const response = await requestApi({
		request: '1',
		sb: apiStatblockName
	})

	// Preserve the original filename for Turnkeeper metadata and matching.
	return parseStatblockResponse(response, filename)
}
