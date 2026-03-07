import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session, User } from '@supabase/supabase-js'
import { playVictorySound } from './audio'
import type { DartMultiplier, Match, MatchPhase, Team, TournamentState } from './models'
import {
  fetchAllMatchLocks,
  fetchMatchLock,
  fetchRemoteTournamentState,
  heartbeatOwnedMatchLocks,
  isLockExpired,
  releaseMatchLock,
  saveRemoteTournamentState,
  subscribeToRefereeLock,
  subscribeToTournamentState,
  tryAcquireMatchLock,
  unsubscribeChannel,
  type MatchLock,
} from './remoteSync'
import { applyDartToLeg, createInitialLeg, undoLastDart } from './scoring'
import { isSupabaseConfigured, supabase } from './supabase'
import {
  archiveTournamentState,
  getOrCreateDeviceId,
  loadRefereeLabel,
  saveRefereeLabel,
  loadTournamentState,
  normalizeTournamentState,
  saveTournamentState,
} from './storage'
import {
  buildPoolsAndPoolMatches,
  buildRandomTeams,
  createInitialState,
  createPlayersFromText,
  getCurrentLegIndex,
  rankTeamsForKnockout,
  resolveMatchWinner,
  updateMatchById,
  upsertKnockoutFromStandings,
} from './tournamentLogic'

const QUERY_KEY = ['tournament']
const X01_KEYS = Array.from({ length: 26 }, (_, index) => index).filter(
  (index) => index <= 20 || index === 25,
)
const CRICKET_KEYS = [0, 15, 16, 17, 18, 19, 20, 25]
const CRICKET_TARGETS = [25, 20, 19, 18, 17, 16, 15]

type TabId = 'setup' | 'teams' | 'matches'
type PhaseFilter = 'all' | MatchPhase

const tabs: { id: TabId; label: string }[] = [
  { id: 'setup', label: 'Tournoi' },
  { id: 'teams', label: 'Equipes' },
  { id: 'matches', label: 'Matchs' },
]

function getTeamName(teams: Team[], teamId?: string): string {
  if (!teamId) {
    return 'A definir'
  }
  return teams.find((team) => team.id === teamId)?.name ?? 'A definir'
}

function getStatusLabel(match: Match): string {
  if (match.status === 'in_progress') {
    return 'En cours'
  }
  if (match.status === 'done') {
    return 'Termine'
  }
  return 'En attente'
}

function getLegLabel(type: Match['legs'][number]['type']): string {
  if (type === 'x01-501') {
    return '501 finish simple'
  }
  if (type === 'x01-301') {
    return '301 finish simple'
  }
  return 'Cricket'
}

function getPhaseLabel(phase: MatchPhase): string {
  if (phase === 'pool') {
    return 'Poules'
  }
  if (phase === 'quarter') {
    return 'Quarts'
  }
  if (phase === 'semi') {
    return 'Demies'
  }
  return 'Finale'
}

function getScoreKeyLabel(value: number): string {
  return value === 25 ? 'BULL' : String(value)
}

function renderCricketMarks(markCount: number): string {
  const safe = Math.max(0, Math.min(3, Number.isFinite(markCount) ? markCount : 0))
  if (safe === 0) {
    return '- - -'
  }
  if (safe === 1) {
    return 'x - -'
  }
  if (safe === 2) {
    return 'x x -'
  }
  return 'x x x'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Echec de lecture du fichier'))
    reader.readAsDataURL(file)
  })
}

