export function hash(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, y) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fadeX = smooth(x - cellX);
  const fadeY = smooth(y - cellY);

  const top = hash(cellX, cellY) * (1 - fadeX) + hash(cellX + 1, cellY) * fadeX;
  const bottom = hash(cellX, cellY + 1) * (1 - fadeX) + hash(cellX + 1, cellY + 1) * fadeX;
  return top * (1 - fadeY) + bottom * fadeY;
}

export function fbm(x, y, octaves = 4) {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let octave = 0; octave < octaves; octave++) {
    total += amplitude * valueNoise(x * frequency, y * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return total;
}
