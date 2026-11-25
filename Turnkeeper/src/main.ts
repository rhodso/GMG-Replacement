
import OBR, { isImage, type Item } from '@owlbear-rodeo/sdk'
import './style.css'
import { drawToken, clearTokenDrawing } from './DrawToken'

import {
	TURNKEEPER_EXTENSION_ID,
	getCharacterLayerItems,
	getStoredCharacterRecord,
	getStoredSceneState,
	parseSceneState,
	setCharacterTracked,
	writeCharacterRecord,
	writeSceneState,
	type StoredCharacterRecord,
	type StoredSceneState
} from './TurnkeeperStorage'

interface Character {
	name: string
	hp: number
	maxHp: number
	tempHp: number
	ac: number
	group: string
	attachedPlayer: string
}

type GroupCategory = 'P' | 'A' | 'E' | 'U'

// Role tracking
type OwlbearRole = 'GM' | 'PLAYER'
type PartyPlayer = Awaited<ReturnType<typeof OBR.party.getPlayers>>[number]

interface RoomMember {
	id: string
	connectionId: string
	role: OwlbearRole
	isCurrentUser: boolean
}

let currentUserRole: OwlbearRole | null = null
let currentUserName = ''
let roomMembers: RoomMember[] = []

// All of this is temporary and will be replaced eventually with the stuff from API calls
interface Statblock {
	filename: string
	name: string
	HP: number
	MxHP: number
	TmpHP: number
	AC: number
	Group: string
	AttachedPlayer: string
	initiativeBonus: number
}

const statblocks: Statblock[] = [
	{
		filename: 'Goblin Warrior',
		name: 'Goblin Warrior',
		HP: 12,
		MxHP: 12,
		TmpHP: 0,
		AC: 13,
		Group: 'E_Goblins',
		AttachedPlayer: '',
		initiativeBonus: 2
	},
	{
		filename: 'Arannis',
		name: 'Arannis',
		HP: 85,
		MxHP: 100,
		TmpHP: 10,
		AC: 18,
		Group: 'P_Players',
		AttachedPlayer: '',
		initiativeBonus: 3
	},
	{
		filename: 'M1',
		name: 'Marker 1',
		HP: 10,
		MxHP: 12,
		TmpHP: 5,
		AC: 15,
		Group: 'P_Players',
		AttachedPlayer: '',
		initiativeBonus: 3
	}
]

const characters: Character[] = []

// Mock statblock information
// Initiative bonuses will eventually come from the statblock server
const initiativeBonuses = new Map<Character, number>([])

// Temporary associations between Owlbear tokens and characters
const tokenToCharacter = new Map<string, Character>()
const characterToToken = new Map<Character, string>()

// Temporary encounter data and conditions
const initiativeRolls = new Map<Character, number>()
const conditions = new Map<Character, string>()

// Remember which statblock filename was used to initialise each character.
const statblockFilenames = new Map<Character, string | null>()

// Track the metadata versions we've already loaded, avoiding unnecessary redraws.
const tokenMetadataSignatures = new Map<string, string>()

// Pending character metadata writes, serialised separately for each token.
const pendingCharacterWrites = new Map<string, Promise<void>>()
let lastSceneStateSignature = ''

// Owlbear token ownership and image
const tokenImageUrls = new Map<string, string>()
const tokenOwnerIds = new Map<string, string>()
let currentUserId = ''

// Owlbear room and scene state.
let sceneReady = false
let sceneInitializing = false
let sceneGeneration = 0

// Group definitions
const groups: string[] = [
	'Ungrouped',
	...new Set(characters.map(character => character.group))
]

// Currently dragged character
let draggedCharacter: Character | null = null

let combatActive = false
let currentRound = 1
let activeCharacter: Character | null = null

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
	throw new Error('Could not find #app element')
}

// -----------------------------------------------------------------------------
// Local character state
// -----------------------------------------------------------------------------

function registerStoredCharacter(
	tokenId: string,
	record: StoredCharacterRecord
): Character {
	let character = tokenToCharacter.get(tokenId)

	if (character) {
		Object.assign(character, record.character)
	} else {
		character = { ...record.character }
		characters.push(character)
	}

	if (!characters.includes(character)) {
		characters.push(character)
	}

	tokenToCharacter.set(tokenId, character)
	characterToToken.set(character, tokenId)

	initiativeBonuses.set(character, record.initiativeBonus)
	statblockFilenames.set(character, record.statblockFilename)

	tokenMetadataSignatures.set(tokenId, JSON.stringify(record))

	if (!groups.includes(character.group)) {
		groups.push(character.group)
	}

	return character
}

function removeLocalCharacter(tokenId: string): boolean {
	const character = tokenToCharacter.get(tokenId)

	if (!character) return false

	tokenToCharacter.delete(tokenId)
	characterToToken.delete(character)

	initiativeBonuses.delete(character)
	statblockFilenames.delete(character)

	initiativeRolls.delete(character)
	conditions.delete(character)
	tokenOwnerIds.delete(tokenId)

	tokenImageUrls.delete(tokenId)

	const index = characters.indexOf(character)

	if (index !== -1) {
		characters.splice(index, 1)
	}

	if (activeCharacter === character) {
		activeCharacter = null
	}

	tokenMetadataSignatures.delete(tokenId)

	return true
}

// -----------------------------------------------------------------------------
// Reconcile character data with Owlbear's current scene items
// -----------------------------------------------------------------------------

function syncTrackedCharacters(items: Item[]): boolean {
	const trackedTokenIds = new Set<string>()
	let changed = false

	for (const item of items) {
		if (item.layer !== 'CHARACTER') continue

		const record = getStoredCharacterRecord(item)
		if (!record || !record.tracked) continue

		trackedTokenIds.add(item.id)

		// Remember the token's actual image for its sidebar avatar.
		const imageUrl = isImage(item) ? item.image.url : null
		const previousImageUrl = tokenImageUrls.get(item.id) ?? null

		if (imageUrl !== previousImageUrl) {
			if (imageUrl) {
				tokenImageUrls.set(item.id, imageUrl)
			} else {
				tokenImageUrls.delete(item.id)
			}

			changed = true
		}

		// Track Owlbear's native token owner.
		const ownerId = item.createdUserId ?? ''
		const previousOwnerId = tokenOwnerIds.get(item.id)

		if (previousOwnerId !== ownerId) {
			tokenOwnerIds.set(item.id, ownerId)
			changed = true
		}

		// Ignore metadata notifications for tokens with writes in progress.
		if (pendingCharacterWrites.has(item.id)) continue

		const signature = JSON.stringify(record)
		const previousSignature = tokenMetadataSignatures.get(item.id)

		if (
			previousSignature !== signature ||
			!tokenToCharacter.has(item.id)
		) {
			registerStoredCharacter(item.id, record)
			changed = true
		}
	}

	// Remove characters that were deactivated or deleted.
	for (const tokenId of [...tokenToCharacter.keys()]) {
		if (!trackedTokenIds.has(tokenId)) {
			removeLocalCharacter(tokenId)
			changed = true
		}
	}

	for (const tokenId of [...tokenMetadataSignatures.keys()]) {
		if (!trackedTokenIds.has(tokenId)) {
			tokenMetadataSignatures.delete(tokenId)
		}
	}

	for (const tokenId of [...tokenOwnerIds.keys()]) {
		if (!trackedTokenIds.has(tokenId)) {
			tokenOwnerIds.delete(tokenId)
			changed = true
		}
	}

	return changed
}

// -----------------------------------------------------------------------------
// Scene state
// -----------------------------------------------------------------------------

