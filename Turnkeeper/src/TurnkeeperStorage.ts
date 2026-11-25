import OBR, { type Item } from '@owlbear-rodeo/sdk'

export const TURNKEEPER_EXTENSION_ID = 'com.rhodso.turnkeeper'
export const TURNKEEPER_CHARACTER_METADATA_KEY = `${TURNKEEPER_EXTENSION_ID}/character`
export const TURNKEEPER_SCENE_METADATA_KEY = `${TURNKEEPER_EXTENSION_ID}/scene`

export interface CharacterData {
	name: string
	hp: number
	maxHp: number
	tempHp: number
	ac: number
	group: string
	attachedPlayer: string
}

export interface StoredCharacterRecord {
	version: 1
	tracked: boolean
	character: CharacterData
	initiativeBonus: number
	statblockFilename: string | null
}

export interface StoredSceneState {
	version: 1
	groups: string[]
	combatActive: boolean
	currentRound: number
	activeTokenId: string | null
	initiativeRolls: Record<string, number>
	conditions: Record<string, string>
}

const DEFAULT_SCENE_STATE: StoredSceneState = {
	version: 1,
	groups: ['Ungrouped'],
	combatActive: false,
	currentRound: 1,
	activeTokenId: null,
	initiativeRolls: {},
	conditions: {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isCharacterData(value: unknown): value is CharacterData {
	if (!isRecord(value)) return false

	return (
		typeof value.name === 'string' &&
		isFiniteNumber(value.hp) &&
		isFiniteNumber(value.maxHp) &&
		isFiniteNumber(value.tempHp) &&
		isFiniteNumber(value.ac) &&
		typeof value.group === 'string' &&
		typeof value.attachedPlayer === 'string'
	)
}

function parseNumberRecord(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {}

	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, number] =>
			isFiniteNumber(entry[1])
		)
	)
}

function parseStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {}

	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] =>
			typeof entry[1] === 'string'
		)
	)
}

export function getStoredCharacterRecord(item: Item): StoredCharacterRecord | null {
	const raw = item.metadata?.[TURNKEEPER_CHARACTER_METADATA_KEY]
	if (!isRecord(raw) || raw.version !== 1 || typeof raw.tracked !== 'boolean') return null
	if (!isCharacterData(raw.character)) return null

	return {
		version: 1,
		tracked: raw.tracked,
		character: { ...raw.character },
		initiativeBonus: isFiniteNumber(raw.initiativeBonus) ? raw.initiativeBonus : 0,
		statblockFilename: typeof raw.statblockFilename === 'string' ? raw.statblockFilename : null
	}
}

export async function getCharacterLayerItems(): Promise<Item[]> {
	return OBR.scene.items.getItems(item => item.layer === 'CHARACTER')
}

export async function getSceneItem(tokenId: string): Promise<Item | null> {
	const items = await OBR.scene.items.getItems([tokenId])
	return items[0] ?? null
}

export async function writeCharacterRecord(
	tokenId: string,
	record: StoredCharacterRecord
): Promise<void> {
	let updated = false

	await OBR.scene.items.updateItems(
		item => item.id === tokenId,
		draftItems => {
			const item = draftItems[0]
			if (!item) return

			item.metadata = {
				...item.metadata,
				[TURNKEEPER_CHARACTER_METADATA_KEY]: record
			}
			updated = true
		}
	)

	if (!updated) {
		throw new Error(`Could not find Owlbear token ${tokenId} to save Turnkeeper metadata.`)
	}
}

export async function setCharacterTracked(
	tokenId: string,
	tracked: boolean
): Promise<boolean> {
	const item = await getSceneItem(tokenId)
	if (!item) return false

	const record = getStoredCharacterRecord(item)
	if (!record) return false

	await writeCharacterRecord(tokenId, { ...record, tracked })
	return true
}

export function parseSceneState(raw: unknown): StoredSceneState {
	if (!isRecord(raw) || raw.version !== 1) {
		return { ...DEFAULT_SCENE_STATE, groups: [...DEFAULT_SCENE_STATE.groups] }
	}

	const groups = Array.isArray(raw.groups)
		? raw.groups.filter((group): group is string => typeof group === 'string' && group.trim().length > 0)
		: ['Ungrouped']

	return {
		version: 1,
		groups: [...new Set(['Ungrouped', ...groups])],
		combatActive: raw.combatActive === true,
		currentRound: isFiniteNumber(raw.currentRound) ? Math.max(1, Math.floor(raw.currentRound)) : 1,
		activeTokenId: typeof raw.activeTokenId === 'string' ? raw.activeTokenId : null,
		initiativeRolls: parseNumberRecord(raw.initiativeRolls),
		conditions: parseStringRecord(raw.conditions)
	}
}

export async function getStoredSceneState(): Promise<StoredSceneState> {
	const metadata = await OBR.scene.getMetadata()
	return parseSceneState(metadata[TURNKEEPER_SCENE_METADATA_KEY])
}

let sceneWriteQueue: Promise<void> = Promise.resolve()

export function writeSceneState(state: StoredSceneState): Promise<void> {
	const write = sceneWriteQueue.then(async () => {
		// OBR.scene.setMetadata merges this extension key with other extensions' metadata.
		await OBR.scene.setMetadata({
			[TURNKEEPER_SCENE_METADATA_KEY]: state
		})
	})

	sceneWriteQueue = write.catch(error => {
		console.error('Failed to save Turnkeeper scene metadata:', error)
	})

	return write
}
