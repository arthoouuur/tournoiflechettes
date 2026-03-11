import type {
  LegResult,
  Match,
  MatchPhase,
  Player,
  Pool,
  Team,
  TeamStanding,
  TournamentState,
} from './models'
import { createInitialLeg } from './scoring'

const LEG_TYPES: LegResult['type'][] = ['x01-501', 'cricket', 'x01-301']

export interface PlayerDraft {
  id: string
  name: string
  exclusionsText: string
}

function createId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
  }
  return next
}

export function createInitialState(): TournamentState {
  return {
    players: [],
    teams: [],
    pools: [],
    matches: [],
    customSounds: {},
    selectedMatchId: undefined,
  }
}

export function createEmptyPlayerDraft(): PlayerDraft {
  return {
    id: createId('player_draft'),
    name: '',
    exclusionsText: '',
  }
}

export function createPlayersFromDrafts(drafts: PlayerDraft[]): Player[] {
  return drafts
    .map((draft) => ({
      id: createId('player'),
      name: draft.name.trim(),
      excludedPlayerNames: draft.exclusionsText
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    }))
    .filter((player) => player.name.length > 0)
}

function normalizePlayerName(name: string): string {
  return name.trim().toLocaleLowerCase()
}

function cannotTeamUp(first: Player, second: Player): boolean {
  const firstName = normalizePlayerName(first.name)
  const secondName = normalizePlayerName(second.name)
  const firstExclusions = new Set(first.excludedPlayerNames.map(normalizePlayerName))
  const secondExclusions = new Set(second.excludedPlayerNames.map(normalizePlayerName))

  return firstExclusions.has(secondName) || secondExclusions.has(firstName)
}

function buildTeamsBacktracking(players: Player[]): Team[] | null {
  if (players.length === 0) {
    return []
  }

  const [first, ...rest] = players
  const candidateIndexes = shuffle(rest.map((_, index) => index))

  for (const candidateIndex of candidateIndexes) {
    const partner = rest[candidateIndex]
    if (cannotTeamUp(first, partner)) {
      continue
    }

    const remaining = rest.filter((_, index) => index !== candidateIndex)
    const nextTeams = buildTeamsBacktracking(remaining)
    if (!nextTeams) {
      continue
    }

    return [
      {
        id: createId('team'),
        name: `${first.name} / ${partner.name}`,
        playerIds: [first.id, partner.id],
      },
      ...nextTeams,
    ]
  }

  return null
}

export function buildRandomTeams(players: Player[]): Team[] {
  const shuffled = shuffle(players)
  const usablePlayers = shuffled.slice(0, Math.floor(shuffled.length / 2) * 2)
  const constrained = buildTeamsBacktracking(usablePlayers)
  if (constrained) {
    return constrained
  }

  return []
}

function createEmptyLegs(): LegResult[] {
  return LEG_TYPES.map((type) => createInitialLeg(type))
}

function createMatch(phase: MatchPhase, label: string, teamAId?: string, teamBId?: string): Match {
  return {
    id: createId('match'),
    phase,
    label,
    teamAId,
    teamBId,
    status: 'waiting',
    legs: createEmptyLegs(),
  }
}

export function buildPoolsAndPoolMatches(teams: Team[]): { pools: Pool[]; matches: Match[] } {
  const shuffled = shuffle(teams)
  const pools: Pool[] = []
  const poolMatches: Match[] = []

  for (let i = 0; i < 3; i += 1) {
    const groupTeams = shuffled.slice(i * 3, i * 3 + 3)
    if (groupTeams.length < 3) {
      continue
    }

    const pool: Pool = {
      id: createId('pool'),
      name: `Poule ${String.fromCharCode(65 + i)}`,
      teamIds: groupTeams.map((team) => team.id),
    }
    pools.push(pool)

    const [t1, t2, t3] = groupTeams
    poolMatches.push(createMatch('pool', `${pool.name} M1`, t1.id, t2.id))
    poolMatches.push(createMatch('pool', `${pool.name} M2`, t1.id, t3.id))
    poolMatches.push(createMatch('pool', `${pool.name} M3`, t2.id, t3.id))
  }

  return { pools, matches: poolMatches }
}

function getLegWinnerCount(match: Match): Map<string, number> {
  const wins = new Map<string, number>()
  for (const leg of match.legs) {
    if (!leg.winnerTeamId) {
      continue
    }
    wins.set(leg.winnerTeamId, (wins.get(leg.winnerTeamId) ?? 0) + 1)
  }
  return wins
}

export function resolveMatchWinner(match: Match): string | undefined {
  const wins = getLegWinnerCount(match)
  for (const [teamId, score] of wins) {
    if (score >= 2) {
      return teamId
    }
  }
  return undefined
}

export function getCurrentLegIndex(match: Match): number {
  const firstTwoWinners = [match.legs[0]?.winnerTeamId, match.legs[1]?.winnerTeamId]
  const quickWin =
    firstTwoWinners[0] !== undefined &&
    firstTwoWinners[1] !== undefined &&
    firstTwoWinners[0] === firstTwoWinners[1]

  if (quickWin) {
    return -1
  }

  for (let i = 0; i < match.legs.length; i += 1) {
    if (!match.legs[i].isDone) {
      return i
    }
  }

  return -1
}

