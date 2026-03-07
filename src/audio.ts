export function playVictorySound(): void {
  const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) {
    return
  }

  const context = new AudioCtx()
  const now = context.currentTime
  const notes = [523.25, 659.25, 783.99, 1046.5]

  notes.forEach((frequency, index) => {
    const osc = context.createOscillator()
    const gain = context.createGain()

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(frequency, now + index * 0.11)

    gain.gain.setValueAtTime(0.0001, now + index * 0.11)
    gain.gain.exponentialRampToValueAtTime(0.2, now + index * 0.11 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.11 + 0.1)

    osc.connect(gain)
    gain.connect(context.destination)

    osc.start(now + index * 0.11)
    osc.stop(now + index * 0.11 + 0.12)
  })
}
