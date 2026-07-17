// Mirrors client/src/utils/tireMath.js exactly — same formulas, same units
// (metric width in mm, aspect ratio in %, rim diameter in inches). Kept as a
// small standalone file (rather than importing across the client/server
// boundary) so each app can still build/deploy independently, but the math
// itself must stay identical between the two — if you change one, change
// the other.
export function tireOverallHeightInches({ width, aspect, rim }) {
  const sidewallMm = (width * aspect) / 100;
  const sidewallIn = sidewallMm / 25.4;
  return rim + sidewallIn * 2;
}

export function tireTreadWidthInches({ width }) {
  return width / 25.4;
}