function downloadArchiveFile(payload: unknown, filename: string): void {
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function App() {
  const queryClient = useQueryClient()
  const deviceId = useMemo(() => getOrCreateDeviceId(), [])
  const [activeTab, setActiveTab] = useState<TabId>('setup')
  const [selectedPhase, setSelectedPhase] = useState<PhaseFilter>('all')
  const [localSelectedMatchId, setLocalSelectedMatchId] = useState<string | undefined>(undefined)
  const [playersText, setPlayersText] = useState('')
  const [teamNameDrafts, setTeamNameDrafts] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState('')
  const [selectedMultiplier, setSelectedMultiplier] = useState<DartMultiplier>(1)
  const [syncStatus, setSyncStatus] = useState(
    isSupabaseConfigured ? 'Sync Supabase activee.' : 'Mode local uniquement (Supabase non configure).',
  )
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured)
  const [allowlistChecked, setAllowlistChecked] = useState(!isSupabaseConfigured)
  const [isAllowlisted, setIsAllowlisted] = useState(!isSupabaseConfigured)
  const [authError, setAuthError] = useState<string | null>(null)
  const [matchLocks, setMatchLocks] = useState<MatchLock[]>([])
  const [refereeLabel, setRefereeLabel] = useState(loadRefereeLabel)
  const [isRefereeMode, setIsRefereeMode] = useState(false)

  const tournamentQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => loadTournamentState(),
    initialData: loadTournamentState,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const state = tournamentQuery.data ?? createInitialState()

  const filteredMatches = useMemo(() => {
    if (selectedPhase === 'all') {
      return state.matches
    }
    return state.matches.filter((match) => match.phase === selectedPhase)
  }, [selectedPhase, state.matches])

  const selectedMatch =
    filteredMatches.find((match) => match.id === localSelectedMatchId) ??
    state.matches.find((match) => match.id === localSelectedMatchId) ??
    filteredMatches[0] ??
    state.matches[0]

  const canEdit = !isSupabaseConfigured || isRefereeMode

  const standings = useMemo(() => rankTeamsForKnockout(state), [state])

  async function refreshAllowlistForUser(user: User | null): Promise<void> {
    if (!isSupabaseConfigured || !supabase) {
      setIsAllowlisted(true)
      setAllowlistChecked(true)
      setAuthError(null)
      return
    }

    if (!user?.email) {
      setIsAllowlisted(false)
      setAllowlistChecked(true)
      setAuthError(null)
      return
    }

    const { data, error } = await supabase
      .from('allowed_users')
      .select('email')
      .ilike('email', user.email)
      .maybeSingle()

    if (error) {
      setIsAllowlisted(false)
      setAllowlistChecked(true)
      setAuthError(`Erreur allowlist: ${error.message}`)
      return
    }

    setIsAllowlisted(Boolean(data))
    setAllowlistChecked(true)
    setAuthError(null)
  }

  async function signInWithGoogle(): Promise<void> {
    if (!supabase) {
      return
    }

    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' })
    if (error) {
      setAuthError(`Erreur login Google: ${error.message}`)
    }
  }

  async function signOut(): Promise<void> {
    if (!supabase) {
      return
    }

    await supabase.auth.signOut()
    setSession(null)
    setIsAllowlisted(false)
    setAllowlistChecked(true)
  }

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      return
    }

    let isActive = true

    void supabase.auth.getSession().then(async ({ data }) => {
      if (!isActive) {
        return
      }
      const nextSession = data.session
      setSession(nextSession)
      await refreshAllowlistForUser(nextSession?.user ?? null)
      if (!isActive) {
        return
      }
      setAuthLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      void refreshAllowlistForUser(nextSession?.user ?? null)
    })

    return () => {
      isActive = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    saveRefereeLabel(refereeLabel)
  }, [refereeLabel])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    let isActive = true

    async function refreshRemoteTournament(): Promise<void> {
      try {
        const remote = await fetchRemoteTournamentState()
        if (!remote || !isActive) {
          return
        }
        const normalized = normalizeTournamentState(remote)
        queryClient.setQueryData<TournamentState>(QUERY_KEY, normalized)
        saveTournamentState(normalized)
        setSyncStatus('Etat distant recu en temps reel.')
      } catch (error) {
        if (!isActive) {
          return
        }
        setSyncStatus(`Erreur sync tournoi: ${(error as Error).message}`)
      }
    }

    async function refreshLocks(): Promise<void> {
      try {
        const nextLocks = await fetchAllMatchLocks()
        if (!isActive) {
          return
        }
        setMatchLocks(nextLocks)
      } catch (error) {
        if (!isActive) {
          return
        }
        setSyncStatus(`Erreur sync verrou: ${(error as Error).message}`)
      }
    }

    void refreshRemoteTournament()
    void refreshLocks()

    const tournamentChannel = subscribeToTournamentState(() => {
      void refreshRemoteTournament()
    })
    const lockChannel = subscribeToRefereeLock(() => {
      void refreshLocks()
    })

    return () => {
      isActive = false
      unsubscribeChannel(tournamentChannel)
      unsubscribeChannel(lockChannel)
    }
  }, [queryClient])

  useEffect(() => {
    if (!isSupabaseConfigured || !isRefereeMode) {
      return
    }

    const timer = window.setInterval(() => {
      void heartbeatOwnedMatchLocks(deviceId, refereeLabel)
    }, 60 * 1000)

    return () => window.clearInterval(timer)
  }, [deviceId, isRefereeMode, refereeLabel])

  function updateTournament(
    updater: (prev: TournamentState) => TournamentState,
    options?: { allowNonRefereeRemoteWrite?: boolean },
  ): void {
    queryClient.setQueryData<TournamentState>(QUERY_KEY, (prev) => {
      const base = normalizeTournamentState(prev ?? createInitialState())
      const next = normalizeTournamentState(updater(base))
      saveTournamentState(next)

      const shouldPublishRemote =
        isSupabaseConfigured && (canEdit || options?.allowNonRefereeRemoteWrite === true)

      if (shouldPublishRemote) {
        void saveRemoteTournamentState(next, deviceId, refereeLabel).catch((error: unknown) => {
          setSyncStatus(`Erreur publication Supabase: ${(error as Error).message}`)
        })
      }

      return next
    })
  }

  function handleGenerateTournament(): void {
    if (!canEdit) {
      setFeedback('Seul l arbitre actif peut modifier le tournoi.')
      return
    }

    const players = createPlayersFromText(playersText)
    if (players.length < 18) {
      setFeedback('Ajoute au moins 18 joueurs (une ligne par joueur).')
      return
    }

    const teams = buildRandomTeams(players).slice(0, 9)
    const { pools, matches } = buildPoolsAndPoolMatches(teams)

    const next: TournamentState = {
      players,
      teams,
      pools,
      matches,
      selectedMatchId: matches[0]?.id,
    }

    updateTournament(() => next)
    setLocalSelectedMatchId(matches[0]?.id)
    setSelectedPhase('all')
    setFeedback('Tournoi cree: 9 equipes, 3 poules, matchs de poules prets.')
    setActiveTab('teams')
  }

  function completeMatchForTest(match: Match): Match {
    if (!match.teamAId || !match.teamBId) {
      return match
    }

    const winnerTeamId = Math.random() < 0.5 ? match.teamAId : match.teamBId
    return {
      ...match,
      status: 'done',
      legs: match.legs.map((leg, index) => {
        if (index >= 2) {
          return createInitialLeg(leg.type)
        }
        return {
          ...leg,
          winnerTeamId,
          isDone: true,
          currentTurnDarts: [],
          lastTurnDartsA: [],
          lastTurnDartsB: [],
          dartsInTurn: 0,
        }
      }),
    }
  }

  function handleSimulatePoolsAndGenerateKnockout(): void {
    if (!canEdit) {
      setFeedback('Seul l arbitre actif peut modifier le tournoi.')
      return
    }

    updateTournament((prev) => {
      let matches = prev.matches

      for (const poolMatch of matches.filter((m) => m.phase === 'pool')) {
        matches = updateMatchById(matches, poolMatch.id, (current) => completeMatchForTest(current))
      }

      return upsertKnockoutFromStandings({
        ...prev,
        matches,
      })
    })

    setSelectedPhase('quarter')
    setActiveTab('matches')
    setFeedback('Simulation terminee: poules remplies et quarts generes.')
  }

  function handleSimulateKnockoutBracket(): void {
    if (!canEdit) {
      setFeedback('Seul l arbitre actif peut modifier le tournoi.')
      return
    }

    updateTournament((prev) => {
      const withKnockout = upsertKnockoutFromStandings(prev)
      let matches = withKnockout.matches

      for (const label of ['QF1', 'QF2', 'QF3', 'QF4', 'SF1', 'SF2', 'Finale']) {
        const match = matches.find((m) => m.label === label)
        if (!match || !match.teamAId || !match.teamBId) {
          continue
        }
        if (resolveMatchWinner(match)) {
          continue
        }

        matches = updateMatchById(matches, match.id, (current) => completeMatchForTest(current))
      }

      return {
        ...withKnockout,
        matches,
      }
    })

    setSelectedPhase('final')
    setActiveTab('matches')
    setFeedback('Simulation terminee: quarts, demies et finale joues automatiquement.')
  }

  function handleArchiveAndResetTournament(): void {
    if (!canEdit) {
      setFeedback('Seul l arbitre actif peut modifier le tournoi.')
      return
    }

    const hasTournamentData = state.players.length > 0 || state.teams.length > 0 || state.matches.length > 0
    if (!hasTournamentData) {
      setFeedback('Aucun tournoi a archiver pour le moment.')
      return
    }

    const archiveResult = archiveTournamentState(state)
    const stamp = archiveResult.archive.createdAtIso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    downloadArchiveFile(archiveResult.archive, `darts-archive-${stamp}.json`)

    const empty = createInitialState()
    updateTournament(() => empty)
    setPlayersText('')
    setTeamNameDrafts({})
    setSelectedMultiplier(1)
    setLocalSelectedMatchId(undefined)
    setSelectedPhase('all')
    setActiveTab('setup')
    if (archiveResult.storedLocally) {
      setFeedback(
        `Tournoi archive (${archiveResult.totalArchives} archive(s) locale(s)) et remis a zero.`,
      )
      return
    }

    setFeedback('Tournoi exporte en fichier, mais stockage local plein: ancienne archives conservees.')
  }

  function handleRenameTeam(teamId: string, nextName: string): void {
    updateTournament((prev) => ({
      ...prev,
      teams: prev.teams.map((team) => (team.id === teamId ? { ...team, name: nextName } : team)),
    }), { allowNonRefereeRemoteWrite: true })
  }

  function commitTeamNameDraft(teamId: string, fallbackName: string): void {
    const nextName = (teamNameDrafts[teamId] ?? fallbackName).trim()
    const safeName = nextName.length > 0 ? nextName : fallbackName

    setTeamNameDrafts((prev) => {
      const next = { ...prev }
      delete next[teamId]
      return next
    })

    if (safeName !== fallbackName) {
      handleRenameTeam(teamId, safeName)
    }
  }

  async function handleTeamPhoto(teamId: string, file?: File): Promise<void> {
    if (!file) {
      return
    }
    const photoDataUrl = await readFileAsDataUrl(file)
    updateTournament((prev) => ({
      ...prev,
      teams: prev.teams.map((team) => (team.id === teamId ? { ...team, photoDataUrl } : team)),
    }), { allowNonRefereeRemoteWrite: true })
  }

  function applyMatchUpdate(matchId: string, updater: (current: Match) => Match): void {
    if (!canEditSelectedMatch) {
      return
    }

    updateTournament((prev) => {
      const before = prev.matches.find((match) => match.id === matchId)
      const updatedMatches = updateMatchById(prev.matches, matchId, updater)
      const after = updatedMatches.find((match) => match.id === matchId)

      if (before && after && !resolveMatchWinner(before) && resolveMatchWinner(after)) {
        playVictorySound()
      }

      return {
        ...prev,
        matches: updatedMatches,
      }
    })
  }

  function throwDart(value: number): void {
    if (!selectedMatch || !canEditSelectedMatch) {
      return
    }

    applyMatchUpdate(selectedMatch.id, (current) => {
      const currentLegIndex = getCurrentLegIndex(current)
      if (currentLegIndex < 0) {
        return current
      }

      const updatedLeg = applyDartToLeg(
        current.legs[currentLegIndex],
        { A: current.teamAId, B: current.teamBId },
        value,
        selectedMultiplier,
      )

      return {
        ...current,
        status: 'in_progress',
        legs: current.legs.map((leg, index) => (index === currentLegIndex ? updatedLeg : leg)),
      }
    })

    setSelectedMultiplier(1)
  }

  function undoDart(): void {
    if (!selectedMatch || !canEditSelectedMatch) {
      return
    }

    applyMatchUpdate(selectedMatch.id, (current) => {
      const activeIndex = getCurrentLegIndex(current)
      let fallbackIndex = -1
      for (let i = current.legs.length - 1; i >= 0; i -= 1) {
        if ((current.legs[i].undoStack?.length ?? 0) > 0) {
          fallbackIndex = i
          break
        }
      }
      const currentLegIndex = activeIndex >= 0 ? activeIndex : fallbackIndex

      if (currentLegIndex < 0) {
        return current
      }

      const restored = undoLastDart(current.legs[currentLegIndex])
      return {
        ...current,
        status: 'in_progress',
        legs: current.legs.map((leg, index) => (index === currentLegIndex ? restored : leg)),
      }
    })
  }

  async function takeRefereeRole(): Promise<void> {
    const label = refereeLabel.trim()
    if (!label) {
      setFeedback('Indique un nom d arbitre avant de prendre le role.')
      return
    }

    setIsRefereeMode(true)
    setFeedback('Mode arbitre active. Prends un match pour le modifier.')
  }

  async function leaveRefereeRole(): Promise<void> {
    try {
      if (isSupabaseConfigured) {
        const ownedLocks = matchLocks.filter((lock) => lock.ownerId === deviceId)
        for (const owned of ownedLocks) {
          await releaseMatchLock(owned.matchId, deviceId)
        }
      }

      setIsRefereeMode(false)
      setFeedback('Role arbitre libere.')
    } catch (error) {
      setFeedback(`Erreur liberation role arbitre: ${(error as Error).message}`)
    }
  }

  async function takeSelectedMatch(): Promise<void> {
    if (!selectedMatch) {
      return
    }
    if (!isRefereeMode) {
      setFeedback('Active le mode arbitre avant de prendre un match.')
      return
    }

    if (!isSupabaseConfigured) {
      setFeedback('Match attribue localement (mode sans Supabase).')
      return
    }

    try {
      const acquired = await tryAcquireMatchLock(selectedMatch.id, deviceId, refereeLabel)
      const lock = await fetchMatchLock(selectedMatch.id)
      const locks = await fetchAllMatchLocks()
      setMatchLocks(locks)

      if (!acquired) {
        setFeedback(`Match deja pris par ${lock?.ownerLabel ?? 'un autre arbitre'}.`)
        return
      }

      setFeedback('Match pris, tu peux modifier ce score.')
    } catch (error) {
      setFeedback(`Erreur prise de match: ${(error as Error).message}`)
    }
  }

  async function releaseSelectedMatch(): Promise<void> {
    if (!selectedMatch || !isSupabaseConfigured) {
      return
    }

    try {
      await releaseMatchLock(selectedMatch.id, deviceId)
      const locks = await fetchAllMatchLocks()
      setMatchLocks(locks)
      setFeedback('Match libere.')
    } catch (error) {
      setFeedback(`Erreur liberation match: ${(error as Error).message}`)
    }
  }

  const legIndex = selectedMatch ? getCurrentLegIndex(selectedMatch) : -1
  const activeLeg = selectedMatch && legIndex >= 0 ? selectedMatch.legs[legIndex] : undefined
  const activeScoreKeys = activeLeg?.type === 'cricket' ? CRICKET_KEYS : X01_KEYS
  const teamA = state.teams.find((team) => team.id === selectedMatch?.teamAId)
  const teamB = state.teams.find((team) => team.id === selectedMatch?.teamBId)
  const teamAName = getTeamName(state.teams, selectedMatch?.teamAId)
  const teamBName = getTeamName(state.teams, selectedMatch?.teamBId)
  const activeTeamName = activeLeg?.activeSide === 'B' ? teamBName : teamAName

  const selectedMatchLock = selectedMatch
    ? matchLocks.find((lock) => lock.matchId === selectedMatch.id && !isLockExpired(lock))
    : undefined
  const hasSelectedMatchLock =
    !isSupabaseConfigured ||
    (selectedMatchLock !== undefined && selectedMatchLock.ownerId === deviceId)
  const canEditSelectedMatch = canEdit && hasSelectedMatchLock
  const selectedMatchLockOwnerLabel = selectedMatchLock
    ? `${selectedMatchLock.ownerLabel} (${selectedMatchLock.ownerId.slice(0, 6)})`
    : 'Aucun'
  const ownedMatchCount = matchLocks.filter((lock) => lock.ownerId === deviceId).length

  const displayDartsA =
    activeLeg?.activeSide === 'A'
      ? (activeLeg.currentTurnDarts ?? [])
      : (activeLeg?.lastTurnDartsA ?? [])

  const displayDartsB =
    activeLeg?.activeSide === 'B'
      ? (activeLeg.currentTurnDarts ?? [])
      : (activeLeg?.lastTurnDartsB ?? [])

  const canStartMatch =
    Boolean(selectedMatch?.teamAId && selectedMatch?.teamBId) &&
    selectedMatch?.status === 'waiting' &&
    canEditSelectedMatch

  if (isSupabaseConfigured && authLoading) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-8">
        <section className="card-championship w-full p-6 text-center">
          <h1 className="font-display text-4xl uppercase text-white">Connexion</h1>
          <p className="mt-2 text-slate-300">Verification de la session en cours...</p>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && !session) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-8">
        <section className="card-championship w-full p-6 text-center">
          <h1 className="font-display text-4xl uppercase text-white">Connexion requise</h1>
          <p className="mt-2 text-slate-300">Connecte-toi avec Google pour acceder au tournoi.</p>
          {authError && <p className="mt-3 text-sm text-amber-200">{authError}</p>}
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="mt-5 rounded-xl bg-cyan-300 px-5 py-3 font-bold uppercase tracking-wide text-slate-950"
          >
            Se connecter avec Google
          </button>
        </section>
      </main>
    )
  }

  if (isSupabaseConfigured && allowlistChecked && !isAllowlisted) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-8">
        <section className="card-championship w-full p-6 text-center">
          <h1 className="font-display text-4xl uppercase text-white">Acces non autorise</h1>
          <p className="mt-2 text-slate-300">
            Ton compte n'est pas dans la liste des utilisateurs autorises pour ce tournoi.
          </p>
          <p className="mt-2 text-sm text-slate-400">Compte: {session?.user?.email ?? 'inconnu'}</p>
          {authError && <p className="mt-3 text-sm text-amber-200">{authError}</p>}
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-5 rounded-xl bg-slate-700 px-5 py-3 font-bold uppercase tracking-wide text-white"
          >
            Se deconnecter
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <section className="card-championship mb-6 p-6">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/80">PWA tournoi de flechettes</p>
        <h1 className="font-display text-4xl uppercase text-white md:text-6xl">Darts Championship Control</h1>
        <p className="mt-2 max-w-3xl text-slate-300">
          Binomes aleatoires, poules de 3, top 8 en phase finale et score tablette en 3 legs: 501,
          cricket, puis 301 si necessaire.
        </p>

        <div className="mt-5 grid gap-3 rounded-xl bg-slate-950/60 p-4 md:grid-cols-[1fr,auto,auto]">
          <label className="text-sm text-slate-200">
            Nom arbitre
            <input
              value={refereeLabel}
              onChange={(event) => setRefereeLabel(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-white outline-none ring-cyan-400 focus:ring"
              placeholder="Arbitre central"
            />
          </label>

          {!isRefereeMode ? (
            <button
              type="button"
              onClick={() => void takeRefereeRole()}
              className="rounded-xl bg-emerald-400 px-4 py-2 font-bold text-slate-950"
            >
              Prendre role arbitre
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void leaveRefereeRole()}
              className="rounded-xl bg-slate-700 px-4 py-2 font-bold text-white"
            >
              Liberer role arbitre
            </button>
          )}

          <div className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300">
            <p>Mode: {canEdit ? 'Edition (arbitre)' : 'Lecture seule'}</p>
            <p>Matchs pris: {ownedMatchCount}</p>
            <p>Sync: {syncStatus}</p>
          </div>
        </div>
      </section>

      <nav className="mb-6 grid grid-cols-3 gap-2 rounded-2xl bg-slate-900/60 p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-xl px-3 py-3 text-sm font-bold uppercase tracking-wide transition ${
              activeTab === tab.id
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-800/60 text-slate-200 hover:bg-slate-700/80'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'setup' && (
        <section className="grid gap-6 lg:grid-cols-2">
          <article className="card-championship p-5">
            <h2 className="font-display text-3xl uppercase text-white">1. Joueurs et tirage</h2>
            <p className="text-slate-300">Entre les 18 joueurs (une ligne = un joueur).</p>
            <textarea
              value={playersText}
              onChange={(event) => setPlayersText(event.target.value)}
              placeholder={'Arthur\nLina\nNolan\n...'}
              className="mt-3 h-72 w-full rounded-xl border border-slate-700 bg-slate-950/80 p-3 text-sm text-white outline-none ring-cyan-400 focus:ring"
            />
            <button
              type="button"
              onClick={handleGenerateTournament}
              disabled={!canEdit}
              className="mt-4 w-full rounded-xl bg-amber-300 px-4 py-3 font-bold uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Generer 9 binomes + 3 poules
            </button>
            <button
              type="button"
              onClick={handleSimulatePoolsAndGenerateKnockout}
              disabled={!canEdit}
              hidden
              className="mt-3 w-full rounded-xl bg-teal-300 px-4 py-3 font-bold uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Simuler poules + generer quarts
            </button>
            <button
              type="button"
              onClick={handleSimulateKnockoutBracket}
              disabled={!canEdit}
              hidden
              className="mt-3 w-full rounded-xl bg-fuchsia-300 px-4 py-3 font-bold uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Simuler quarts, demies et finale
            </button>
            <button
              type="button"
              onClick={handleArchiveAndResetTournament}
              disabled={!canEdit}
              hidden
              className="mt-3 w-full rounded-xl bg-rose-300 px-4 py-3 font-bold uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Archiver et nouveau tournoi
            </button>
            <p className="mt-3 text-sm text-amber-100">{feedback}</p>
          </article>

          <article className="card-championship p-5">
            <h2 className="font-display text-3xl uppercase text-white">2. Classement poules</h2>
            <p className="text-slate-300">Les 8 meilleurs passent en quart de finale.</p>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-700">
              <table className="w-full min-w-[26rem] border-collapse text-sm">
                <thead className="bg-slate-900/90 text-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Equipe</th>
                    <th className="px-3 py-2 text-center">V</th>
                    <th className="px-3 py-2 text-center">L</th>
                    <th className="px-3 py-2 text-center">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((row, index) => (
                    <tr key={row.teamId} className="border-t border-slate-800 bg-slate-950/40">
                      <td className="px-3 py-2">{index + 1}</td>
                      <td className="px-3 py-2">{getTeamName(state.teams, row.teamId)}</td>
                      <td className="px-3 py-2 text-center">{row.wins}</td>
                      <td className="px-3 py-2 text-center">{row.losses}</td>
                      <td className="px-3 py-2 text-center">{row.legDiff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {standings.length === 0 && <p className="p-3 text-slate-400">Aucun classement pour le moment.</p>}
            </div>

            <button
              type="button"
              onClick={() => {
                if (!canEdit) {
                  setFeedback('Seul l arbitre actif peut modifier le tournoi.')
                  return
                }
                updateTournament((prev) => upsertKnockoutFromStandings(prev))
                setFeedback('Phase finale calculee. Tu peux scorer les quarts.')
                setSelectedPhase('quarter')
                setActiveTab('matches')
              }}
              disabled={!canEdit}
              className="mt-5 w-full rounded-xl bg-cyan-300 px-4 py-3 font-bold uppercase tracking-wide text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Generer phase finale (Top 8)
            </button>
          </article>
        </section>
      )}

      {activeTab === 'teams' && (
        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {state.teams.map((team) => (
            <article key={team.id} className="card-championship p-4">
              <div className="mb-3 h-36 overflow-hidden rounded-xl bg-slate-900">
                {team.photoDataUrl ? (
                  <img src={team.photoDataUrl} alt={team.name} className="h-full w-full object-fill" />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-500">Photo equipe</div>
                )}
              </div>
              <input
                value={teamNameDrafts[team.id] ?? team.name}
                onChange={(event) =>
                  setTeamNameDrafts((prev) => ({
                    ...prev,
                    [team.id]: event.target.value,
                  }))
                }
                onBlur={() => commitTeamNameDraft(team.id, team.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-white outline-none ring-cyan-400 focus:ring"
              />
              <label className="mt-3 block rounded-lg bg-slate-800 px-3 py-2 text-center text-sm text-slate-100">
                Changer photo
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    void handleTeamPhoto(team.id, file)
                  }}
                  className="hidden"
                />
              </label>
            </article>
          ))}
          {state.teams.length === 0 && <p className="text-slate-300">Genere le tournoi pour afficher les equipes.</p>}
        </section>
      )}

      {activeTab === 'matches' && (
        <section className="grid gap-6 lg:grid-cols-[1.1fr,1fr]">
          <article className="card-championship p-4">
            <h2 className="font-display text-3xl uppercase text-white">Planning matchs</h2>
            <p className="mt-1 text-sm text-slate-300">Selectionne la phase puis le match dans les menus.</p>

            <div className="mt-4 grid gap-3">
              <label className="text-sm text-slate-200">
                Phase
                <select
                  value={selectedPhase}
                  onChange={(event) => setSelectedPhase(event.target.value as PhaseFilter)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-white"
                >
                  <option value="all">Toutes</option>
                  <option value="pool">Poules</option>
                  <option value="quarter">Quarts</option>
                  <option value="semi">Demies</option>
                  <option value="final">Finale</option>
                </select>
              </label>

              <label className="text-sm text-slate-200">
                Match
                <select
                  value={selectedMatch?.id ?? ''}
                  onChange={(event) => setLocalSelectedMatchId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-white"
                >
                  {filteredMatches.length === 0 && <option value="">Aucun match</option>}
                  {(['pool', 'quarter', 'semi', 'final'] as MatchPhase[]).map((phase) => {
                    const phaseMatches = filteredMatches.filter((match) => match.phase === phase)
                    if (phaseMatches.length === 0) {
                      return null
                    }
                    return (
                      <optgroup key={phase} label={getPhaseLabel(phase)}>
                        {phaseMatches.map((match) => (
                          <option key={match.id} value={match.id}>
                            {match.label} - {getTeamName(state.teams, match.teamAId)} vs{' '}
                            {getTeamName(state.teams, match.teamBId)} - {getStatusLabel(match)}
                          </option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>
              </label>
            </div>
          </article>

          <article className="card-championship p-4">
            <h2 className="font-display text-3xl uppercase text-white">Feuille de match</h2>
            {!selectedMatch && <p className="text-slate-300">Selectionne un match.</p>}

            {selectedMatch && (
              <>
                <p className="text-sm uppercase tracking-[0.2em] text-slate-400">
                  {selectedMatch.label} - {getStatusLabel(selectedMatch)}
                </p>
                <p className="text-xl font-semibold text-white">
                  {getTeamName(state.teams, selectedMatch.teamAId)} vs{' '}
                  {getTeamName(state.teams, selectedMatch.teamBId)}
                </p>

                <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-200">
                  <p>Arbitre du match: {selectedMatchLockOwnerLabel}</p>
                  <p>
                    Edition match: {canEditSelectedMatch ? 'Autorisee' : 'Bloquee'}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void takeSelectedMatch()}
                      disabled={!isRefereeMode || !selectedMatch || canEditSelectedMatch}
                      className="rounded-lg bg-emerald-400 px-2 py-2 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Prendre ce match
                    </button>
                    <button
                      type="button"
                      onClick={() => void releaseSelectedMatch()}
                      disabled={!selectedMatchLock || selectedMatchLock.ownerId !== deviceId}
                      className="rounded-lg bg-slate-700 px-2 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Liberer ce match
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      applyMatchUpdate(selectedMatch.id, (current) => ({
                        ...current,
                        status: 'in_progress',
                      }))
                    }
                    disabled={!canStartMatch}
                    className="rounded-xl bg-cyan-300 px-3 py-2 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Demarrer
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      applyMatchUpdate(selectedMatch.id, (current) => ({
                        ...current,
                        status: 'waiting',
                      }))
                    }
                    disabled={!canEditSelectedMatch}
                    className="rounded-xl bg-slate-700 px-3 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remettre en attente
                  </button>
                </div>

                <div className="mt-5 rounded-xl bg-slate-950/70 p-4">
                  <p className="text-sm text-slate-300">
                    {activeLeg
                      ? `Leg actif: ${legIndex + 1} (${getLegLabel(activeLeg.type)})`
                      : 'Match termine ou en attente de participants'}
                  </p>

                  {activeLeg && (
                    <>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <div className="rounded-xl bg-slate-900 p-3 text-center">
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Tour de jeu</p>
                          <p className="font-display text-4xl text-cyan-200">{activeTeamName}</p>
                          <p className="text-lg text-slate-200">Flechette {activeLeg.dartsInTurn + 1}/3</p>
                        </div>
                        <div
                          className="rounded-xl bg-slate-900 p-3 text-center"
                          style={
                            teamA?.photoDataUrl
                              ? {
                                  backgroundImage: `linear-gradient(rgba(2, 6, 23, 0.64), rgba(2, 6, 23, 0.64)), url(${teamA.photoDataUrl})`,
                                  backgroundSize: '100% 100%',
                                  backgroundPosition: 'center',
                                }
                              : undefined
                          }
                        >
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                            {activeLeg.type === 'cricket' ? `Restant ${teamAName}` : `Score ${teamAName}`}
                          </p>
                          <p className="font-display text-5xl text-white">{activeLeg.scoreA}</p>
                          <p className="mt-1 text-xs text-slate-300">
                            Fleches: {displayDartsA.length > 0 ? displayDartsA.join(' | ') : '-'}
                          </p>
                        </div>
                        <div
                          className="rounded-xl bg-slate-900 p-3 text-center"
                          style={
                            teamB?.photoDataUrl
                              ? {
                                  backgroundImage: `linear-gradient(rgba(2, 6, 23, 0.64), rgba(2, 6, 23, 0.64)), url(${teamB.photoDataUrl})`,
                                  backgroundSize: '100% 100%',
                                  backgroundPosition: 'center',
                                }
                              : undefined
                          }
                        >
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                            {activeLeg.type === 'cricket' ? `Restant ${teamBName}` : `Score ${teamBName}`}
                          </p>
                          <p className="font-display text-5xl text-white">{activeLeg.scoreB}</p>
                          <p className="mt-1 text-xs text-slate-300">
                            Fleches: {displayDartsB.length > 0 ? displayDartsB.join(' | ') : '-'}
                          </p>
                        </div>
                      </div>

                      {activeLeg.type === 'cricket' && (
                        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-700">
                          <table className="w-full min-w-[22rem] text-sm">
                            <thead className="bg-slate-900">
                              <tr>
                                <th className="px-2 py-2 text-left">Zone</th>
                                <th className="px-2 py-2 text-center">Equipe A</th>
                                <th className="px-2 py-2 text-center">Equipe B</th>
                              </tr>
                            </thead>
                            <tbody>
                              {CRICKET_TARGETS.map((target) => {
                                const key = String(target)
                                const marksA = activeLeg.cricketMarksA?.[key] ?? 0
                                const marksB = activeLeg.cricketMarksB?.[key] ?? 0
                                const bothClosed = marksA >= 3 && marksB >= 3
                                const oneClosed = (marksA >= 3 || marksB >= 3) && !bothClosed

                                return (
                                  <tr
                                    key={target}
                                    className={`border-t border-slate-800 ${
                                      bothClosed
                                        ? 'bg-rose-950/50'
                                        : oneClosed
                                          ? 'bg-emerald-900/30'
                                          : 'bg-slate-950/40'
                                    }`}
                                  >
                                    <td className="px-2 py-2 font-semibold">{target === 25 ? 'Bull' : target}</td>
                                    <td className="px-2 py-2 text-center font-mono">{renderCricketMarks(marksA)}</td>
                                    <td className="px-2 py-2 text-center font-mono">{renderCricketMarks(marksB)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <div className="mt-4 space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            { value: 1 as DartMultiplier, label: 'Simple' },
                            { value: 2 as DartMultiplier, label: 'Double' },
                            { value: 3 as DartMultiplier, label: 'Triple' },
                          ]).map((entry) => (
                            <button
                              key={entry.value}
                              type="button"
                              onClick={() => setSelectedMultiplier(entry.value)}
                              disabled={!canEditSelectedMatch || selectedMatch.status !== 'in_progress'}
                              className={`rounded-lg px-2 py-2 text-xs font-bold uppercase tracking-[0.15em] ${
                                selectedMultiplier === entry.value
                                  ? 'bg-amber-300 text-slate-950'
                                  : 'bg-slate-800 text-amber-200'
                              } disabled:cursor-not-allowed disabled:opacity-40`}
                            >
                              {entry.label}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-8 gap-1">
                          {activeScoreKeys.map((value) => (
                            <button
                              key={`score_${value}`}
                              type="button"
                              onClick={() => throwDart(value)}
                                  disabled={!canEditSelectedMatch || selectedMatch.status !== 'in_progress'}
                              className="rounded-md bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {getScoreKeyLabel(value)}
                            </button>
                          ))}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={undoDart}
                        disabled={!canEditSelectedMatch || (activeLeg.undoStack?.length ?? 0) === 0}
                        className="mt-4 w-full rounded-xl bg-rose-400 px-3 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Undo dernier coup
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </article>
        </section>
      )}
    </main>
  )
}

export default App
