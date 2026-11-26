// Priority from impact x urgency. Adapted from the reference implementation's ITIL matrix, which had five levels
// (critical/high/medium/low/very_low). Doc C defines p1..p4 (P5 is [OPEN]), so `low` and `very_low` collapse into p4:
//
//   Impact \ Urgency |  high  medium  low
//   high             |  p1    p2      p3
//   medium           |  p2    p3      p4
//   low              |  p3    p4      p4

export type Level = "low" | "medium" | "high";
export type Priority = "p1" | "p2" | "p3" | "p4";

export const PRIORITY_ORDER: readonly Priority[] = ["p1", "p2", "p3", "p4"];

const MATRIX: Record<Level, Record<Level, Priority>> = {
  high: { high: "p1", medium: "p2", low: "p3" },
  medium: { high: "p2", medium: "p3", low: "p4" },
  low: { high: "p3", medium: "p4", low: "p4" },
};

export function derivePriority(impact: Level, urgency: Level): Priority {
  return MATRIX[impact][urgency];
}

export function priorityLabel(p: Priority): string {
  return p.toUpperCase();
}
