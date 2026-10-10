// Recovered from content.js (lines 1694-1713)

const BAG: number[] = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) BAG.push(a + b);

export function createDice(rng: () => number, balanced = true): () => number {
  let bag: number[] = [];
  const refill = () => {
    bag = BAG.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swap = bag[i];
      bag[i] = bag[j];
      bag[j] = swap;
    }
  };
  return () => {
    if (!balanced) return 1 + Math.floor(rng() * 6) + 1 + Math.floor(rng() * 6);
    if (!bag.length) refill();
    return bag.pop()!;
  };
}
