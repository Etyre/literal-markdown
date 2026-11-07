// Line-based diff and three-way merge, used to fold changes made to the file on disk
// (by another program, typically an agent) into the document while it is being edited.

// Myers diff over arrays of lines. Returns the changed regions as hunks
// { aStart, aEnd, bStart, bEnd } (half-open line ranges in a and b).
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length;
  if (!N && !M) return [];
  const whole = [{ aStart: pre, aEnd: pre + N, bStart: pre, bEnd: pre + M }];
  if (!N || !M) return whole;

  const max = N + M, off = max + 1;
  const MAX_D = 2000;   // beyond this the diff is not worth computing; treat the middle as one hunk
  const trace = [];
  const v = new Int32Array(2 * max + 3);
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_D) return whole;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  // Walk the trace back, collecting the matched line pairs.
  const matches = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) ? k + 1 : k - 1;
    const prevX = vd[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; matches.push([x, y]); }
    if (d > 0) { x = prevX; y = prevY; }
  }
  matches.reverse();
  const hunks = [];
  let pa = 0, pb = 0;
  for (const [ma, mb] of matches) {
    if (ma > pa || mb > pb) hunks.push({ aStart: pre + pa, aEnd: pre + ma, bStart: pre + pb, bEnd: pre + mb });
    pa = ma + 1; pb = mb + 1;
  }
  if (N > pa || M > pb) hunks.push({ aStart: pre + pa, aEnd: pre + N, bStart: pre + pb, bEnd: pre + M });
  return hunks;
}

export const CONFLICT_START = '<<<<<<< yours (unsaved in editor)';
export const CONFLICT_MID = '======= theirs (on disk)';
export const CONFLICT_END = '>>>>>>> end of conflict';
export const isConflictMarker = (line) => line === CONFLICT_START || line === CONFLICT_MID || line === CONFLICT_END;

// Three-way merge of `theirs` into `ours`, both derived from `base` (arrays of lines).
// Returns edits against `ours` as { from, to, lines } line ranges, in ascending order.
// Where both sides changed the same lines, the edit wraps both versions in conflict markers
// so neither version is lost.
export function merge3(base, ours, theirs) {
  const ho = diffLines(base, ours).map((h) => ({ ...h, side: 'o' }));
  const ht = diffLines(base, theirs).map((h) => ({ ...h, side: 't' }));
  const all = [...ho, ...ht].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd);
  // Hunks that change the same base lines form one cluster, as do two insertions at the
  // same point (their order would be ambiguous). Changes that merely touch are independent.
  const clusters = [];
  for (const h of all) {
    const c = clusters[clusters.length - 1];
    const empty = (r) => r.aStart === r.aEnd;
    if (c && (h.aStart < c.aEnd || (h.aStart === c.aEnd && empty(h) && empty(c)))) {
      c.aEnd = Math.max(c.aEnd, h.aEnd); c.hunks.push(h); h.cluster = c;
    } else {
      const nc = { aStart: h.aStart, aEnd: h.aEnd, hunks: [h] };
      clusters.push(nc); h.cluster = nc;
    }
  }
  const delta = (h) => (h.bEnd - h.bStart) - (h.aEnd - h.aStart);
  // Where base line L of cluster `c` sits in one side's lines: shift by every hunk of that
  // side that comes before it. The cluster's own hunks count only for its end position, and
  // an insertion sitting exactly at the cluster's end stays after it.
  const mapPos = (hunks, L, c, isEnd) => hunks.reduce((p, h) => {
    if (h.cluster === c) return isEnd ? p + delta(h) : p;
    return (h.aEnd < L || (h.aEnd === L && (h.aStart < L || !isEnd))) ? p + delta(h) : p;
  }, L);
  const edits = [];
  let conflicts = 0;
  for (const c of clusters) {
    const hasO = c.hunks.some((h) => h.side === 'o'), hasT = c.hunks.some((h) => h.side === 't');
    if (!hasT) continue;
    const oS = mapPos(ho, c.aStart, c, false), oE = mapPos(ho, c.aEnd, c, true);
    const tS = mapPos(ht, c.aStart, c, false), tE = mapPos(ht, c.aEnd, c, true);
    const theirLines = theirs.slice(tS, tE);
    if (!hasO) { edits.push({ from: oS, to: oE, lines: theirLines }); continue; }
    conflicts++;
    edits.push({ from: oS, to: oE, lines: [CONFLICT_START, ...ours.slice(oS, oE), CONFLICT_MID, ...theirLines, CONFLICT_END] });
  }
  return { edits, conflicts };
}

// Apply line edits to an array of lines (used for testing; the editor applies them as changes).
export function applyLineEdits(lines, edits) {
  const out = lines.slice();
  for (let i = edits.length - 1; i >= 0; i--) out.splice(edits[i].from, edits[i].to - edits[i].from, ...edits[i].lines);
  return out;
}