function resetLocalSceneState(): void {
	characters.splice(0, characters.length)

	initiativeBonuses.clear()
	tokenToCharacter.clear()
	characterToToken.clear()

	initiativeRolls.clear()
	conditions.clear()

	statblockFilenames.clear()
	tokenMetadataSignatures.clear()
	tokenOwnerIds.clear()

	tokenImageUrls.clear()

	groups.splice(0, groups.length, 'Ungrouped')

	combatActive = false
	currentRound = 1
	activeCharacter = null

	lastSceneStateSignature = ''
}

function applyStoredSceneState(state: StoredSceneState): void {
	const restoredGroups = new Set([
		'Ungrouped',
		...state.groups
	])

	// Ensure groups referenced by characters are present too.
	for (const character of characters) {
		restoredGroups.add(character.group)
	}

	groups.splice(0, groups.length, ...restoredGroups)

	combatActive = state.combatActive
	currentRound = state.currentRound

	initiativeRolls.clear()
	conditions.clear()

	for (const [tokenId, roll] of Object.entries(state.initiativeRolls)) {
		const character = tokenToCharacter.get(tokenId)

		if (character) {
			initiativeRolls.set(character, roll)
		}
	}

	for (const [tokenId, condition] of Object.entries(state.conditions)) {
		const character = tokenToCharacter.get(tokenId)

		if (character) {
			conditions.set(character, condition)
		}
	}

	activeCharacter = state.activeTokenId
		? tokenToCharacter.get(state.activeTokenId) ?? null
		: null
}

function createStoredSceneState(): StoredSceneState {
	const savedInitiativeRolls: Record<string, number> = {}
	const savedConditions: Record<string, string> = {}

	for (const [character, roll] of initiativeRolls) {
		const tokenId = characterToToken.get(character)

		if (tokenId) {
			savedInitiativeRolls[tokenId] = roll
		}
	}

	for (const [character, condition] of conditions) {
		const tokenId = characterToToken.get(character)

		if (tokenId) {
			savedConditions[tokenId] = condition
		}
	}

	return {
		version: 1,
		groups: [...groups],
		combatActive,
		currentRound,
		activeTokenId: activeCharacter
			? characterToToken.get(activeCharacter) ?? null
			: null,
		initiativeRolls: savedInitiativeRolls,
		conditions: savedConditions
	}
}

function getTokenDrawingStateSignature(): string {
	const conditionEntries: [string, string][] = []

	for (const [character, condition] of conditions) {
		const tokenId = characterToToken.get(character)

		if (tokenId) {
			conditionEntries.push([tokenId, condition])
		}
	}

	conditionEntries.sort(([a], [b]) => a.localeCompare(b))

	return JSON.stringify({
		activeTokenId: activeCharacter
			? characterToToken.get(activeCharacter) ?? null
			: null,
		conditions: conditionEntries
	})
}

// Persist local changes to Owlbear
async function persistCharacter(character: Character): Promise<void> {
	if (!sceneReady || !canEditCharacter(character)) return

	const tokenId = characterToToken.get(character)

	if (!tokenId) return

	// Queue this write behind any existing write for this token.
	const previousWrite = pendingCharacterWrites.get(tokenId) ?? Promise.resolve()

	const currentWrite = previousWrite
		.catch(() => undefined)
		.then(async () => {
			// Check that the character is still tracked and the scene is ready.
			if (!sceneReady || !canEditCharacter(character)) return
			if (tokenToCharacter.get(tokenId) !== character) return

			// Build the record when the write executes, not when it is queued.
			// This ensures we always save the most recent character values.
			const record: StoredCharacterRecord = {
				version: 1,
				tracked: true,
				character: { ...character },
				initiativeBonus: getInitiativeBonus(character),
				statblockFilename: statblockFilenames.get(character) ?? null
			}

			const signature = JSON.stringify(record)

			// Skip this write if the latest values are already saved.
			if (tokenMetadataSignatures.get(tokenId) === signature) return

			// Register the pending signature before writing.
			// This prevents our own Owlbear change notification from
			// unnecessarily overwriting the local character state.
			const previousSignature = tokenMetadataSignatures.get(tokenId)
			tokenMetadataSignatures.set(tokenId, signature)

			try {
				await writeCharacterRecord(tokenId, record)
			} catch (error) {
				// Restore the previous signature if the write failed.
				if (tokenMetadataSignatures.get(tokenId) === signature) {
					if (previousSignature === undefined) {
						tokenMetadataSignatures.delete(tokenId)
					} else {
						tokenMetadataSignatures.set(tokenId, previousSignature)
					}
				}

				throw error
			}
		})

	pendingCharacterWrites.set(tokenId, currentWrite)

	try {
		await currentWrite
	} catch (error) {
		console.error(`Failed to save character ${character.name}:`, error)
	} finally {
		// Only remove the queue if this is still its latest operation.
		if (pendingCharacterWrites.get(tokenId) === currentWrite) {
			pendingCharacterWrites.delete(tokenId)
		}
	}
}

async function persistSceneState(): Promise<void> {
	if (!sceneReady || currentUserRole !== 'GM') return

	const state = createStoredSceneState()
	const signature = JSON.stringify(state)

	if (signature === lastSceneStateSignature) return

	// Update before writing so our own metadata notification is recognised.
	lastSceneStateSignature = signature

	try {
		await writeSceneState(state)
	} catch (error) {
		console.error('Failed to persist Turnkeeper scene state:', error)

		if (lastSceneStateSignature === signature) {
			lastSceneStateSignature = ''
		}
	}
}

async function persistOwnedEncounterState(
	character: Character
): Promise<void> {
	if (!sceneReady || !canEditCharacter(character)) return

	const tokenId = characterToToken.get(character)
	if (!tokenId) return

	try {
		// Read the latest scene state so we don't overwrite other
		// players' initiative or conditions with stale local data.
		const state = await getStoredSceneState()

		const nextState: StoredSceneState = {
			...state,
			initiativeRolls: { ...state.initiativeRolls },
			conditions: { ...state.conditions }
		}

		const initiative = initiativeRolls.get(character)
		const condition = conditions.get(character)

		if (initiative === undefined) {
			delete nextState.initiativeRolls[tokenId]
		} else {
			nextState.initiativeRolls[tokenId] = initiative
		}

		if (!condition) {
			delete nextState.conditions[tokenId]
		} else {
			nextState.conditions[tokenId] = condition
		}

		const signature = JSON.stringify(nextState)
		lastSceneStateSignature = signature

		await writeSceneState(nextState)
	} catch (error) {
		console.error(
			`Failed to save encounter data for ${character.name}:`,
			error
		)
		lastSceneStateSignature = ''
	}
}

// -----------------------------------------------------------------------------
// Scene loading
// -----------------------------------------------------------------------------

async function initialiseScene(): Promise<void> {
	if (sceneInitializing) return

	const generation = ++sceneGeneration
	sceneInitializing = true

	try {
		if (!(await OBR.scene.isReady())) {
			sceneReady = false
			return
		}

		const [role, items, state] = await Promise.all([
			OBR.player.getRole(),
			getCharacterLayerItems(),
			getStoredSceneState()
		])

		// Ignore this result if Owlbear has changed scenes while we were loading.
		if (generation !== sceneGeneration) return

		currentUserRole = role
		lastSceneStateSignature = JSON.stringify(state)

		resetLocalSceneState()

		syncTrackedCharacters(items)
		applyStoredSceneState(state)

		sceneReady = true

		render()

		// The overlays are shared scene items. The GM refreshes them when
		// the scene opens; players simply see the shared versions.
		if (currentUserRole === 'GM') {
			await updateAllTokenDrawings()
		}

	} catch (error) {
		console.error('Failed to initialise Turnkeeper scene:', error)
	} finally {
		if (generation === sceneGeneration) {
			sceneInitializing = false
		}
	}
}

