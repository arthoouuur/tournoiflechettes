import type { TournamentState } from './models'
import { normalizeLeg } from './scoring'
import { createInitialState } from './tournamentLogic'

const TOURNAMENT_STORAGE_KEY = 'darts_tournament_state_v1'
const TOURNAMENT_ARCHIVES_KEY = 'darts_tournament_archives_v1'
const DEVICE_ID_KEY = 'darts_device_id_v1'
const REFEREE_LABEL_KEY = 'darts_referee_label_v1'

export interface TournamentArchive {
  id: string
  createdAtIso: string
  state: TournamentState
}

export interface ArchiveTournamentResult {
  archive: TournamentArchive
  storedLocally: boolean
  totalArchives: number
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function loadTournamentState(): TournamentState {
  try {
    const raw = localStorage.getItem(TOURNAMENT_STORAGE_KEY)
    if (!raw) {
      return createInitialState()
    }
    const parsed = JSON.parse(raw) as TournamentState
    return normalizeTournamentState(parsed)
  } catch {
    return createInitialState()
  }
}

export function normalizeTournamentState(raw: Partial<TournamentState>): TournamentState {
  const base = createInitialState()
  return {
    ...base,
    ...raw,
    players: (raw.players ?? []).map((player) => ({
      ...player,
      excludedPlayerNames: player?.excludedPlayerNames ?? [],
    })),
    customSounds: raw.customSounds ?? {},
    teams: raw.teams ?? [],
    pools: raw.pools ?? [],
    matches: (raw.matches ?? []).map((match) => ({
      ...match,
      legs: (match.legs ?? [])
        .filter((leg) => leg?.type)
        .map((leg) => normalizeLeg(leg))
        .slice(0, 3),
    })),
  }
}

export function saveTournamentState(state: TournamentState): void {
  localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(state))
}

export function loadTournamentArchives(): TournamentArchive[] {
  try {
    const raw = localStorage.getItem(TOURNAMENT_ARCHIVES_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as TournamentArchive[]
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.createdAtIso === 'string')
      .map((entry) => ({
        ...entry,
        state: normalizeTournamentState(entry.state ?? createInitialState()),
      }))
  } catch {
    return []
  }
}

function canWriteArchiveList(archives: TournamentArchive[]): boolean {
  try {
    localStorage.setItem(TOURNAMENT_ARCHIVES_KEY, JSON.stringify(archives))
    return true
  } catch {
    return false
  }
}

export function archiveTournamentState(state: TournamentState): ArchiveTournamentResult {
  const archive: TournamentArchive = {
    id: randomId('archive'),
    createdAtIso: new Date().toISOString(),
    state: normalizeTournamentState(state),
  }

  const current = loadTournamentArchives()
  let next = [archive, ...current].slice(0, 30)

  while (next.length > 1 && !canWriteArchiveList(next)) {
    next = next.slice(0, next.length - 1)
  }

  const storedLocally = canWriteArchiveList(next)
  return {
    archive,
    storedLocally,
    totalArchives: storedLocally ? next.length : current.length,
  }
}

export function getOrCreateDeviceId(): string {
  const current = localStorage.getItem(DEVICE_ID_KEY)
  if (current) {
    return current
  }
  const created = randomId('device')
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

export function loadRefereeLabel(): string {
  return localStorage.getItem(REFEREE_LABEL_KEY) ?? 'Arbitre'
}

export function saveRefereeLabel(label: string): void {
  localStorage.setItem(REFEREE_LABEL_KEY, label)
}
