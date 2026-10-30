export function stableVersion(tag: string): number[] {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) throw new Error("Expected a stable release tag");
  return match.slice(1).map(Number);
}
export function newer(candidate: string, current: string): boolean {
  const a = stableVersion(candidate), b = stableVersion(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
