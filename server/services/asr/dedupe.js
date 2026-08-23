function normalizedCharacters(text) {
  return [...String(text || '').normalize('NFKC').toLowerCase()]
    .filter((char) => !/[\s\p{P}\p{S}]/u.test(char));
}

export function removeTextOverlap(previous, current, { maxWindow = 80, minOverlap = 2 } = {}) {
  const raw = String(current || '').trim();
  if (!raw || !previous) return raw;
  const a = normalizedCharacters(previous).slice(-maxWindow);
  const rawChars = [...raw];
  const bWithRaw = rawChars.map((char, index) => ({ char, index }))
    .filter(({ char }) => !/[\s\p{P}\p{S}]/u.test(char))
    .map(({ char, index }) => ({ char: char.normalize('NFKC').toLowerCase(), index }));
  const b = bWithRaw.map(({ char }) => char).slice(0, maxWindow);
  const max = Math.min(a.length, b.length);
  let overlap = 0;
  for (let length = max; length >= minOverlap; length--) {
    if (a.slice(-length).join('') === b.slice(0, length).join('')) { overlap = length; break; }
  }
  if (!overlap) return raw;
  const rawIndex = bWithRaw[overlap - 1]?.index;
  return rawIndex == null ? raw : raw.slice(rawIndex + 1).replace(/^[\s\p{P}\p{S}]+/u, '').trim();
}
