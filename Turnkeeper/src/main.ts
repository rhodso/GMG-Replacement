
import OBR from '@owlbear-rodeo/sdk'
import './style.css'
import { drawToken, clearTokenDrawing } from './DrawToken'

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

async function addTokensToTurnkeeper( tokens: TokenReference[] ): Promise<void> {
	if (tokens.length === 0) return

	let filenames: string[]

	try { // Retrieve the list once, even when multiple tokens are selected
		filenames = await getStatblockList()
	} catch (error) {
		// On fail
		console.error('Failed to retrieve statblock list:', error)
		await OBR.notification.show( 'Unable to retrieve statblocks.', 'ERROR' )
		return
	}

	// If no files
	if (filenames.length === 0) {
		await OBR.notification.show( 'No statblocks are available.', 'WARNING' )
		return
	}

	let added = 0
	const failures: string[] = []
	const alreadyAdded: string[] = []

	for (const token of tokens) {
		const tokenName = token.name.trim()

		if (!tokenName) {
			failures.push('Unnamed token')
			continue
		}

		// Don't add a token that's already registered.
		if (tokenToCharacter.has(token.id)) {
			alreadyAdded.push(tokenName)
			continue
		}

		// Find the closest statblock filename.
		const match = findClosestStatblock(tokenName, filenames)

		if (!match) {
			failures.push(tokenName)
			continue
		}

		// Retrieve the actual statblock.
		const statblock = await getStatblock(match.filename)

		if (!statblock) {
			failures.push(tokenName)
			continue
		}

		// Create the character using the token's name.
		const character: Character = {
			name: statblock.name || tokenName,
			hp: statblock.HP,
			maxHp: statblock.MxHP,
			tempHp: statblock.TmpHP,
			ac: statblock.AC,
			group: statblock.Group || 'Ungrouped',
			attachedPlayer: statblock.AttachedPlayer || ''
		}

		// Add the character to the application.
		characters.push(character)

		// Store initiative bonus separately from character data.
		initiativeBonuses.set( character,  statblock.initiativeBonus ?? 0 )

		// Remember which Owlbear token this character belongs to.
		tokenToCharacter.set(token.id, character)
		characterToToken.set(character, token.id)

		tokenToCharacter.set(token.id, character)
		characterToToken.set(character, token.id)

		await updateTokenDrawing(character)

		added++
	}

	render()

	// Report the results
	if (added > 0) {
		await OBR.notification.show(
			`Added ${added} character${added === 1 ? '' : 's'} to Turnkeeper.`,
			failures.length > 0 || alreadyAdded.length > 0
				? 'WARNING'
				: 'SUCCESS'
		)
	}

	if (failures.length > 0) {
		console.warn('No matching statblock found for:', failures)

		await OBR.notification.show(
			`No matching statblock found for: ${failures.join(', ')}`,
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
}

// When combat stops
function stopCombat(): void {
	combatActive = false
	currentRound = 1
	activeCharacter = null
	initiativeRolls.clear()
  	conditions.clear()
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
}

function deleteGroup(group: string): void {
	// Ungrouped is a permanent system group
	if (group === 'Ungrouped' || combatActive) return

	const members = characters.filter(
		character => character.group === group
	)

	const confirmed = window.confirm(
		`Delete "${getGroupLabel(group)}" and all ${members.length} character(s) inside it?`
	)

	if (!confirmed) return

	// Remove characters and their temporary encounter data
	for (let i = characters.length - 1; i >= 0; i--) {
		const character = characters[i]

		if (character.group !== group) continue

		initiativeRolls.delete(character)
		conditions.delete(character)

		if (activeCharacter === character) {
			activeCharacter = null
		}

		const tokenId = characterToToken.get(character)

		if (tokenId) {
			tokenToCharacter.delete(tokenId)
		}

		characterToToken.delete(character)

		if (tokenId) {
			void clearTokenDrawing(tokenId)
		}

		characters.splice(i, 1)
	}

	// Remove the group definition
	const index = groups.indexOf(group)

	if (index !== -1) {
		groups.splice(index, 1)
	}

	void updateAllTokenDrawings()
}


// Rendering

// Render each character card in the order
function renderCharacterCard(character: Character): string {
	const index = characters.indexOf(character)
	const isActive = character === activeCharacter

	// Calculate normal and temporary HP
	const hp = Math.max(0, character.hp)
	const tempHp = Math.max(0, character.tempHp)
	const maxHp = Math.max(0, character.maxHp)
	const totalHp = hp + tempHp

	// Determine health colour using normal HP only
	const hpPercent = maxHp > 0
		? Math.min(100, (hp / maxHp) * 100)
		: 0

	const hpColour =
		hpPercent > 50 ? 'healthy' :
		hpPercent > 10 ? 'wounded' : 'critical'

	// Calculate combined HP bar width
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

	return `
		<article class="character-card ${isActive ? 'active' : ''}">
			<div
				class="character-avatar"
				draggable="${!combatActive}"
				data-index="${index}"
				title="${combatActive ? '' : 'Drag to move between groups'}"
			>
				${escapeHtml(character.name.charAt(0).toUpperCase() || '?')}
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
					<label for="player-${index}">PLAYER</label>
					<input
						id="player-${index}"
						type="text"
						value="${escapeHtml(character.attachedPlayer)}"
						placeholder="Unassigned"
						data-field="attachedPlayer"
						data-index="${index}"
						aria-label="Attached player"
					/>
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
			isCurrentTurn: activeCharacter === character
		})
	} catch (error) {
		console.error('Failed to draw token:', error)
	}
}

async function removeTokensFromTurnkeeper(tokenIds: string[]): Promise<void> {
	const tokensToClear: string[] = []
	let activeCharacterRemoved = false

	for (const tokenId of tokenIds) {
		const character = tokenToCharacter.get(tokenId)

		// Ignore tokens that aren't currently tracked.
		if (!character) continue

		tokensToClear.push(tokenId)

		// Remove the character from our tracking maps.
		tokenToCharacter.delete(tokenId)
		characterToToken.delete(character)

		// Remove encounter-specific data.
		initiativeRolls.delete(character)
		initiativeBonuses.delete(character)
		conditions.delete(character)

		// Remove the character from the main character list.
		const index = characters.indexOf(character)
		if (index !== -1) {
			characters.splice(index, 1)
		}

		// Clear the active turn if this character had it.
		if (activeCharacter === character) {
			activeCharacter = null
			activeCharacterRemoved = true
		}
	}

	// Remove all Turnkeeper drawings from the affected tokens.
	await Promise.all(tokensToClear.map(tokenId => clearTokenDrawing(tokenId)))

	// Refresh the remaining drawings if the active character was removed.
	if (activeCharacterRemoved) {
		await Promise.all(characters.map(character => updateTokenDrawing(character)))
	}

	render()
}

// Render the groups
function renderGroup(group: string, members: Character[]): string {
	const isSystemGroup = group === 'Ungrouped'
	const encodedGroup = encodeURIComponent(group)

	return `
		<section
			class="character-group"
			data-group="${encodedGroup}"
		>
			<div class="group-heading">
				<div class="group-title">
					<span class="group-category ${getGroupCategory(group).toLowerCase()}">
						${getGroupCategory(group)}
					</span>

					<h2>${escapeHtml(getGroupLabel(group))}</h2>
					<span class="group-count">${members.length}</span>
				</div>

				<div class="group-actions">
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

					${!combatActive && members.length > 0 ? `
						<button
							class="group-roll-button"
							data-action="roll-group"
							data-group="${encodedGroup}"
						>Roll Group</button>
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

// Main render function
function render(): void {
	// Preserve sidebar scroll position across renders
	const scrollPosition =
		app!.querySelector('.main-content')?.scrollTop ?? 0

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
				${[...getGroupedCharacters().entries()]
					.map(([group, members]) =>
						renderGroup(
							group,
							members.sort((a, b) =>
                a.name.localeCompare(b.name, undefined, {
                  sensitivity: 'base'
                })
              )
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
				<span class="preview-label">PREVIEW</span>
			</header>

			<section class="round-header">
				<div class="round-display">
					<span>ROUND</span>
					<strong>${String(currentRound).padStart(2, '0')}</strong>
				</div>

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
			</section>

			<main class="main-content">
				<div class="content-heading">
					<div>
						<h2>${combatActive ? 'Combatants' : 'Characters'}</h2>
						<p>${combatActive ? 'Currently in combat' : 'Manage your encounter'}</p>
					</div>

					<div class="content-actions">
						${!combatActive ? `
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
				<span>Sample data · Not connected to Owlbear</span>
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

			if (character) {
				rollCharacter(character)
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
			break
		}

		case 'add-group':
			if (!combatActive) addGroup()
			break

		case 'rename-group': {
			if (combatActive) break

			const group = decodeURIComponent(button.dataset.group ?? '')
			renameGroup(group)
			break
		}

		case 'delete-group': {
			if (combatActive) break

			const group = decodeURIComponent(button.dataset.group ?? '')
			deleteGroup(group)
			break
		}
	}

	render()
})

// Dragging characters to sort them into categories
app.addEventListener('dragstart', event => {
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
const EXTENSION_ID = 'com.rhodso.turnkeeper'

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

render()

// Register the Owlbear context menus only once the SDK is ready
if (OBR.isAvailable) {
	OBR.onReady(() => {
		void setupTurnkeeperContextMenu().catch(error => {
			console.error('Failed to register Turnkeeper context menus:', error)

			void OBR.notification.show(
				'Failed to register Turnkeeper context menus.',
				'ERROR'
			)
		})
	})
}