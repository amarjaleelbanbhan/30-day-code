export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** Line-level LCS diff (a → b). Bounded for very large notes. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: "del" as const, text: t })), ...y.map((t) => ({ op: "add" as const, text: t }))];
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: "same", text: x[i]! }); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: "del", text: x[i++]! });
    else out.push({ op: "add", text: y[j++]! });
  }
  while (i < n) out.push({ op: "del", text: x[i++]! });
  while (j < m) out.push({ op: "add", text: y[j++]! });
  return out;
}
