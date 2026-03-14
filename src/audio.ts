import type { CustomSoundKey, CustomSoundMap } from './models'

function getAudioContext(): AudioContext | null {
  const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) {
    return null
  }

  return new AudioCtx()
}

function playCustomSoundIfAvailable(key: CustomSoundKey, customSounds?: CustomSoundMap): boolean {
  try {
    const src = customSounds?.[key]
    if (!src) {
      return false
    }

    const audio = new Audio(src)
    audio.currentTime = 0
    void audio.play()
    return true
  } catch {
    return false
  }
}

function playNotes(context: AudioContext, notes: number[], volume = 0.2, stepSeconds = 0.11, tone: OscillatorType = 'triangle'): void {
  const now = context.currentTime

  notes.forEach((frequency, index) => {
    const osc = context.createOscillator()
    const gain = context.createGain()

    osc.type = tone
    osc.frequency.setValueAtTime(frequency, now + index * stepSeconds)

    gain.gain.setValueAtTime(0.0001, now + index * stepSeconds)
    gain.gain.exponentialRampToValueAtTime(volume, now + index * stepSeconds + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * stepSeconds + 0.1)

    osc.connect(gain)
    gain.connect(context.destination)

    osc.start(now + index * stepSeconds)
    osc.stop(now + index * stepSeconds + 0.12)
  })
}

export function playVictorySound(customSounds?: CustomSoundMap): void {
  if (playCustomSoundIfAvailable('victory', customSounds)) {
    return
  }

  const context = getAudioContext()
  if (!context) {
    return
  }

  const notes = [523.25, 659.25, 783.99, 1046.5]
  playNotes(context, notes, 0.5, 0.11, 'triangle')
}

export function playScoreBandSound(score: number, customSounds?: CustomSoundMap): void {
  if (score < 10 && playCustomSoundIfAvailable('score_low', customSounds)) {
    return
  }

  // 10-40: no sound requested
  if (score >= 10 && score <= 40) {
    return
  }

  if (score >= 40 && score <= 60 && playCustomSoundIfAvailable('score_40_60', customSounds)) {
    return
  }

  if (score > 60 && score <= 80 && playCustomSoundIfAvailable('score_60_80', customSounds)) {
    return
  }

  if (score > 80 && playCustomSoundIfAvailable('score_80_plus', customSounds)) {
    return
  }

  // Backward compatibility for previously configured custom keys.
  if (score >= 40 && score <= 60 && playCustomSoundIfAvailable('score_mid' as CustomSoundKey, customSounds)) {
    return
  }
  if (score > 60 && playCustomSoundIfAvailable('score_high' as CustomSoundKey, customSounds)) {
    return
  }

  const context = getAudioContext()
  if (!context) {
    return
  }

  if (score < 10) {
    playNotes(context, [220, 196], 0.5, 0.1, 'sine')
    return
  }

  if (score >= 40 && score <= 60) {
    playNotes(context, [392, 523.25], 0.5, 0.09, 'square')
    return
  }

  if (score > 60 && score <= 80) {
    playNotes(context, [523.25, 659.25, 783.99], 0.5, 0.08, 'sawtooth')
    return
  }

  if (score > 80) {
    playNotes(context, [659.25, 783.99, 987.77], 0.5, 0.08, 'sawtooth')
  }
}

export function playCricketZeroTurnSound(customSounds?: CustomSoundMap): void {
  if (playCustomSoundIfAvailable('cricket_zero_turn', customSounds)) {
    return
  }

  const context = getAudioContext()
  if (!context) {
    return
  }

  playNotes(context, [174.61, 164.81, 155.56], 0.5, 0.1, 'triangle')
}
