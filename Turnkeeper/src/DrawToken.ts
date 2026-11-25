import OBR, { buildShape, buildText } from '@owlbear-rodeo/sdk'

export interface TokenDisplayData {
	hp: number
	maxHp: number
	tempHp: number
	ac: number
	condition: string
	isCurrentTurn?: boolean
}

type ShapeType = 'RECTANGLE' | 'CIRCLE' | 'TRIANGLE' | 'HEXAGON'

const PREFIX = 'Turnkeeper/'

// Serialise drawing operations per token to prevent overlapping deletes/adds.
const tokenOperationQueues = new Map<string, Promise<void>>()

function enqueueTokenOperation(
	tokenId: string,
	operation: () => Promise<void>
): Promise<void> {
	const previous = tokenOperationQueues.get(tokenId) ?? Promise.resolve()

	const current = previous
		.catch(() => undefined)
		.then(operation)

	tokenOperationQueues.set(tokenId, current)

	return current.finally(() => {
		if (tokenOperationQueues.get(tokenId) === current) {
			tokenOperationQueues.delete(tokenId)
		}
	})
}

const COLOURS = {
	healthy: '#55bd78',
	wounded: '#e6a23c',
	critical: '#df555b',
	temporary: '#399bd7',
	barBackground: '#656565',
	textBackground: '#555555',
	shield: '#34465e',
	shieldBorder: '#8ba9ce',
	text: '#ffffff'
}

// All positioning and sizing values are configurable here
// Most dimensions and margins are multipliers of the token's dimensions
const LAYOUT = {
	// HP bar
	hpBar: {
		width: 0.92,
		height: 0.19,
		bottomMargin: 0.025,
		inset: 0.01,
		minHeight: 10
	},

	// HP text
	hpText: {
		fontSize: 0.56,
		minFontSize: 7,
		maxFontSize: 18,
		width: 0.82,
		charWidth: 0.56,
		strokeWidth: 1,
		textOffsetX: -0.35,
		textOffsetY: -0.09
	},

	// AC shield
	ac: {
		width: 0.26,
		height: 0.29,
		rightMargin: -0.10,
		topMargin: 0.15,
		textOffsetX: -0.23,
		textOffsetY: -0.22,
		textWidth: 0.75,
		textHeight: 0.55,
		textFontSize: 0.09,
		minFontSize: 8,
		maxFontSize: 18
	},

	// Condition label
	condition: {
		width: 0.56,
		height: 0.13,
		leftMargin: 0.035,
		topMargin: 0.035,
		textOffsetX: -0.25,
		textOffsetY: -0.06,
		maxFontSize: 14,
		minFontSize: 7,
		charWidth: 0.56,
		background: '#454545',
		strokeWidth: 1
	},

	// Current Turn Highlight
	turnHighlight: {
		color: '#ffd54a',
		inset: 0.045,
		strokeWidth: 0.025
	}
}

function getHpColour(hp: number, maxHp: number): string {
	const percentage = maxHp > 0 ? (hp / maxHp) * 100 : 0

	if (percentage > 50) return COLOURS.healthy
	if (percentage > 10) return COLOURS.wounded
	return COLOURS.critical
}

function createShape(
	tokenId: string,
	name: string,
	centerX: number,
	centerY: number,
	width: number,
	height: number,
	fill: string,
	zIndex: number,
	stroke: string = fill,
	shapeType: ShapeType = 'RECTANGLE',
	strokeWidth: number = 1,
	fillOpacity: number = 1
) {
	return buildShape()
		.name(`${PREFIX}${tokenId}/${name}`)
		.shapeType(shapeType)
		.width(width)
		.height(height)
		.position({
			x: centerX - width / 2,
			y: centerY - height / 2
		})
		.fillColor(fill)
		.fillOpacity(fillOpacity)
		.strokeColor(stroke)
		.strokeOpacity(1)
		.strokeWidth(strokeWidth)
		.zIndex(zIndex)
		.disableAutoZIndex(true)
		.attachedTo(tokenId)
		.layer('ATTACHMENT')
		.locked(true)
		.disableHit(true)
		.build()
}

function createText(
	tokenId: string,
	name: string,
	value: string,
	centerX: number,
	centerY: number,
	width: number,
	height: number,
	fontSize: number,
	zIndex: number,
	strokeWidth: number = 0
) {
	return buildText()
		.name(`${PREFIX}${tokenId}/${name}`)
		.plainText(value)
		.textType('PLAIN')
		.position({ x: centerX, y: centerY })
		.width(width)
		.height(height)
		.fontSize(fontSize)
		.fontWeight(700)
		.textAlign('CENTER')
		.textAlignVertical('MIDDLE')
		.padding(0)
		.fillColor(COLOURS.text)
		.strokeColor('#222222')
		.strokeOpacity(strokeWidth > 0 ? 1 : 0)
		.strokeWidth(strokeWidth)
		.zIndex(zIndex)
		.disableAutoZIndex(true)
		.attachedTo(tokenId)
		.layer('ATTACHMENT')
		.locked(true)
		.disableHit(true)
		.build()
}

