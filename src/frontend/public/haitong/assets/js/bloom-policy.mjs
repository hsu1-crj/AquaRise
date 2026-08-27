export function createFpsFuse({
  windowSize = 240,
  threshold = 30,
  sustainedWindows = 60,
  onTrip = () => {},
} = {}) {
  const samples = [];
  let average = 0;
  let lowWindows = 0;
  let tripped = false;

  function push(value) {
    if (tripped || !Number.isFinite(value) || value <= 0) return average;
    samples.push(value);
    if (samples.length > windowSize) samples.shift();
    average = samples.reduce((sum, fps) => sum + fps, 0) / samples.length;
    if (samples.length < windowSize) return average;
    lowWindows = average < threshold ? lowWindows + 1 : 0;
    if (lowWindows >= sustainedWindows) {
      tripped = true;
      onTrip({ average, threshold });
    }
    return average;
  }

  function reset() {
    samples.length = 0;
    average = 0;
    lowWindows = 0;
    tripped = false;
  }

  return {
    push,
    reset,
    get average() { return average; },
    get tripped() { return tripped; },
  };
}
