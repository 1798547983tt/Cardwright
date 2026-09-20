/** Synthesized interface cues (Web Audio). No audio files are shipped or downloaded. */
export type Cue = 'click' | 'send' | 'page' | 'boot' | 'complete' | 'approval' | 'truncated';

let context: AudioContext | undefined;
let master: GainNode | undefined;
let enabled = true;
let volume = 40;

export function configureSound(options: { enabled: boolean; volume: number }): void {
  enabled = options.enabled;
  volume = Math.max(0, Math.min(100, options.volume));
  if (master && context) master.gain.setTargetAtTime(volume / 100 * 0.5, context.currentTime, 0.02);
}

function audio(): { ctx: AudioContext; out: GainNode } | undefined {
  try {
    if (!context) {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = volume / 100 * 0.5;
      master.connect(context.destination);
    }
    if (context.state === 'suspended') void context.resume();
    return { ctx: context, out: master! };
  } catch { return undefined; }
}

function tone(frequency: number, duration: number, { type = 'square' as OscillatorType, gain = 0.06, slideTo, delay = 0 }: { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number } = {}): void {
  const target = audio(); if (!target) return;
  const { ctx, out } = target; const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator(); const amp = ctx.createGain(); const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 3400;
  oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(filter).connect(amp).connect(out);
  oscillator.start(start); oscillator.stop(start + duration + 0.03);
}

function noise(duration: number, from: number, to: number, gain = 0.07): void {
  const target = audio(); if (!target) return;
  const { ctx, out } = target; const start = ctx.currentTime;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index++) data[index] = (Math.random() * 2 - 1) * (1 - index / data.length);
  const source = ctx.createBufferSource(); source.buffer = buffer;
  const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 2;
  band.frequency.setValueAtTime(from, start); band.frequency.exponentialRampToValueAtTime(to, start + duration);
  const amp = ctx.createGain(); amp.gain.value = gain;
  source.connect(band).connect(amp).connect(out); source.start(start);
}

const cues: Record<Cue, () => void> = {
  click: () => { tone(880, 0.05, { gain: 0.045 }); tone(1320, 0.05, { gain: 0.03, delay: 0.035 }); },
  send: () => { tone(420, 0.18, { type: 'sawtooth', gain: 0.04, slideTo: 1400 }); noise(0.2, 700, 3600, 0.04); },
  page: () => noise(0.24, 600, 4200, 0.055),
  boot: () => { tone(220, 0.25, { type: 'sawtooth', gain: 0.04, slideTo: 660 }); tone(990, 0.12, { gain: 0.04, delay: 0.26 }); tone(1480, 0.22, { type: 'sine', gain: 0.05, delay: 0.36 }); },
  complete: () => { tone(660, 0.1, { type: 'triangle', gain: 0.06 }); tone(880, 0.1, { type: 'triangle', gain: 0.06, delay: 0.09 }); tone(1320, 0.2, { type: 'triangle', gain: 0.06, delay: 0.18 }); },
  approval: () => { tone(740, 0.12, { type: 'triangle', gain: 0.07 }); tone(554, 0.18, { type: 'triangle', gain: 0.07, delay: 0.14 }); },
  truncated: () => { tone(520, 0.12, { gain: 0.05 }); tone(390, 0.22, { gain: 0.05, delay: 0.13 }); },
};

/** Plays nothing while disabled, muted or when the window is not in the foreground. */
export function playCue(cue: Cue, force = false): void {
  if (!force && (!enabled || volume === 0 || !document.hasFocus())) return;
  cues[cue]();
}

/** Delegated click cue for buttons, menu items and tabs; the send button owns its own cue. */
export function installClickSounds(root: HTMLElement): () => void {
  const listener = (event: MouseEvent) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('button, [role="menuitem"], [role="tab"], [role="option"]');
    if (!target || target.matches(':disabled, .send-button, [aria-disabled="true"]') || target.closest('.boot-overlay')) return;
    playCue('click');
  };
  root.addEventListener('click', listener);
  return () => root.removeEventListener('click', listener);
}
