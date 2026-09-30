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

// Default OE tolerance windows — same 3% height / 15% tread defaults used by
// the live plus-size search (see PLUS_SIZE_HEIGHT_TOLERANCE_PCT /
// PLUS_SIZE_TREAD_TOLERANCE_PCT in server.js), expressed here as fractions
// (0.03, not 3) so callers that don't pass an explicit tolerance still get
// sane upper/lower bounds precomputed onto every oe_tiresize document.
export const DEFAULT_HEIGHT_TOLERANCE = Number(process.env.PLUS_SIZE_HEIGHT_TOLERANCE_PCT) || 0.03;
export const DEFAULT_TREAD_TOLERANCE = Number(process.env.PLUS_SIZE_TREAD_TOLERANCE_PCT) || 0.15;

/**
 * Given a tire size, returns its overall height/tread width plus the
 * upper/lower bound of each at the given tolerance — e.g. for
 * 225/60R16 at 3%: height 26.63" -> lower 25.8311" / upper 27.4289".
 * Mirrors the "Upper & Lower Overall Height Limit" worksheet formula
 * exactly: tolerance = value * pct; lower = value - tolerance; upper = value + tolerance.
 *
 * The worksheet's own arithmetic rounds the height to 2 decimals BEFORE
 * multiplying by the tolerance percentage ("26.63 x 0.03", not
 * "26.629921... x 0.03") — so this does the same for the WINDOW
 * (heightUpperLimitIn/heightLowerLimitIn/treadUpperLimitIn/treadLowerLimitIn),
 * matching the worksheet's limits exactly rather than the ~0.0001" off you'd
 * get from tolerancing the full-precision value. overallHeightIn/treadWidthIn
 * themselves are returned at full precision, unrounded — that's the actual
 * computed size, not an intermediate used only for the tolerance math, and
 * callers (the /plus-size/search response, the oe_tiresize documents this
 * builds) should keep showing/storing that precise number, not the
 * 2-decimal one used only internally here to size the window.
 */
export function tireToleranceLimits(
  { width, aspect, rim },
  { heightTolerance = DEFAULT_HEIGHT_TOLERANCE, treadTolerance = DEFAULT_TREAD_TOLERANCE } = {}
) {
  const overallHeightIn = tireOverallHeightInches({ width, aspect, rim });
  const treadWidthIn = tireTreadWidthInches({ width });

  // Worksheet-rounded (2dp) bases — used only to size the tolerance window
  // below, never returned/displayed on their own.
  const heightForWindow = Math.round(overallHeightIn * 100) / 100;
  const treadForWindow = Math.round(treadWidthIn * 100) / 100;

  const heightDelta = heightForWindow * heightTolerance;
  const treadDelta = treadForWindow * treadTolerance;

  return {
    overallHeightIn,
    treadWidthIn,
    heightUpperLimitIn: heightForWindow + heightDelta,
    heightLowerLimitIn: heightForWindow - heightDelta,
    treadUpperLimitIn: treadForWindow + treadDelta,
    treadLowerLimitIn: treadForWindow - treadDelta,
  };
}
