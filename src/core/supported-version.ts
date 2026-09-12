export function versionInRange(version: string, range: string) {
  const clauses = range.trim().split(/\s+/);
  const parsed = parseVersion(version);
  return clauses.every((clause) => {
    const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!match) throw new Error("The signed supportedBudgetedRange is invalid.");
    const comparison = compare(parsed, parseVersion(match[2]));
    if (match[1] === ">=") return comparison >= 0;
    if (match[1] === ">") return comparison > 0;
    if (match[1] === "<=") return comparison <= 0;
    if (match[1] === "<") return comparison < 0;
    return comparison === 0;
  });
}

function parseVersion(value: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid stable semantic version ${value}.`);
  return match.slice(1).map(Number);
}

function compare(left: number[], right: number[]) {
  return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2]);
}