// Watch for changes from other instances of Turnkeeper
async function setupTurnkeeperPersistence(): Promise<void> {
	OBR.scene.items.onChange(items => {
		if (!sceneReady || sceneInitializing) return

		if (syncTrackedCharacters(items)) {
			render()

			if (currentUserRole === 'GM') {
				void updateAllTokenDrawings()
			}
		}
	})

	OBR.scene.onMetadataChange(metadata => {
		if (!sceneReady || sceneInitializing) return

		const state = parseSceneState(
			metadata['com.rhodso.turnkeeper/scene']
		)

		const signature = JSON.stringify(state)

		// Ignore identical metadata, including our own writes.
		if (signature === lastSceneStateSignature) return

		const previousDrawingState = getTokenDrawingStateSignature()

		lastSceneStateSignature = signature

		applyStoredSceneState(state)
		render()

		const newDrawingState = getTokenDrawingStateSignature()

		// Only redraw when conditions or the active turn actually changed.
		if (
			currentUserRole === 'GM' &&
			previousDrawingState !== newDrawingState
		) {
			void updateAllTokenDrawings()
		}
	})

	OBR.scene.onReadyChange(ready => {
		if (ready) {
			void initialiseScene()
		} else {
			sceneGeneration++
			sceneReady = false
			sceneInitializing = false

			resetLocalSceneState()
			render()
		}
	})

	OBR.player.onChange(player => {
		currentUserRole = player.role
		render()
	})

	// onReadyChange may not fire when the extension first opens in an
	// already-loaded scene, so explicitly check the current scene too.
	await initialiseScene()
}

// Statblock Retrieval Helpers
async function getStatblockList(): Promise<string[]> {
	// Future API request:
	// GET api.php?request=0

	return statblocks.map(statblock => statblock.filename)
}

async function getStatblock(filename: string): Promise<Statblock | null> {
	// Future API request:
	// GET api.php?request=1&sb=[filename]

	return statblocks.find(
		statblock => statblock.filename === filename
	) ?? null
}

function normaliseStatblockName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
}

// Fuzzy search stuff for statblock fetching
function levenshteinDistance(a: string, b: string): number {
	const matrix: number[][] = []

	// Calculate numbers
	for (let i = 0; i <= a.length; i++) { matrix[i] = [i] }
	for (let j = 0; j <= b.length; j++) { matrix[0][j] = j }

	// Calculate difference
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1

			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost
			)
		}
	}

	// Regturn the matrix
	return matrix[a.length][b.length]
}

// Name similarity for fuzzy search
// Shouldn't be needed but nice to have
function getNameSimilarity(a: string, b: string): number {
	const nameA = normaliseStatblockName(a)
	const nameB = normaliseStatblockName(b)

	if (!nameA || !nameB) return 0
	if (nameA === nameB) return 1

	// Get distance and maxlen
	const distance = levenshteinDistance(nameA, nameB)
	const maxLength = Math.max(nameA.length, nameB.length)

	// Similarity for characters
	const characterSimilarity = 1 - distance / maxLength

	const wordsA = new Set(nameA.split(' '))
	const wordsB = new Set(nameB.split(' '))

	const sharedWords = [...wordsA].filter(word => wordsB.has(word)).length
	const totalWords = new Set([...wordsA, ...wordsB]).size

	// Calc actual similarity for whole word
	const wordSimilarity = totalWords > 0 ? sharedWords / totalWords : 0
	
	// Character similarity carries more weight than word similarity.
	return characterSimilarity * 0.8 + wordSimilarity * 0.2
}

// Find the statblock that most closely matches the name
function findClosestStatblock( tokenName: string, filenames: string[] ): { filename: string; score: number } | null {
	
	// A one-liner to end all one liners
	const matches = filenames
		.map(filename => ({ filename, score: getNameSimilarity(tokenName, filename) }))
		.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))

	const bestMatch = matches[0]

	// Don't automatically attach a completely unrelated statblock
	if (!bestMatch || bestMatch.score < 0.55) { return null }
	
	return bestMatch
}

interface TokenReference {
	id: string
	name: string
}

async function addTokensToTurnkeeper(tokens: TokenReference[]): Promise<void> {
	if (tokens.length === 0 || currentUserRole !== 'GM') return

	const sceneItems = await OBR.scene.items.getItems(
		tokens.map(token => token.id)
	)

	const itemsById = new Map(sceneItems.map(item => [item.id, item]))

	const pendingTokens: TokenReference[] = []
	const failures: string[] = []
	const alreadyAdded: string[] = []

	let added = 0

	// First try to recover saved character data.
	for (const token of tokens) {
		const tokenName = token.name.trim()

		if (tokenToCharacter.has(token.id)) {
			alreadyAdded.push(tokenName || token.id)
			continue
		}

		const item = itemsById.get(token.id)
		const savedRecord = item
			? getStoredCharacterRecord(item)
			: null

		if (savedRecord) {
			try {
				// Reactivate without replacing any saved character values.
				const activatedRecord: StoredCharacterRecord = {
					...savedRecord,
					tracked: true
				}

				const character = registerStoredCharacter(
					token.id,
					activatedRecord
				)

				if (!savedRecord.tracked) {
					await writeCharacterRecord(token.id, activatedRecord)
				}

				await updateTokenDrawing(character)

				added++
			} catch (error) {
				console.error(`Failed to restore ${tokenName}:`, error)
				failures.push(tokenName || token.id)
			}

			continue
		}

		// No saved metadata: this token needs initial statblock data.
		pendingTokens.push(token)
	}

	// Only contact the statblock source when we have genuinely new tokens.
	if (pendingTokens.length > 0) {
		let filenames: string[] = []

		try {
			filenames = await getStatblockList()
		} catch (error) {
			console.error('Failed to retrieve statblock list:', error)

			failures.push(...pendingTokens.map(token => token.name))

			await OBR.notification.show(
				'Unable to retrieve statblocks for new tokens.',
				'ERROR'
			)
		}

		if (filenames.length === 0 && failures.length === 0) {
			failures.push(...pendingTokens.map(token => token.name))

			await OBR.notification.show(
				'No statblocks are available.',
				'WARNING'
			)
		}

		for (const token of pendingTokens) {
			if (filenames.length === 0) continue

			const tokenName = token.name.trim()

			if (!tokenName) {
				failures.push('Unnamed token')
				continue
			}

			const match = findClosestStatblock(tokenName, filenames)

			if (!match) {
				failures.push(tokenName)
				continue
			}

			const statblock = await getStatblock(match.filename)

			if (!statblock) {
				failures.push(tokenName)
				continue
			}

			const character: Character = {
				name: statblock.name || tokenName,
				hp: statblock.HP,
				maxHp: statblock.MxHP,
				tempHp: statblock.TmpHP,
				ac: statblock.AC,
				group: statblock.Group || 'Ungrouped',
				attachedPlayer: statblock.AttachedPlayer || ''
			}

			const record: StoredCharacterRecord = {
				version: 1,
				tracked: true,
				character,
				initiativeBonus: statblock.initiativeBonus ?? 0,
				statblockFilename: match.filename
			}

			try {
				// Register locally first so our own metadata notification
				// doesn't cause a second registration and redraw.
				const registeredCharacter = registerStoredCharacter(
					token.id,
					record
				)

				await writeCharacterRecord(token.id, record)
				await updateTokenDrawing(registeredCharacter)

				added++
			} catch (error) {
				console.error(`Failed to save ${tokenName}:`, error)
				failures.push(tokenName)
				removeLocalCharacter(token.id)
			}
		}
	}
	render()

	// Only save scene state when something was actually added or restored.
	if (added > 0) {
		await persistSceneState()
	}

	if (added > 0) {
		await OBR.notification.show(
			`Added ${added} character${added === 1 ? '' : 's'} to Turnkeeper.`,
			failures.length > 0 || alreadyAdded.length > 0
				? 'WARNING'
				: 'SUCCESS'
		)
	}

	if (failures.length > 0) {
		console.warn('Could not add:', failures)

		await OBR.notification.show(
			`Could not add: ${failures.join(', ')}`,
			'WARNING'
		)
	}

	if (alreadyAdded.length > 0 && added === 0 && failures.length === 0) {
		await OBR.notification.show(
			'All selected tokens are already in Turnkeeper.',
			'INFO'
		)
	}
}

