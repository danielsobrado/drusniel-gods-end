/** A source recording may contain an entire walk. Keep one impact per contact. */
export function prepareFootstepBuffer(buffer, context, variant = 0) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const hop = Math.max(1, Math.round(buffer.sampleRate * 0.005));
  const energy = [];
  for (let start = 0; start < buffer.length; start += hop) {
    let sum = 0;
    const end = Math.min(buffer.length, start + hop);
    for (const channel of channels) for (let i = start; i < end; i++) sum += channel[i] ** 2;
    energy.push(Math.sqrt(sum / ((end - start) * channels.length)));
  }
  const peak = energy.reduce((max, value) => Math.max(max, value), 0);
  if (!peak) return buffer;
  const attacks = [];
  let quiet = 100, last = -100;
  for (let i = 0; i < energy.length; i++) {
    if (energy[i] < peak * 0.1) quiet++;
    else if (energy[i] > peak * 0.2) {
      if (quiet >= 12 && i - last >= 80) { attacks.push(i); last = i; }
      quiet = 0;
    }
  }
  const attack = attacks.length ? attacks[buffer.duration > 1 ? variant % attacks.length : 0] : 0;
  const start = Math.max(0, attack * hop - hop);
  const length = Math.min(buffer.length - start, Math.round(buffer.sampleRate * 0.4));
  const result = context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  const fade = Math.round(buffer.sampleRate * 0.035);
  for (let channel = 0; channel < channels.length; channel++) {
    const output = result.getChannelData(channel);
    output.set(channels[channel].subarray(start, start + length));
    for (let i = 0; i < length; i++) output[i] *= Math.min(1, i / Math.max(1, hop * 0.4), (length - 1 - i) / fade);
  }
  return result;
}