function finalizeMatchState(match: Match): Match {
  const winner = resolveMatchWinner(match)
  if (!winner) {
    if (match.status === 'done') {
      return {
        ...match,
        status: 'in_progress',
      }
    }
    return match
  }

  const next = { ...match }
  next.status = 'done'

  const first = next.legs[0]
  const second = next.legs[1]
  if (first?.winnerTeamId && first.winnerTeamId === second?.winnerTeamId) {
    next.legs = next.legs.map((leg, idx) => {
      if (idx !== 2) {
        return leg
      }
      return createInitialLeg('x01-301')
    })
  }

  return next
}

function syncKnockoutMatchParticipants(match: Match, teamAId?: string, teamBId?: string): Match {
  const changed = match.teamAId !== teamAId || match.teamBId !== teamBId
  if (!changed) {
    return match
  }

  return {
    ...match,
    teamAId,
    teamBId,
    status: 'waiting',
    legs: createEmptyLegs(),
  }
}

export function updateKnockoutProgression(matches: Match[]): Match[] {
  const byLabel = new Map(matches.map((m) => [m.label, m]))
  const next = [...matches]

  const qf1 = byLabel.get('QF1')
  const qf2 = byLabel.get('QF2')
  const qf3 = byLabel.get('QF3')
  const qf4 = byLabel.get('QF4')
  const sf1 = byLabel.get('SF1')
  const sf2 = byLabel.get('SF2')

  const winnerQf1 = qf1 ? resolveMatchWinner(qf1) : undefined
  const winnerQf2 = qf2 ? resolveMatchWinner(qf2) : undefined
  const winnerQf3 = qf3 ? resolveMatchWinner(qf3) : undefined
  const winnerQf4 = qf4 ? resolveMatchWinner(qf4) : undefined

  const winnerSf1 = sf1 ? resolveMatchWinner(sf1) : undefined
  const winnerSf2 = sf2 ? resolveMatchWinner(sf2) : undefined

  for (let i = 0; i < next.length; i += 1) {
    const current = next[i]
    if (current.label === 'SF1') {
      next[i] = syncKnockoutMatchParticipants(current, winnerQf1, winnerQf2)
    }
    if (current.label === 'SF2') {
      next[i] = syncKnockoutMatchParticipants(current, winnerQf3, winnerQf4)
    }
    if (current.label === 'Finale') {
      next[i] = syncKnockoutMatchParticipants(current, winnerSf1, winnerSf2)
    }
  }

  return next
}

export function rankTeamsForKnockout(state: TournamentState): TeamStanding[] {
  const standings = new Map<string, TeamStanding>()
  for (const team of state.teams) {
    standings.set(team.id, {
      teamId: team.id,
      wins: 0,
      losses: 0,
      legDiff: 0,
    })
  }

  for (const match of state.matches.filter((m) => m.phase === 'pool')) {
    if (!match.teamAId || !match.teamBId) {
      continue
    }

    const teamAWins = match.legs.filter((leg) => leg.winnerTeamId === match.teamAId).length
    const teamBWins = match.legs.filter((leg) => leg.winnerTeamId === match.teamBId).length

    if (teamAWins === 0 && teamBWins === 0) {
      continue
    }

    const a = standings.get(match.teamAId)
    const b = standings.get(match.teamBId)
    if (!a || !b) {
      continue
    }

    a.legDiff += teamAWins - teamBWins
    b.legDiff += teamBWins - teamAWins

    if (teamAWins > teamBWins) {
      a.wins += 1
      b.losses += 1
    }

    if (teamBWins > teamAWins) {
      b.wins += 1
      a.losses += 1
    }
  }

  return [...standings.values()].sort((left, right) => {
    if (right.wins !== left.wins) {
      return right.wins - left.wins
    }
    if (right.legDiff !== left.legDiff) {
      return right.legDiff - left.legDiff
    }
    return left.teamId.localeCompare(right.teamId)
  })
}

export function buildKnockoutMatches(top8TeamIds: string[]): Match[] {
  if (top8TeamIds.length < 8) {
    return []
  }

  const qf1 = createMatch('quarter', 'QF1', top8TeamIds[0], top8TeamIds[7])
  const qf2 = createMatch('quarter', 'QF2', top8TeamIds[3], top8TeamIds[4])
  const qf3 = createMatch('quarter', 'QF3', top8TeamIds[1], top8TeamIds[6])
  const qf4 = createMatch('quarter', 'QF4', top8TeamIds[2], top8TeamIds[5])

  const sf1 = createMatch('semi', 'SF1')
  const sf2 = createMatch('semi', 'SF2')
  const finale = createMatch('final', 'Finale')

  return [qf1, qf2, qf3, qf4, sf1, sf2, finale]
}

export function upsertKnockoutFromStandings(state: TournamentState): TournamentState {
  const ranking = rankTeamsForKnockout(state)
  const top8 = ranking.slice(0, 8).map((entry) => entry.teamId)
  if (top8.length < 8) {
    return state
  }

  const existingPoolMatches = state.matches.filter((match) => match.phase === 'pool')
  const existingKnockoutMatches = state.matches.filter((match) => match.phase !== 'pool')

  const created = buildKnockoutMatches(top8)

  const merged = created.map((createdMatch) => {
    const existing = existingKnockoutMatches.find((match) => match.label === createdMatch.label)
    return existing
      ? syncKnockoutMatchParticipants(existing, createdMatch.teamAId, createdMatch.teamBId)
      : createdMatch
  })

  return {
    ...state,
    matches: [...existingPoolMatches, ...updateKnockoutProgression(merged)],
  }
}

export function updateMatchById(
  matches: Match[],
  matchId: string,
  updater: (current: Match) => Match,
): Match[] {
  const next = matches.map((match) => (match.id === matchId ? updater(match) : match))
  return updateKnockoutProgression(next.map(finalizeMatchState))
}