async function drawTokenNow(
	tokenId: string,
	data: TokenDisplayData
): Promise<void> {
	const bounds = await OBR.scene.items.getItemBounds([tokenId])
	if (!bounds) return

	const left = bounds.min.x
	const right = bounds.max.x
	const top = bounds.min.y
	const bottom = bounds.max.y
	const centerX = bounds.center.x

	const tokenWidth = bounds.width
	const tokenHeight = bounds.height
	const minDimension = Math.min(tokenWidth, tokenHeight)

	if (tokenWidth <= 0 || tokenHeight <= 0) return

	// Remove any existing drawing
	const attachments = await OBR.scene.items.getItemAttachments([tokenId])

	const oldItems = attachments.filter(item =>
		item.name.startsWith(`${PREFIX}${tokenId}/`)
	)

	if (oldItems.length > 0) {
		await OBR.scene.items.deleteItems(oldItems.map(item => item.id))
	}

	// Find the highest existing attachment z-index.
	const sceneItems = await OBR.scene.items.getItems()

	let nextZIndex = sceneItems.reduce((highest, item) => {
		return item.layer === 'ATTACHMENT'
			? Math.max(highest, item.zIndex)
			: highest
	}, 0) + 1

	const getZIndex = () => nextZIndex++

	const items = []

	// Current Turn Highlight
	if (data.isCurrentTurn) {
		const highlightStrokeWidth = Math.max(
			2,
			minDimension * LAYOUT.turnHighlight.strokeWidth
		)

		// Account for half the stroke width so it remains inside the token.
		const highlightInset =
			minDimension * LAYOUT.turnHighlight.inset +
			highlightStrokeWidth / 2

		const highlightWidth = tokenWidth - highlightInset * 2
		const highlightHeight = tokenHeight - highlightInset * 2

		items.push(createShape(
			tokenId,
			'TurnHighlight',
			centerX,
			bounds.center.y,
			highlightWidth,
			highlightHeight,
			LAYOUT.turnHighlight.color,
			getZIndex(),
			LAYOUT.turnHighlight.color,
			'RECTANGLE',
			highlightStrokeWidth,
			0
		))
	}

	// HP Bar
	const barWidth = tokenWidth * LAYOUT.hpBar.width

	const barHeight = Math.max(
		LAYOUT.hpBar.minHeight,
		minDimension * LAYOUT.hpBar.height
	)

	const barCenterY =
		bottom -
		barHeight / 2 -
		minDimension * LAYOUT.hpBar.bottomMargin

	const barLeft = centerX - barWidth / 2

	const normalHp = Math.max(0, data.hp)
	const temporaryHp = Math.max(0, data.tempHp)
	const maximumHp = Math.max(0, data.maxHp)
	const totalHp = normalHp + temporaryHp

	const barInset = Math.max(
		1,
		minDimension * LAYOUT.hpBar.inset
	)

	const innerBarWidth = Math.max(0, barWidth - barInset * 2)
	const innerBarHeight = Math.max(1, barHeight - barInset * 2)

	const totalPercentage = maximumHp > 0
		? Math.min(1, totalHp / maximumHp)
		: 0

	const totalFillWidth = innerBarWidth * totalPercentage

	const normalWidth = totalHp > 0
		? totalFillWidth * normalHp / totalHp
		: 0

	const temporaryWidth = totalHp > 0
		? totalFillWidth * temporaryHp / totalHp
		: 0

	// Grey background representing the depleted portion of the bar
	// This MUST be rendered before the coloured HP segments
	items.push(createShape(
		tokenId,
		'HPBackground',
		centerX,
		barCenterY,
		barWidth,
		barHeight,
		COLOURS.barBackground,
		getZIndex(),
		'#222222',
		'RECTANGLE',
		Math.max(1, minDimension * 0.012)
	))

	// Normal HP segment
	if (normalWidth > 0) {
		const normalCenterX =
			barLeft + barInset + normalWidth / 2

		items.push(createShape(
			tokenId,
			'HPNormal',
			normalCenterX,
			barCenterY,
			normalWidth,
			innerBarHeight,
			getHpColour(normalHp, maximumHp),
			getZIndex()
		))
	}

	// Temporary HP segment
	if (temporaryWidth > 0) {
		const temporaryCenterX =
			barLeft + barInset + normalWidth + temporaryWidth / 2

		items.push(createShape(
			tokenId,
			'HPTemporary',
			temporaryCenterX,
			barCenterY,
			temporaryWidth,
			innerBarHeight,
			COLOURS.temporary,
			getZIndex()
		))
	}

	// HP text, drawn over the bar
	const hpText = temporaryHp > 0
		? `${normalHp}/${maximumHp} (+${temporaryHp})`
		: `${normalHp}/${maximumHp}`

	const availableTextWidth = barWidth * LAYOUT.hpText.width

	const maxFontSize = Math.min(
		LAYOUT.hpText.maxFontSize,
		barHeight * LAYOUT.hpText.fontSize
	)

	const maxWidthFontSize =
		availableTextWidth /
		(hpText.length * LAYOUT.hpText.charWidth)

	const hpFontSize = Math.max(
		LAYOUT.hpText.minFontSize,
		Math.min(maxFontSize, maxWidthFontSize)
	)

	items.push(createText(
		tokenId,
		'HPText',
		hpText,
		centerX + minDimension * LAYOUT.hpText.textOffsetX,
		barCenterY + minDimension * LAYOUT.hpText.textOffsetY,
		availableTextWidth,
		barHeight,
		hpFontSize,
		getZIndex(),
		LAYOUT.hpText.strokeWidth
	))

	// AC Shield
	const shieldWidth = minDimension * LAYOUT.ac.width
	const shieldHeight = minDimension * LAYOUT.ac.height

	const shieldCenterX =
		right -
		minDimension * LAYOUT.ac.rightMargin -
		shieldWidth / 2

	const shieldCenterY =
		top +
		minDimension * LAYOUT.ac.topMargin +
		shieldHeight / 2

	items.push(createShape(
		tokenId,
		'ACShield',
		shieldCenterX,
		shieldCenterY,
		shieldWidth,
		shieldHeight,
		COLOURS.shield,
		getZIndex(),
		COLOURS.shieldBorder,
		'HEXAGON',
		Math.max(1, minDimension * 0.012)
	))

	const acTextCenterX =
		shieldCenterX + minDimension * LAYOUT.ac.textOffsetX

	const acTextCenterY =
		shieldCenterY + minDimension * LAYOUT.ac.textOffsetY

	items.push(createText(
		tokenId,
		'ACValue',
		String(data.ac),
		acTextCenterX,
		acTextCenterY,
		shieldWidth * LAYOUT.ac.textWidth,
		shieldHeight * LAYOUT.ac.textHeight,
		Math.max(
			LAYOUT.ac.minFontSize,
			Math.min(
				LAYOUT.ac.maxFontSize,
				minDimension * LAYOUT.ac.textFontSize
			)
		),
		getZIndex()
	))

	// Condition
	const condition = data.condition.trim()

	if (condition) {
		const conditionWidth = tokenWidth * LAYOUT.condition.width
		const conditionHeight = minDimension * LAYOUT.condition.height

		const conditionCenterX =
			left +
			minDimension * LAYOUT.condition.leftMargin +
			conditionWidth / 2

		const conditionCenterY =
			top +
			minDimension * LAYOUT.condition.topMargin +
			conditionHeight / 2

		const conditionFontSize = Math.max(
			LAYOUT.condition.minFontSize,
			Math.min(
				LAYOUT.condition.maxFontSize,
				conditionHeight * 0.58,
				(conditionWidth * 0.88) /
				(condition.length * LAYOUT.condition.charWidth)
			)
		)

		// Grey background behind the condition text
		items.push(createShape(
			tokenId,
			'ConditionBackground',
			conditionCenterX,
			conditionCenterY,
			conditionWidth,
			conditionHeight,
			LAYOUT.condition.background,
			getZIndex()
		))

		// Condition text on top of its background
		items.push(createText(
			tokenId,
			'Condition',
			condition,
			conditionCenterX + minDimension * LAYOUT.condition.textOffsetX,
			conditionCenterY + minDimension * LAYOUT.condition.textOffsetY,
			conditionWidth,
			conditionHeight,
			conditionFontSize,
			getZIndex(),
			LAYOUT.condition.strokeWidth
		))
	}

	// Add all items in their assigned drawing order
	await OBR.scene.items.addItems(items)
}

// Clear drawing
async function clearTokenDrawingNow(tokenId: string): Promise<void> {
	const attachments = await OBR.scene.items.getItemAttachments([tokenId])

	const oldItems = attachments.filter(item =>
		item.name.startsWith(`${PREFIX}${tokenId}/`)
	)

	if (oldItems.length > 0) {
		await OBR.scene.items.deleteItems(oldItems.map(item => item.id))
	}
}

// Public drawing functions. All operations for a given token are queued.
export function drawToken(
	tokenId: string,
	data: TokenDisplayData
): Promise<void> {
	return enqueueTokenOperation(
		tokenId,
		() => drawTokenNow(tokenId, data)
	)
}

export function clearTokenDrawing(tokenId: string): Promise<void> {
	return enqueueTokenOperation(
		tokenId,
		() => clearTokenDrawingNow(tokenId)
	)
}