// General helpers
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')
}

function getCharacterAvatarContent(character: Character): string {
	const tokenId = characterToToken.get(character)
	const imageUrl = tokenId
		? tokenImageUrls.get(tokenId)
		: undefined

	if (imageUrl) {
		return `
			<img
				class="character-avatar-image"
				src="${escapeHtml(imageUrl)}"
				alt=""
				aria-hidden="true"
			/>
		`
	}

	return escapeHtml(
		character.name.charAt(0).toUpperCase() || '?'
	)
}

function getInitiativeBonus(character: Character): number {
	return initiativeBonuses.get(character) ?? 0
}

function getGroupCategory(group: string): GroupCategory {
	// Ungrouped is a special group treated as an Enemy group so it doesn't show anything
	if (group === 'Ungrouped') return 'E'

	const prefix = group.trim().charAt(0).toUpperCase()

	if (prefix === 'P') return 'P'
	if (prefix === 'A') return 'A'
	if (prefix === 'E') return 'E'

	return 'U'
}

function getTokenOwnerId(character: Character): string | null {
	const tokenId = characterToToken.get(character)
	if (!tokenId) return null

	return tokenOwnerIds.get(tokenId) || null
}

function isCharacterOwner(character: Character): boolean {
	const ownerId = getTokenOwnerId(character)

	return Boolean(
		currentUserId &&
		ownerId &&
		ownerId === currentUserId
	)
}

function canEditCharacter(character: Character): boolean {
	if (currentUserRole === 'GM') return true

	return isCharacterOwner(character)
}

function canViewCharacter(character: Character): boolean {
	if (currentUserRole === 'GM') return true
	if (currentUserRole !== 'PLAYER') return false
	if (isCharacterOwner(character)) return true

	const category = getGroupCategory(character.group)

	// Players can see friendly characters they don't own,
	// but cannot see unowned enemies or unclassified characters.
	return category === 'P' || category === 'A'
}

function getCharacterOwnerLabel(character: Character): string {
	const ownerId = getTokenOwnerId(character)

	if (!ownerId) return 'Unassigned'
	if (ownerId === currentUserId) return 'You'

	return 'Another player'
}

// Order categories
function getCategoryOrder(group: string): number {
	const order: Record<GroupCategory, number> = {
		P: 0,
		A: 1,
		E: 2,
		U: 3
	}

	return order[getGroupCategory(group)]
}

// Get thr label for the group
function getGroupLabel(group: string): string {
	if (group === 'Ungrouped') return 'Ungrouped'

	if (/^[PAE][_-]/i.test(group)) {
		return group.slice(2).trim() || group
	}

	return group
}

// For qiuck initiative
function rollD20(): number {
	return Math.floor(Math.random() * 20) + 1
}

// Apply HP input:
// 20 + 5 = 25
// 20 - 5 = 15
// But also is clamped to max on heal
// And also takes from tmphp first on damage
function applyHpInput(character: Character, input: string): boolean {
	const value = input.replace(/\s/g, '')

	if (!value) return false

	let operator: '+' | '-' | null = null
	let amount = 0

	// Allow an absolute HP value, e.g. 75
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		character.hp = Math.min(
			character.maxHp,
			Math.max(0, Number(value))
		)
		return true
	}

	// Allow a complete expression, e.g. 85+20 or 8-10
	const fullExpression = value.match(
		/^(\d+(?:\.\d+)?)([+-])(\d+(?:\.\d+)?)$/
	)

	if (fullExpression) {
		const startingHp = Number(fullExpression[1])

		// Ensure the expression starts with the character's current HP
		if (startingHp !== character.hp) return false

		operator = fullExpression[2] as '+' | '-'
		amount = Number(fullExpression[3])
	} else {
		// Also allow shorthand, e.g. +20 or -10
		const shorthand = value.match(
			/^([+-])(\d+(?:\.\d+)?)$/
		)

		if (!shorthand) return false

		operator = shorthand[1] as '+' | '-'
		amount = Number(shorthand[2])
	}

	if (operator === '+') {
		// Healing cannot exceed maximum HP
		character.hp = Math.min(
			character.maxHp,
			character.hp + amount
		)
	} else {
		// Damage is absorbed by temporary HP first
		const absorbed = Math.min(character.tempHp, amount)

		character.tempHp -= absorbed

		// Any remaining damage is applied to normal HP
		const remainingDamage = amount - absorbed

		character.hp = Math.max(
			0,
			character.hp - remainingDamage
		)
	}

	return true
}

// Initiative management
function rollCharacter(character: Character): void {
	initiativeRolls.set(
		character,
		rollD20() + getInitiativeBonus(character)
	)
}

// Break initiative ties
function compareInitiative(a: Character, b: Character): number {
	const rollA = initiativeRolls.get(a)
	const rollB = initiativeRolls.get(b)

	// Highest initiative result first
	if (rollA !== rollB) {
		if (rollA === undefined) return 1
		if (rollB === undefined) return -1

		return rollB - rollA
	}

  // Initiative ties are broken in 3 ways:
  // 1 - Highest initiative bonus goes first
  // 2 - Group type goes first. Players > Allies > Enemies
  // 3 - If all else fails, Alphabetical

	const bonusDifference =
		getInitiativeBonus(b) - getInitiativeBonus(a)

	if (bonusDifference !== 0) return bonusDifference

	const categoryDifference =
		getCategoryOrder(a.group) - getCategoryOrder(b.group)

	if (categoryDifference !== 0) return categoryDifference

	return a.name.localeCompare(b.name, undefined, {
		sensitivity: 'base'
	})
}

// Do the initaitve sorting
function getInitiativeOrder(): Character[] {
	return [...characters].sort(compareInitiative)
}

function startCombat(): void {
	// Preserve any initiative already entered or rolled
	for (const character of characters) {
		if (!initiativeRolls.has(character)) {
			rollCharacter(character)
		}
	}

	combatActive = true
	currentRound = 1
	activeCharacter = getInitiativeOrder()[0] ?? null
	void persistSceneState()
	void updateAllTokenDrawings()
}

// When combat stops
function stopCombat(): void {
	combatActive = false
	currentRound = 1
	activeCharacter = null
	initiativeRolls.clear()
	conditions.clear()
	void persistSceneState()
	void updateAllTokenDrawings()
}

