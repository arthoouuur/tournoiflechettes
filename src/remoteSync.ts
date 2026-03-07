import type { RealtimeChannel } from '@supabase/supabase-js'
import type { TournamentState } from './models'
import { supabase } from './supabase'

const TOURNAMENT_ROW_ID = 'main'
const LOCK_TTL_MINUTES = 20

export interface MatchLock {
  matchId: string
  ownerId: string
  ownerLabel: string
  expiresAtIso: string
}

interface TournamentRow {
  id: string
  state: TournamentState
  updated_at: string
  updated_by: string | null
}

interface RefereeLockRow {
  id: string
  owner_id: string
  owner_label: string
  expires_at: string
}

function ensureSupabase() {
  if (!supabase) {
    throw new Error('Supabase non configure')
  }
  return supabase
}

function addMinutesToNow(minutes: number): string {
  const next = new Date(Date.now() + minutes * 60 * 1000)
  return next.toISOString()
}

export function isLockExpired(lock?: MatchLock | null): boolean {
  if (!lock) {
    return true
  }
  return new Date(lock.expiresAtIso).getTime() <= Date.now()
}

function rowToLock(row?: RefereeLockRow | null): MatchLock | null {
  if (!row) {
    return null
  }
  return {
    matchId: row.id,
    ownerId: row.owner_id,
    ownerLabel: row.owner_label,
    expiresAtIso: row.expires_at,
  }
}

export async function fetchRemoteTournamentState(): Promise<TournamentState | null> {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('tournament_state')
    .select('id,state,updated_at,updated_by')
    .eq('id', TOURNAMENT_ROW_ID)
    .maybeSingle<TournamentRow>()

  if (error) {
    throw error
  }

  return data?.state ?? null
}

export async function saveRemoteTournamentState(
  state: TournamentState,
  actorId: string,
  actorLabel: string,
): Promise<void> {
  const client = ensureSupabase()
  const { error } = await client.from('tournament_state').upsert(
    {
      id: TOURNAMENT_ROW_ID,
      state,
      updated_by: `${actorLabel} (${actorId.slice(0, 6)})`,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )

  if (error) {
    throw error
  }
}

export async function fetchMatchLock(matchId: string): Promise<MatchLock | null> {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('referee_lock')
    .select('id,owner_id,owner_label,expires_at')
    .eq('id', matchId)
    .maybeSingle<RefereeLockRow>()

  if (error) {
    throw error
  }

  return rowToLock(data)
}

export async function fetchAllMatchLocks(): Promise<MatchLock[]> {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('referee_lock')
    .select('id,owner_id,owner_label,expires_at')

  if (error) {
    throw error
  }

  const locks = (data ?? [])
    .map((row) => rowToLock(row as RefereeLockRow))
    .filter((row): row is MatchLock => row !== null)

  return locks.filter((lock) => !isLockExpired(lock))
}

export async function tryAcquireMatchLock(
  matchId: string,
  ownerId: string,
  ownerLabel: string,
): Promise<boolean> {
  const client = ensureSupabase()
  const currentLock = await fetchMatchLock(matchId)
  const lockOwnerIsMe = currentLock?.ownerId === ownerId

  if (currentLock && !isLockExpired(currentLock) && !lockOwnerIsMe) {
    return false
  }

  const { error } = await client.from('referee_lock').upsert(
    {
      id: matchId,
      owner_id: ownerId,
      owner_label: ownerLabel,
      expires_at: addMinutesToNow(LOCK_TTL_MINUTES),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )

  if (error) {
    throw error
  }

  return true
}

export async function heartbeatOwnedMatchLocks(ownerId: string, ownerLabel: string): Promise<void> {
  const client = ensureSupabase()
  const locks = await fetchAllMatchLocks()
  const ownedMatchIds = locks.filter((lock) => lock.ownerId === ownerId).map((lock) => lock.matchId)
  for (const matchId of ownedMatchIds) {
    const { error } = await client
      .from('referee_lock')
      .update({
        owner_label: ownerLabel,
        expires_at: addMinutesToNow(LOCK_TTL_MINUTES),
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .eq('owner_id', ownerId)

    if (error) {
      throw error
    }
  }
}

export async function releaseMatchLock(matchId: string, ownerId: string): Promise<void> {
  const client = ensureSupabase()
  const { error } = await client
    .from('referee_lock')
    .delete()
    .eq('id', matchId)
    .eq('owner_id', ownerId)

  if (error) {
    throw error
  }
}

export function subscribeToTournamentState(onChange: () => void): RealtimeChannel {
  const client = ensureSupabase()
  return client
    .channel('tournament-sync')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tournament_state',
      },
      () => onChange(),
    )
    .subscribe()
}

export function subscribeToRefereeLock(onChange: () => void): RealtimeChannel {
  const client = ensureSupabase()
  return client
    .channel('referee-lock-sync')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'referee_lock',
      },
      () => onChange(),
    )
    .subscribe()
}

export function unsubscribeChannel(channel: RealtimeChannel): void {
  if (!supabase) {
    return
  }
  void supabase.removeChannel(channel)
}
