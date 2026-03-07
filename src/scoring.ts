import type { DartMultiplier, LegResult, LegType, TeamSide } from './models'

const CRICKET_TARGETS = [15, 16, 17, 18, 19, 20, 25]

function createEmptyCricketMarks(): Record<string, number> {
  return {
    '15': 0,
    '16': 0,
    '17': 0,
    '18': 0,
    '19': 0,
    '20': 0,
    '25': 0,
  }
}

function initialX01Score(type: LegType): number {
  return type === 'x01-301' ? 301 : 501
}

function toFinite(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

function sanitizeSide(value: TeamSide | undefined): TeamSide {
  return value === 'B' ? 'B' : 'A'
}

function getDartLabel(value: number, multiplier: DartMultiplier): string {
  const prefix = multiplier === 1 ? 'S' : multiplier === 2 ? 'D' : 'T'
  if (value === 25) {
    return `${prefix}B`
  }
  return `${prefix}${value}`
}

function splitTurnDartsBySide(leg: LegResult, nextCurrentTurn: string[]): {
  currentTurnDarts: string[]
  lastTurnDartsA: string[]
  lastTurnDartsB: string[]
} {
  if (nextCurrentTurn.length < 3) {
    return {
      currentTurnDarts: nextCurrentTurn,
      lastTurnDartsA: leg.lastTurnDartsA ?? [],
      lastTurnDartsB: leg.lastTurnDartsB ?? [],
    }
  }

  if (leg.activeSide === 'A') {
    return {
      currentTurnDarts: [],
      lastTurnDartsA: nextCurrentTurn,
      lastTurnDartsB: leg.lastTurnDartsB ?? [],
    }
  }

  return {
    currentTurnDarts: [],
    lastTurnDartsA: leg.lastTurnDartsA ?? [],
    lastTurnDartsB: nextCurrentTurn,
  }
}

export function createInitialLeg(type: LegType): LegResult {
  const isX01 = type === 'x01-501' || type === 'x01-301'
  const score = isX01 ? initialX01Score(type) : 0
  return {
    type,
    scoreA: score,
    scoreB: score,
    activeSide: 'A',
    dartsInTurn: 0,
    turnStartScoreA: score,
    turnStartScoreB: score,
    cricketMarksA: createEmptyCricketMarks(),
    cricketMarksB: createEmptyCricketMarks(),
    currentTurnDarts: [],
    lastTurnDartsA: [],
    lastTurnDartsB: [],
    undoStack: [],
    winnerTeamId: undefined,
    isDone: false,
  }
}

export function normalizeLeg(raw: Partial<LegResult> & { type: LegType }): LegResult {
  const base = createInitialLeg(raw.type)
  const isX01 = raw.type === 'x01-501' || raw.type === 'x01-301'
  const legacyZeroStart =
    isX01 &&
    raw.scoreA === 0 &&
    raw.scoreB === 0 &&
    raw.turnStartScoreA === undefined &&
    raw.turnStartScoreB === undefined &&
    raw.activeSide === undefined

  const corruptedX01ZeroState =
    isX01 &&
    raw.scoreA === 0 &&
    raw.scoreB === 0 &&
    raw.isDone !== true &&
    raw.winnerTeamId === undefined

  const scoreA = toFinite(raw.scoreA, base.scoreA)
  const scoreB = toFinite(raw.scoreB, base.scoreB)
  const activeSide = raw.activeSide === 'B' ? 'B' : 'A'
  const dartsInTurn = Math.max(0, Math.min(2, toFinite(raw.dartsInTurn, base.dartsInTurn)))
  const mustResetX01 = legacyZeroStart || corruptedX01ZeroState
  const turnStartScoreA = toFinite(raw.turnStartScoreA, mustResetX01 ? base.scoreA : scoreA)
  const turnStartScoreB = toFinite(raw.turnStartScoreB, mustResetX01 ? base.scoreB : scoreB)
  const safeScoreA = mustResetX01 ? base.scoreA : scoreA
  const safeScoreB = mustResetX01 ? base.scoreB : scoreB

  return {
    ...base,
    ...raw,
    scoreA: safeScoreA,
    scoreB: safeScoreB,
    activeSide,
    dartsInTurn,
    turnStartScoreA,
    turnStartScoreB,
    cricketMarksA: {
      ...base.cricketMarksA,
      ...(raw.cricketMarksA ?? {}),
    },
    cricketMarksB: {
      ...base.cricketMarksB,
      ...(raw.cricketMarksB ?? {}),
    },
    currentTurnDarts: raw.currentTurnDarts ?? [],
    lastTurnDartsA: raw.lastTurnDartsA ?? [],
    lastTurnDartsB: raw.lastTurnDartsB ?? [],
    undoStack: raw.undoStack ?? [],
  }
}

function otherSide(side: TeamSide): TeamSide {
  return side === 'A' ? 'B' : 'A'
}

function canCloseCricket(marks: Record<string, number>): boolean {
  return CRICKET_TARGETS.every((target) => (marks[String(target)] ?? 0) >= 3)
}

function advanceTurn(leg: LegResult, forceEndTurn = false): LegResult {
  if (leg.isDone) {
    return leg
  }

  if (forceEndTurn) {
    const nextCurrent = leg.currentTurnDarts ?? []
    const turnDarts = splitTurnDartsBySide(leg, nextCurrent)
    const nextSide = otherSide(leg.activeSide)
    return {
      ...leg,
      ...turnDarts,
      activeSide: nextSide,
      dartsInTurn: 0,
      turnStartScoreA: nextSide === 'A' ? leg.scoreA : leg.turnStartScoreA,
      turnStartScoreB: nextSide === 'B' ? leg.scoreB : leg.turnStartScoreB,
    }
  }

  const nextDarts = leg.dartsInTurn + 1
  if (nextDarts < 3) {
    return {
      ...leg,
      dartsInTurn: nextDarts,
    }
  }

  const nextSide = otherSide(leg.activeSide)
  const turnDarts = splitTurnDartsBySide(leg, leg.currentTurnDarts ?? [])
  return {
    ...leg,
    ...turnDarts,
    activeSide: nextSide,
    dartsInTurn: 0,
    turnStartScoreA: nextSide === 'A' ? leg.scoreA : leg.turnStartScoreA,
    turnStartScoreB: nextSide === 'B' ? leg.scoreB : leg.turnStartScoreB,
  }
}

export function applyDartToLeg(
  leg: LegResult,
  teamIds: { A?: string; B?: string },
  value: number,
  multiplier: DartMultiplier,
): LegResult {
  if (leg.isDone) {
    return leg
  }

  const activeSide = sanitizeSide(leg.activeSide)
  const scoreA = toFinite(leg.scoreA, 0)
  const scoreB = toFinite(leg.scoreB, 0)
  const dartsInTurn = Math.max(0, Math.min(2, toFinite(leg.dartsInTurn, 0)))
  const turnStartScoreA = toFinite(leg.turnStartScoreA, scoreA)
  const turnStartScoreB = toFinite(leg.turnStartScoreB, scoreB)

  const undoStack = leg.undoStack ?? []
  const cricketMarksA = leg.cricketMarksA ?? createEmptyCricketMarks()
  const cricketMarksB = leg.cricketMarksB ?? createEmptyCricketMarks()

  const snapshot = {
    scoreA,
    scoreB,
    activeSide,
    dartsInTurn,
    turnStartScoreA,
    turnStartScoreB,
    cricketMarksA: { ...cricketMarksA },
    cricketMarksB: { ...cricketMarksB },
    currentTurnDarts: [...(leg.currentTurnDarts ?? [])],
    lastTurnDartsA: [...(leg.lastTurnDartsA ?? [])],
    lastTurnDartsB: [...(leg.lastTurnDartsB ?? [])],
    winnerTeamId: leg.winnerTeamId,
    isDone: leg.isDone,
  }

  const dartLabel = getDartLabel(value, multiplier)
  const nextCurrentTurnDarts = [...(leg.currentTurnDarts ?? []), dartLabel]

  let next: LegResult = {
    ...leg,
    scoreA,
    scoreB,
    activeSide,
    dartsInTurn,
    turnStartScoreA,
    turnStartScoreB,
    cricketMarksA,
    cricketMarksB,
    currentTurnDarts: nextCurrentTurnDarts,
    lastTurnDartsA: leg.lastTurnDartsA ?? [],
    lastTurnDartsB: leg.lastTurnDartsB ?? [],
    undoStack: [...undoStack, snapshot],
  }

  if (leg.type === 'x01-501' || leg.type === 'x01-301') {
    const points = Math.max(0, value) * multiplier

    if (activeSide === 'A') {
      const candidate = scoreA - points
      if (candidate < 0) {
        next = {
          ...next,
          scoreA: turnStartScoreA,
        }
        return advanceTurn(next, true)
      }
      if (candidate === 0) {
        return {
          ...next,
          scoreA: 0,
          isDone: true,
          winnerTeamId: teamIds.A,
        }
      }
      next = {
        ...next,
        scoreA: candidate,
      }
      return advanceTurn(next)
    }

    const candidate = scoreB - points
    if (candidate < 0) {
      next = {
        ...next,
        scoreB: turnStartScoreB,
      }
      return advanceTurn(next, true)
    }
    if (candidate === 0) {
      return {
        ...next,
        scoreB: 0,
        isDone: true,
        winnerTeamId: teamIds.B,
      }
    }
    next = {
      ...next,
      scoreB: candidate,
    }
    return advanceTurn(next)
  }

  const isTarget = CRICKET_TARGETS.includes(value)
  if (isTarget) {
    const key = String(value)

    if (activeSide === 'A') {
      const currentMarks = next.cricketMarksA[key] ?? 0
      const opponentMarks = next.cricketMarksB[key] ?? 0
      const applied = currentMarks + multiplier
      const extra = Math.max(0, applied - 3)

      next = {
        ...next,
        cricketMarksA: {
          ...next.cricketMarksA,
          [key]: Math.min(3, applied),
        },
      }

      if (extra > 0 && opponentMarks < 3) {
        next = {
          ...next,
          scoreA: next.scoreA + extra * value,
        }
      }
    } else {
      const currentMarks = next.cricketMarksB[key] ?? 0
      const opponentMarks = next.cricketMarksA[key] ?? 0
      const applied = currentMarks + multiplier
      const extra = Math.max(0, applied - 3)

      next = {
        ...next,
        cricketMarksB: {
          ...next.cricketMarksB,
          [key]: Math.min(3, applied),
        },
      }

      if (extra > 0 && opponentMarks < 3) {
        next = {
          ...next,
          scoreB: next.scoreB + extra * value,
        }
      }
    }
   }

   const closedA = canCloseCricket(next.cricketMarksA)
   const closedB = canCloseCricket(next.cricketMarksB)

   if (closedA && next.scoreA >= next.scoreB) {
     return {
       ...next,
       isDone: true,
       winnerTeamId: teamIds.A,
     }
   }
   if (closedB && next.scoreB >= next.scoreA) {
     return {
       ...next,
       isDone: true,
       winnerTeamId: teamIds.B,
     }
   }

   return advanceTurn(next)
 }

 export function undoLastDart(leg: LegResult): LegResult {
  const undoStack = leg.undoStack ?? []
  if (undoStack.length === 0) {
     return leg
   }

  const previous = undoStack[undoStack.length - 1]
   return {
     ...leg,
     scoreA: previous.scoreA,
     scoreB: previous.scoreB,
     activeSide: previous.activeSide,
     dartsInTurn: previous.dartsInTurn,
     turnStartScoreA: previous.turnStartScoreA,
     turnStartScoreB: previous.turnStartScoreB,
     cricketMarksA: { ...previous.cricketMarksA },
     cricketMarksB: { ...previous.cricketMarksB },
    currentTurnDarts: [...previous.currentTurnDarts],
    lastTurnDartsA: [...previous.lastTurnDartsA],
    lastTurnDartsB: [...previous.lastTurnDartsB],
     winnerTeamId: previous.winnerTeamId,
     isDone: previous.isDone,
    undoStack: undoStack.slice(0, -1),
   }
 }