// Next or previous turn in initiative
function changeTurn(direction: number): void {
	const order = getInitiativeOrder()

	if (order.length === 0) return

	const index = activeCharacter
		? order.indexOf(activeCharacter)
		: -1

	if (index === -1) {
		activeCharacter = order[0]

		void persistSceneState()
		void updateAllTokenDrawings()

		return
	}

	const nextIndex = index + direction

	if (nextIndex >= order.length) {
		currentRound++
		activeCharacter = order[0]
	} else if (nextIndex < 0) {
		currentRound = Math.max(1, currentRound - 1)
		activeCharacter = order[order.length - 1]
	} else {
		activeCharacter = order[nextIndex]
	}
	void persistSceneState()

	// Redraw token overlays
	void updateAllTokenDrawings()

}

// Character grouping
function getGroupedCharacters(): Map<string, Character[]> {
	const grouped = new Map<string, Character[]>()

	// Make sure every character has a group
	for (const character of characters) {
		character.group = character.group.trim() || 'Ungrouped'

		// Include groups that have not yet been registered
		if (!groups.includes(character.group)) {
			groups.push(character.group)
		}
	}

	// Initialise all groups, even empty ones
	for (const group of groups) {
		grouped.set(group, [])
	}

	// Assign characters to their groups
	for (const character of characters) {
		grouped.get(character.group)?.push(character)
	}

	// Sort groups by category, then alphabetically
	return new Map(
		[...grouped.entries()].sort((a, b) => {
			const categoryDifference =
				getCategoryOrder(a[0]) - getCategoryOrder(b[0])

			if (categoryDifference !== 0) return categoryDifference

			return getGroupLabel(a[0]).localeCompare(
				getGroupLabel(b[0]),
				undefined,
				{ sensitivity: 'base' }
			)
		})
	)
}

function getDisplayGroups(): Map<string, Character[]> {
	const allGroups = getGroupedCharacters()

	if (currentUserRole !== 'PLAYER') {
		return allGroups
	}

	const displayGroups = new Map<string, Character[]>()
	const enemies: Character[] = []

	for (const [group, members] of allGroups) {
		const category = getGroupCategory(group)

		if (category === 'E' || category === 'U') {
			enemies.push(...members)
		} else if (members.length > 0) {
			displayGroups.set(group, members)
		}
	}

	// Combine all enemy groups into one anonymous group.
	if (enemies.length > 0) {
		displayGroups.set('E_Enemies', enemies)
	}

	return new Map(
		[...displayGroups.entries()].sort((a, b) => {
			const categoryDifference =
				getCategoryOrder(a[0]) - getCategoryOrder(b[0])

			if (categoryDifference !== 0) return categoryDifference

			return getGroupLabel(a[0]).localeCompare(
				getGroupLabel(b[0]),
				undefined,
				{ sensitivity: 'base' }
			)
		})
	)
}


function validateGroupName(input: string): string | null {
	const name = input.trim()

	// Group names must begin with P, A or E (aside from Ungrouped)
	if (name.length < 2 || !/^[PAE]/i.test(name)) {
		return null
	}

	// Normalise the category prefix
	return name.charAt(0).toUpperCase() + name.slice(1)
}

function groupAlreadyExists(name: string, excludedGroup?: string): boolean {
	return groups.some(group =>
		group !== excludedGroup &&
		group.toLowerCase() === name.toLowerCase()
	)
}

function addGroup(): void {
	const input = window.prompt(
		'Enter a group name beginning with P, A or E.\nExample: E_Goblin Reinforcements',
		'E_New Group'
	)

	if (input === null) return

	const group = validateGroupName(input)

	if (!group) {
		window.alert('Group names must begin with P, A or E and contain a name.')
		return
	}

	if (groupAlreadyExists(group)) {
		window.alert('A group with that name already exists.')
		return
	}

	groups.push(group)
	void persistSceneState()
}

function renameGroup(oldGroup: string): void {
	// Ungrouped is a permanent system group
	if (oldGroup === 'Ungrouped') return

	const input = window.prompt(
		'Enter the new group name. Prefix must remain P, A or E.',
		oldGroup
	)

	if (input === null) return

	const newGroup = validateGroupName(input)

	if (!newGroup) {
		window.alert('Group names must begin with P, A or E and contain a name.')
		return
	}

	if (groupAlreadyExists(newGroup, oldGroup)) {
		window.alert('A group with that name already exists.')
		return
	}

	const index = groups.indexOf(oldGroup)

	if (index === -1) return

	groups[index] = newGroup

	// Update every character belonging to the renamed group
	for (const character of characters) {
		if (character.group === oldGroup) {
			character.group = newGroup
		}
	}

	void Promise.all(
		characters
			.filter(character => character.group === newGroup)
			.map(character => persistCharacter(character))
	)

	void persistSceneState()
}

async function deleteGroup(group: string): Promise<void> {
	if (group === 'Ungrouped' || combatActive) return

	const members = characters.filter(
		character => character.group === group
	)

	const confirmed = window.confirm(
		`Delete "${getGroupLabel(group)}" and deactivate its ${members.length} character(s)?`
	)

	if (!confirmed) return

	const tokenIds = members
		.map(character => characterToToken.get(character))
		.filter((id): id is string => Boolean(id))

	await removeTokensFromTurnkeeper(tokenIds)

	const index = groups.indexOf(group)

	if (index !== -1) {
		groups.splice(index, 1)
	}

	await persistSceneState()
	render()
}


// Rendering

