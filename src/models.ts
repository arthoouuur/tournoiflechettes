export type MatchPhase = 'pool' | 'quarter' | 'semi' | 'final'

export type MatchStatus = 'waiting' | 'in_progress' | 'done'

export type LegType = 'x01-501' | 'cricket' | 'x01-301'

export type TeamSide = 'A' | 'B'
export type DartMultiplier = 1 | 2 | 3

export interface LegSnapshot {
  scoreA: number
  scoreB: number
  activeSide: TeamSide
  dartsInTurn: number
  turnStartScoreA: number
  turnStartScoreB: number
  cricketMarksA: Record<string, number>
  cricketMarksB: Record<string, number>
  currentTurnDarts: string[]
  lastTurnDartsA: string[]
  lastTurnDartsB: string[]
  winnerTeamId?: string
  isDone: boolean
}

export interface Player {
  id: string
  name: string
  excludedPlayerNames: string[]
}

export interface Team {
  id: string
  name: string
  playerIds: string[]
  photoDataUrl?: string
}

export interface Pool {
  id: string
  name: string
  teamIds: string[]
}

export interface LegResult {
  type: LegType
  scoreA: number
  scoreB: number
  activeSide: TeamSide
  dartsInTurn: number
  turnStartScoreA: number
  turnStartScoreB: number
  cricketMarksA: Record<string, number>
  cricketMarksB: Record<string, number>
  currentTurnDarts: string[]
  lastTurnDartsA: string[]
  lastTurnDartsB: string[]
  undoStack: LegSnapshot[]
  winnerTeamId?: string
  isDone: boolean
}

export interface Match {
  id: string
  phase: MatchPhase
  label: string
  teamAId?: string
  teamBId?: string
  status: MatchStatus
  legs: LegResult[]
}

export interface TournamentState {
  players: Player[]
  teams: Team[]
  pools: Pool[]
  matches: Match[]
  selectedMatchId?: string
}

export interface TeamStanding {
  teamId: string
  wins: number
  losses: number
  legDiff: number
}
