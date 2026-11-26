// The only model years the app accepts anywhere a year can be picked or added
// (Vehicle Notes, saved comparisons, the Year dropdown list, imports).
// Keep in sync with MIN_MODEL_YEAR / MAX_MODEL_YEAR in client/src/utils/validation.js.
export const MIN_MODEL_YEAR = 1950;
export const MAX_MODEL_YEAR = 2030;

export const isValidModelYear = (value) => {
  const text = String(value ?? "").trim();
  if (!/^\d{4}$/.test(text)) return false;
  const n = Number(text);
  return n >= MIN_MODEL_YEAR && n <= MAX_MODEL_YEAR;
};

export const MODEL_YEAR_MESSAGE = `Year must be a 4-digit year between ${MIN_MODEL_YEAR} and ${MAX_MODEL_YEAR}.`;

/** "" (no year) is fine; anything else must be a valid model year. Returns a message or "". */
export const modelYearProblem = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return isValidModelYear(text) ? "" : MODEL_YEAR_MESSAGE;
};