// Render each character card in the order
function renderCharacterCard(character: Character): string {
	const index = characters.indexOf(character)
	const isActive = character === activeCharacter

	const canEdit = canEditCharacter(character)
	const category = getGroupCategory(character.group)

	// An unowned enemy is identifiable, but its numerical stats remain hidden.
	const restrictedEnemy =
		currentUserRole === 'PLAYER' &&
		!canEdit &&
		(category === 'E' || category === 'U')

	// Shared character information.
	const hp = Math.max(0, character.hp)
	const tempHp = Math.max(0, character.tempHp)
	const maxHp = Math.max(0, character.maxHp)
	const totalHp = hp + tempHp

	const hpPercent = maxHp > 0
		? Math.min(100, (hp / maxHp) * 100)
		: 0

	const hpColour =
		hpPercent > 50 ? 'healthy' :
		hpPercent > 10 ? 'wounded' : 'critical'

	const totalBarPercent = maxHp > 0
		? Math.min(100, (totalHp / maxHp) * 100)
		: 0

	const hpBarPercent = totalHp > 0
		? totalBarPercent * (hp / totalHp)
		: 0

	const tempBarPercent = totalHp > 0
		? totalBarPercent * (tempHp / totalHp)
		: 0

	const initiative = initiativeRolls.get(character)
	const initiativeBonus = getInitiativeBonus(character)
	const condition = conditions.get(character) ?? ''

	const avatar = getCharacterAvatarContent(character)

	const hpBar = `
		<div class="hp-track">
			<div
				class="hp-fill ${hpColour}"
				style="width: ${hpBarPercent}%"
			></div>
			<div
				class="hp-fill hp-temporary"
				style="width: ${tempBarPercent}%"
			></div>
		</div>
	`

	const conditionDisplay = condition
		? `
			<div class="readonly-condition">
				<span>STATUS</span>
				<strong>${escapeHtml(condition)}</strong>
			</div>
		`
		: ''

	const initiativeDisplay = `
		<div class="initiative-result readonly-initiative">
			<span>INIT</span>
			<strong>${initiative ?? '—'}</strong>
		</div>
	`

	// -------------------------------------------------------------------------
	// ENEMY: identifiable, but without numerical stats.
	// -------------------------------------------------------------------------

	if (restrictedEnemy) {
		return `
			<article class="character-card readonly-card enemy-readonly-card ${isActive ? 'active' : ''}">
				<div class="character-avatar readonly-avatar">
					${avatar}
				</div>

				<div class="readonly-character-info">
					<div class="readonly-card-heading">
						<h3>${escapeHtml(character.name)}</h3>
					</div>

					${hpBar}
					${conditionDisplay}
				</div>

				${initiativeDisplay}
			</article>
		`
	}

	// -------------------------------------------------------------------------
	// FRIENDLY / ALLY: full information, read-only for other players.
	// -------------------------------------------------------------------------

	if (!canEdit) {
		return `
			<article class="character-card readonly-card readonly-detailed-card ${isActive ? 'active' : ''}">
				<div class="character-avatar readonly-avatar">
					${avatar}
				</div>

				<div class="character-information">
					<div class="character-heading">
						<h3>${escapeHtml(character.name)}</h3>

						<span class="group-tag">
							${escapeHtml(getGroupLabel(character.group))}
						</span>
					</div>

					<div class="character-stats">
						<div class="character-stat hp-stat">
							<span>HP</span>
							<strong>${hp}</strong>
						</div>

						<div class="character-stat maxhp-stat">
							<span>MAX</span>
							<strong>${maxHp}</strong>
						</div>

						<div class="character-stat temp-stat">
							<span>TEMP</span>
							<strong>${tempHp}</strong>
						</div>

						<div class="character-stat ac-stat">
							<span>AC</span>
							<strong>${character.ac}</strong>
						</div>
					</div>

					${hpBar}
					${conditionDisplay}
				</div>

				${initiativeDisplay}
			</article>
		`
	}

	// -------------------------------------------------------------------------
	// GM / OWNER: full editable card.
	// -------------------------------------------------------------------------

	return `
		<article class="character-card ${isActive ? 'active' : ''}">
			<div
				class="character-avatar"
				draggable="${currentUserRole === 'GM' && !combatActive}"
				data-index="${index}"
				title="${combatActive ? '' : 'Drag to move between groups'}"
			>
				${avatar}
			</div>

			<div class="character-information">
				<div class="character-heading">
					<input
						class="name-input"
						type="text"
						value="${escapeHtml(character.name)}"
						data-field="name"
						data-index="${index}"
						aria-label="Character name"
						title="Character name"
					/>

					<span class="group-tag">
						${escapeHtml(getGroupLabel(character.group))}
					</span>
				</div>

				<div class="character-stats">
					<label class="character-stat hp-stat">
						<span>HP</span>
						<input
							type="text"
							inputmode="text"
							autocomplete="off"
							value="${character.hp}"
							data-field="hp"
							data-index="${index}"
							aria-label="Current HP"
							title="Enter HP or an adjustment (e.g. 85+20 or -10)"
						/>
					</label>

					<label class="character-stat maxhp-stat">
						<span>MAX</span>
						<input
							type="number"
							min="0"
							value="${character.maxHp}"
							data-field="maxHp"
							data-index="${index}"
							aria-label="Maximum HP"
						/>
					</label>

					<label class="character-stat temp-stat">
						<span>TEMP</span>
						<input
							type="number"
							min="0"
							value="${character.tempHp}"
							data-field="tempHp"
							data-index="${index}"
							aria-label="Temporary HP"
						/>
					</label>

					<label class="character-stat ac-stat">
						<span>AC</span>
						<input
							type="number"
							min="0"
							value="${character.ac}"
							data-field="ac"
							data-index="${index}"
							aria-label="Armour Class"
						/>
					</label>
				</div>

				${hpBar}

				<div class="condition-row">
					<label for="condition-${index}">STATUS</label>
					<input
						id="condition-${index}"
						type="text"
						value="${escapeHtml(condition)}"
						placeholder="No condition"
						data-field="condition"
						data-index="${index}"
						aria-label="Status condition"
					/>
				</div>

				<div class="assignment-row">
					<label>OWNER</label>
					<span class="owner-value">
						${escapeHtml(getCharacterOwnerLabel(character))}
					</span>
				</div>
			</div>

			<div class="initiative-control">
				<label for="initiative-${index}">INIT</label>

				<input
					id="initiative-${index}"
					class="initiative-input"
					type="number"
					value="${initiative ?? ''}"
					placeholder="—"
					data-field="initiative"
					data-index="${index}"
					aria-label="Initiative result"
				/>

				<span class="initiative-bonus">
					${initiativeBonus >= 0 ? '+' : ''}${initiativeBonus}
				</span>

				${!combatActive ? `
					<button
						class="roll-button"
						data-action="roll-character"
						data-index="${index}"
					>Roll</button>
				` : ''}
			</div>
		</article>
	`
}

// Draw HUD on token with needed information
async function updateTokenDrawing(character: Character): Promise<void> {
	const tokenId = characterToToken.get(character)

	if (!tokenId) return

	try {
		await drawToken(tokenId, {
			hp: character.hp,
			maxHp: character.maxHp,
			tempHp: character.tempHp,
			ac: character.ac,
			condition: conditions.get(character) ?? '',
			isCurrentTurn: activeCharacter === character,
			isEnemy: ['E', 'U'].includes(getGroupCategory(character.group))
		})
	} catch (error) {
		console.error('Failed to draw token:', error)
	}
}

async function removeTokensFromTurnkeeper(tokenIds: string[]): Promise<void> {
	if (currentUserRole !== 'GM') return

	for (const tokenId of tokenIds) {
		// Change only the tracking flag. All character attributes remain saved.
		const updated = await setCharacterTracked(tokenId, false)

		if (!updated) {
			console.warn(`Could not deactivate Turnkeeper data for ${tokenId}.`)
		}

		// Remove the local representation and encounter-only information.
		removeLocalCharacter(tokenId)

		// Remove the visible overlays, but not the underlying Owlbear token.
		await clearTokenDrawing(tokenId)
	}

	await persistSceneState()
	await updateAllTokenDrawings()

	render()
}

// Render the groups
function renderGroup(
	group: string,
	members: Character[],
	redacted = false
): string {
	const isSystemGroup = group === 'Ungrouped'
	const encodedGroup = encodeURIComponent(group)

	return `
		<section
			class="character-group"
			data-group="${encodedGroup}"
		>
			<div class="group-heading">
				<div class="group-title">
					${!redacted ? `
						<span class="group-category ${getGroupCategory(group).toLowerCase()}">
							${getGroupCategory(group)}
						</span>
					` : ''}

					<h2>${redacted ? 'Enemies' : escapeHtml(getGroupLabel(group))}</h2>

					${!redacted ? `<span class="group-count">${members.length}</span>` : ''}
				</div>

				<div class="group-actions">
				${currentUserRole === 'GM' ? `
					${!redacted ? `
						${!isSystemGroup ? `
							<button
								class="group-action-button"
								data-action="rename-group"
								data-group="${encodedGroup}"
								title="Rename group"
							>Rename</button>

							<button
								class="group-action-button delete"
								data-action="delete-group"
								data-group="${encodedGroup}"
								title="Delete group and its characters"
							>Delete</button>
						` : `
							<span class="system-group-label">SYSTEM</span>
						`}
					` : ''}

					${!combatActive && members.length > 0 ? `
						<button
							class="group-roll-button"
							data-action="roll-group"
							data-group="${encodedGroup}"
						>Roll Group</button>
					` : ''}
				` : ''}
			</div>
			</div>

			<div class="character-list">
				${members.map(renderCharacterCard).join('')}
			</div>
		</section>
	`
}

