// Native logs print an opening array, comma-prefixed appended objects and a
// closing bracket separately, with stack traces between those fragments.
export function nativeObjects(line) {
  if (!/^\s*[\[,]?\s*\{\s*"Timestamp"\s*:/.test(line)) return [];
  const events = [];
  let start = 0;
  while (start < line.length) {
    while (start < line.length && /[\s\[\],]/.test(line[start])) start++;
    if (start === line.length) break;
    if (line[start] !== '{') throw new Error('Invalid native append');
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < line.length; end++) {
      const char = line[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    if (depth || quoted || end === line.length) throw new Error('Incomplete native event');
    const raw = line.slice(start, end + 1);
    events.push({ event: JSON.parse(raw), bytes: Buffer.byteLength(raw) });
    start = end + 1;
  }
  return events;
}