async function updateAllTokenDrawings(): Promise<void> {
	await Promise.all(
		characters.map(character => updateTokenDrawing(character))
	)
}

function refreshTurnkeeperUI(): void {
	// Rebuild the sidebar from current in-memory data.
	render()

	// Only the GM should redraw shared scene overlays.
	if (currentUserRole === 'GM') {
		void updateAllTokenDrawings()
	}
}

// Main render function
function render(): void {
	// Preserve sidebar scroll position across renders
	const scrollPosition =
		app!.querySelector('.main-content')?.scrollTop ?? 0

	// Get user roles
	const gmMembers = roomMembers.filter(member => member.role === 'GM')
	const playerMembers = roomMembers.filter(member => member.role === 'PLAYER')

	const roleTooltip = roomMembers.map(member => {
		const name = member.isCurrentUser
			? `${currentUserName} (you)`
			: `User ${member.id.slice(0, 8)}`

		return `${name}: ${member.role}`
	}).join('\n')

	const roleTitle = currentUserRole === 'GM'
		? 'GM View'
		: currentUserRole === 'PLAYER'
			? 'Player View'
			: 'Connecting'

	const roleCounts = `${gmMembers.length} GM · ${playerMembers.length} P`

	const content = combatActive
		? `
			<section class="combat-order">
				<div class="section-heading">
					<h2>Initiative Order</h2>
					<span>${characters.length} combatants</span>
				</div>

				<div class="character-list">
					${getInitiativeOrder().map(renderCharacterCard).join('')}
				</div>
			</section>
		`
		: `
			<div class="group-list">
			${[...getDisplayGroups().entries()]
				.map(([group, members]) =>
					renderGroup(
						group,
						members.sort((a, b) =>
							a.name.localeCompare(b.name, undefined, {
								sensitivity: 'base'
							})
						),
						currentUserRole === 'PLAYER' && group === 'E_Enemies'
					)
				)
				.join('')}
		</div>
		`

	app!.innerHTML = `
		<div class="app-shell">
			<header class="app-header">
				<div class="brand">
					<div class="brand-icon">T</div>
					<div>
						<h1>Turnkeeper</h1>
						<span>Encounter Manager</span>
					</div>
				</div>
				<div class="header-status">
				<div class="preview-label" title="${escapeHtml(roleTooltip)}">
					<strong>${roleTitle}</strong>
					<span>${roleCounts}</span>
				</div>

				<button
					class="header-refresh-button"
					data-action="refresh-ui"
					title="Refresh display"
					aria-label="Refresh display"
				>↻</button>
			</div>
			</header>

			<section class="round-header">
				<div class="round-display">
					<span>ROUND</span>
					<strong>${String(currentRound).padStart(2, '0')}</strong>
				</div>

				${currentUserRole === 'GM' ? `
				<div class="combat-controls">
					<button
						class="control-button combat-toggle ${combatActive ? 'stop' : 'start'}"
						data-action="toggle-combat"
						title="${combatActive ? 'Stop combat' : 'Start combat'}"
						aria-label="${combatActive ? 'Stop combat' : 'Start combat'}"
					>${combatActive ? '■' : '⚔'}</button>

					<button
						class="control-button"
						data-action="previous-turn"
						${!combatActive ? 'disabled' : ''}
						title="Previous turn"
						aria-label="Previous turn"
					>‹</button>

					<button
						class="control-button"
						data-action="next-turn"
						${!combatActive ? 'disabled' : ''}
						title="Next turn"
						aria-label="Next turn"
					>›</button>
				</div>
				` : ''}
			</section>

			<main class="main-content">
				<div class="content-heading">
					<div>
						<h2>${combatActive ? 'Combatants' : 'Characters'}</h2>
						<p>${combatActive ? 'Currently in combat' : 'Manage your encounter'}</p>
					</div>

					<div class="content-actions">
						${currentUserRole === 'GM' && !combatActive ? `
							<button
								class="add-group-button"
								data-action="add-group"
							>+ Add Group</button>
						` : ''}

						<span class="character-count">${characters.length}</span>
					</div>
				</div>

				${content}
			</main>

			<footer class="app-footer">
				<span>Turnkeeper</span>
				<span>
					${currentUserRole === 'GM'
						? 'GM VIEW · Scene synchronised'
						: currentUserRole === 'PLAYER'
							? 'PLAYER VIEW · Scene synchronised'
							: 'CONNECTING TO OWLBEAR'}
				</span>
			</footer>
		</div>
	`

	// Restore scroll position
	const mainContent = app!.querySelector<HTMLElement>('.main-content')

	if (mainContent) {
		mainContent.scrollTop = scrollPosition
	}
}

// Editing character and encounter data
app.addEventListener('change', event => {

	const target = event.target

	if (!(target instanceof HTMLInputElement)) return

	const index = Number(target.dataset.index)
	const field = target.dataset.field
	const character = characters[index]

	if (!character || !field) return

	target.setCustomValidity('')
	if (!canEditCharacter(character)) return

	if (field === 'initiative') {
		if (target.value.trim() === '') {
			initiativeRolls.delete(character)
		} else {
			const value = target.valueAsNumber

			if (Number.isFinite(value)) {
				initiativeRolls.set(character, value)
			}
		}
	} else if (field === 'hp') {
		if (!applyHpInput(character, target.value)) {
			target.setCustomValidity(
				'Enter a number, +amount, -amount, or an expression starting with current HP.'
			)
			target.reportValidity()
			return
		}
	} else if (field === 'condition') {
		const condition = target.value.trim()

		if (condition) {
			conditions.set(character, condition)
		} else {
			conditions.delete(character)
		}
	} else if (
		field === 'name' ||
		field === 'attachedPlayer'
	) {
		character[field] = target.value
	} else if (
		field === 'maxHp' ||
		field === 'tempHp' ||
		field === 'ac'
	) {
		const value = target.valueAsNumber

		if (Number.isFinite(value)) {
			character[field] = Math.max(0, value)
		}

		if (field === 'maxHp') {
			character.hp = Math.min(character.hp, character.maxHp)
		}
	}

	if (field === 'initiative' || field === 'condition') {
		if (currentUserRole === 'GM') {
			void persistSceneState()
		} else {
			void persistOwnedEncounterState(character)
		}
	} else {
		void persistCharacter(character)
	}

	render()
	void updateTokenDrawing(character)
})


// Button interactions
app.addEventListener('click', event => {
	const target = event.target

	if (!(target instanceof Element)) return

	const button = target.closest<HTMLButtonElement>('[data-action]')

	if (!button) return

	const action = button.dataset.action

	switch (action) {
		case 'refresh-ui':
			refreshTurnkeeperUI()
		return
		case 'toggle-combat':
			if (combatActive) {
				stopCombat()
			} else {
				startCombat()
			}
			break

		case 'previous-turn':
			if (combatActive) changeTurn(-1)
			break

		case 'next-turn':
			if (combatActive) changeTurn(1)
			break

		case 'roll-character': {
			const character = characters[Number(button.dataset.index)]

			// Only the GM or the token's owner can roll it.
			if (!character || !canEditCharacter(character)) break

			rollCharacter(character)

			if (currentUserRole === 'GM') {
				void persistSceneState()
			} else {
				void persistOwnedEncounterState(character)
			}

			break
		}

		case 'roll-group': {
			const group = decodeURIComponent(button.dataset.group ?? '')

			for (const character of characters) {
				if (character.group === group) {
					rollCharacter(character)
				}
			}
			void persistSceneState()
			break
		}

		case 'toggle-combat':
			if (currentUserRole !== 'GM') break

			if (combatActive) {
				stopCombat()
			} else {
				startCombat()
			}
			break

		case 'previous-turn':
			if (currentUserRole === 'GM' && combatActive) {
				changeTurn(-1)
			}
			break

		case 'next-turn':
			if (currentUserRole === 'GM' && combatActive) {
				changeTurn(1)
			}
			break

		case 'roll-group': {
			if (currentUserRole !== 'GM') break

			const group = decodeURIComponent(button.dataset.group ?? '')

			for (const character of characters) {
				if (character.group === group) {
					rollCharacter(character)
				}
			}

			void persistSceneState()
			break
		}

		case 'add-group':
			if (currentUserRole === 'GM' && !combatActive) {
				addGroup()
			}
			break

		case 'rename-group': {
			if (currentUserRole !== 'GM' || combatActive) break

			const group = decodeURIComponent(button.dataset.group ?? '')
			renameGroup(group)
			break
		}

		case 'delete-group': {
			if (currentUserRole !== 'GM' || combatActive) break

			const group = decodeURIComponent(button.dataset.group ?? '')
			void deleteGroup(group)
			break
		}
	}

	render()
})

// Dragging characters to sort them into categories
app.addEventListener('dragstart', event => {
	if (currentUserRole !== 'GM') return
	const target = event.target

	if (!(target instanceof Element) || combatActive) return

	const handle = target.closest<HTMLElement>(
		'.character-avatar[draggable="true"]'
	)

	if (!handle) return

	const index = Number(handle.dataset.index)
	const character = characters[index]

	if (!character) return

	draggedCharacter = character

	event.dataTransfer?.setData('text/plain', String(index))

	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = 'move'
	}

	handle.closest('.character-card')?.classList.add('dragging')
})

app.addEventListener('dragover', event => {
	if (currentUserRole !== 'GM') return
	const target = event.target

	if (!(target instanceof Element)) return
	if (!draggedCharacter || combatActive) return

	const groupElement = target.closest<HTMLElement>('.character-group')

	if (!groupElement) return

	// Allow dropping onto this group
	event.preventDefault()

	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = 'move'
	}

	groupElement.classList.add('drag-over')
})

app.addEventListener('dragleave', event => {
	if (currentUserRole !== 'GM') return
	const target = event.target

	if (!(target instanceof Element)) return

	const groupElement = target.closest<HTMLElement>('.character-group')

	if (!groupElement) return

	// Don't remove highlighting when moving between children
	// inside the same group
	if (
		event.relatedTarget instanceof Node &&
		groupElement.contains(event.relatedTarget)
	) {
		return
	}

	groupElement.classList.remove('drag-over')
})

app.addEventListener('drop', event => {
	const target = event.target

	if (!(target instanceof Element)) return
	if (!draggedCharacter || combatActive) return

	const groupElement = target.closest<HTMLElement>('.character-group')

	if (!groupElement) return

	event.preventDefault()

	const destinationGroup = decodeURIComponent(
		groupElement.dataset.group ?? ''
	)

	if (!groups.includes(destinationGroup)) return

	// Move the character to the destination group
	draggedCharacter.group = destinationGroup
	void persistCharacter(draggedCharacter)
	void persistSceneState()
	draggedCharacter = null


	render()
})

app.addEventListener('dragend', () => {
	draggedCharacter = null

	app!.querySelectorAll('.drag-over').forEach(element => {
		element.classList.remove('drag-over')
	})

	app!.querySelectorAll('.dragging').forEach(element => {
		element.classList.remove('dragging')
	})
})

// Future statblock API integration (currently disabled)
//
// API: https://richard.keithsoft.com/GMG_Rep/api.php
//
// Test connectivity: ?request=-1
// Retrieve filename list: ?request=0
// Retrieve statblock: ?request=1&sb=[filename]
//
// Statblock filenames will be the unique identifiers.
// Character names will be matched against the filenames.
// No statblock ID needs to be stored on the token.

// Context menus for Turnkeeper
const EXTENSION_ID = TURNKEEPER_EXTENSION_ID

async function setupTurnkeeperContextMenu(): Promise<void> {
	// Add to Turnkeeper
	await OBR.contextMenu.create({
		id: `${EXTENSION_ID}/add-to-turnkeeper`,
		icons: [
			{
				icon: '/turnkeeper-add.svg',
				label: 'Add to Turnkeeper',
				filter: {
					roles: ['GM'],
					permissions: ['UPDATE'],
					every: [
						{ key: 'layer', value: 'CHARACTER' }
					]
				}
			}
		],
		async onClick(context) {
			const tokens = context.items.map(item => ({
				id: item.id,
				name: item.name
			}))

			await addTokensToTurnkeeper(tokens)
		}
	})

	// Remove from Turnkeeper
	await OBR.contextMenu.create({
		id: `${EXTENSION_ID}/remove-from-turnkeeper`,
		icons: [
			{
				icon: '/turnkeeper-remove.svg',
				label: 'Remove from Turnkeeper',
				filter: {
					roles: ['GM'],
					permissions: ['UPDATE'],
					every: [
						{ key: 'layer', value: 'CHARACTER' }
					]
				}
			}
		],
		async onClick(context) {
			const tokenIds = context.items.map(item => item.id)
			await removeTokensFromTurnkeeper(tokenIds)
		}
	})
}

// Retrieve the current user and everyone else in the room.
async function refreshRoomPresence(
	otherPlayers?: PartyPlayer[]
): Promise<void> {
	const [role, name, connectionId] = await Promise.all([
		OBR.player.getRole(),
		OBR.player.getName(),
		OBR.player.getConnectionId()
	])

	currentUserId = OBR.player.id

	const players = otherPlayers ?? await OBR.party.getPlayers()

	currentUserRole = role
	currentUserName = name

	roomMembers = [
		{
			id: OBR.player.id,
			connectionId,
			role,
			isCurrentUser: true
		},
		...players.map(player => ({
			id: player.id,
			connectionId: player.connectionId,
			role: player.role,
			isCurrentUser: false
		}))
	]

	console.log('Turnkeeper room members:', roomMembers)

	render()
}

// Start tracking changes to the room's membership and the current user's role.
async function setupRoomRoleTracking(): Promise<void> {
	OBR.party.onChange(players => {
		void refreshRoomPresence(players).catch(error => {
			console.error('Failed to update room members:', error)
		})
	})

	OBR.player.onChange(() => {
		void refreshRoomPresence().catch(error => {
			console.error('Failed to update current user:', error)
		})
	})

	await refreshRoomPresence()
}

render()

// Register the Owlbear context menus and do scene tracking only once the SDK is ready
if (OBR.isAvailable) {
	OBR.onReady(() => {
		void setupTurnkeeperContextMenu().catch(error => {
			console.error('Failed to register Turnkeeper context menus:', error)

			void OBR.notification.show(
				'Failed to register Turnkeeper context menus.',
				'ERROR'
			)
		})

		void setupTurnkeeperPersistence().catch(error => {
			console.error('Failed to initialise Turnkeeper persistence:', error)

			void OBR.notification.show(
				'Failed to initialise Turnkeeper persistence.',
				'ERROR'
			)
		})

		void setupRoomRoleTracking().catch(error => {
			console.error('Failed to initialise room role tracking:', error)

			void OBR.notification.show(
				'Failed to initialise room role tracking.',
				'ERROR'
			)
		})
	})
}