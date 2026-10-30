// utils/searchTokens.js
//
// Type-ahead ("autocomplete") search support, built on a MULTIKEY index.
//
// Every searchable document carries a hidden `searchTokens: [String]` array
// holding the lower-cased, accent-stripped *prefixes* (edge n-grams) of every
// word in its searchable fields:
//
//   "Toyota Hilux"  ->  ["t","to","toy","toyo","toyot","toyota","=toyota","h","hi","hil","hilu","hilux","=hilux"]
//
// Typing "toy hil" is then an indexed equality match on both prefixes
// ({ searchTokens: { $all: ["toy","hil"] } }) — no regex, no collection scan,
// and it works for partial words at any position ("hil" finds "Toyota Hilux").
//
// The "=word" tokens hold each COMPLETE word. They are used when a suggestion
// is picked from the type-ahead list: "Customer Name 2" must match the word
// "2" exactly, not every word that merely starts with 2 (20, 2029 ...).
//
// The array is maintained automatically by the plugin below (on save and on
// findOneAndUpdate). It is `select: false`, so it never travels to the client.
// Existing rows are filled in once with scripts/backfillSearchTokens.js.

import logToFile from "../logger.js";

export const EXACT = "="; // marks a whole-word token
export const MAX_WORD = 30; // longer words are compared on their first 30 characters
export const MIN_TYPED = 2; // a lone typed word shorter than this isn't searched (too broad)
export const MAX_PREFIX = 15; // longer words are indexed up to this many characters
const MAX_TOKENS = 300; // hard cap per document, keeps the index small
const MAX_QUERY_WORDS = 6;

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip accents: "Citroën" -> "citroen"
    .toLowerCase();

export const splitWords = (value) => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Edge-n-gram + whole-word tokens for a list of field values (strings / numbers / null). */
export function buildTokens(values) {
  const set = new Set();
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    for (const word of splitWords(value)) {
      set.add(EXACT + word.slice(0, MAX_WORD));
      const max = Math.min(word.length, MAX_PREFIX);
      for (let i = 1; i <= max; i += 1) set.add(word.slice(0, i));
    }
  }
  return [...set].slice(0, MAX_TOKENS);
}

/** The words the user typed (lower-cased, accent-free, max 6, de-duplicated). */
export const queryWords = (q) => [...new Set(splitWords(q).map((w) => w.slice(0, MAX_WORD)))].slice(0, MAX_QUERY_WORDS);

/**
 * Tokens to look up for the typed text, ready for `{ searchTokens: { $all: terms } }`.
 *  - typing (default): every word is a PREFIX, so "toy hil" finds "Toyota Hilux".
 *  - exact: every word must match a whole word — used after a suggestion is picked.
 * Longest first: the planner bounds the index scan on the first value, so the
 * most selective term should lead. A lone one-letter word typed on its own
 * isn't searched (it would match most of the collection).
 */
export function queryTerms(q, { exact = false } = {}) {
  const words = queryWords(q);
  if (!exact && words.length === 1 && words[0].length < MIN_TYPED) return [];
  const terms = words.map((w) => (exact ? EXACT + w : w.slice(0, MAX_PREFIX)));
  return terms.sort((a, b) => b.length - a.length);
}

/** Tire-size words so "225/65R17", "225 65 17" and "65r17" all find a 225/65 R17 row. */
export const tireSizeWords = (width, aspect, rim) =>
  [width, aspect, rim, aspect && rim ? `${aspect}r${rim}` : null, rim ? `r${rim}` : null].filter((v) => v !== null && v !== undefined && v !== "");

// --- Mongoose plugin ---------------------------------------------------------

const readPath = (obj, path) => path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

function updateTouches(update, watch) {
  if (!update) return false;
  if (Array.isArray(update)) return true; // aggregation-pipeline update: can't tell, be safe
  const keys = new Set(Object.keys(update).filter((k) => !k.startsWith("$")));
  for (const op of ["$set", "$unset", "$setOnInsert"]) {
    if (update[op]) Object.keys(update[op]).forEach((k) => keys.add(k));
  }
  return [...keys].some((k) => watch.some((w) => k === w || k.startsWith(`${w}.`)));
}

/**
 * schema.plugin(searchTokensPlugin, {
 *   watch:  ["name", "make", ...],            // root paths the tokens are built from
 *   fields: (get) => [get("name"), ...],      // values to tokenize; `get("a.b")` reads a (nested) path
 * })
 */
export function searchTokensPlugin(schema, { watch, fields }) {
  schema.add({ searchTokens: { type: [String], select: false, default: undefined } });

  const tokensFor = (plain) => buildTokens(fields((path) => readPath(plain, path)).flat());

  // create() / doc.save()
  schema.pre("save", function () {
    if (this.isNew || this.isModified(watch)) {
      this.searchTokens = tokensFor(this.toObject({ depopulate: true }));
    }
  });

  // findOneAndUpdate / findByIdAndUpdate — only when a searchable field changed
  // (gallery uploads, permission edits, etc. cost nothing extra). The document
  // is re-read so this is right whether or not the caller passed { new: true }.
  schema.post("findOneAndUpdate", async function (doc) {
    try {
      if (!doc || !updateTouches(this.getUpdate(), watch)) return;
      const fresh = await this.model.findById(doc._id).select(watch.join(" ")).lean();
      if (!fresh) return;
      await this.model.updateOne({ _id: doc._id }, { $set: { searchTokens: tokensFor(fresh) } });
    } catch (err) {
      logToFile(`[SearchTokens] could not refresh tokens for ${this.model.modelName}: ${err.message}`);
    }
  });
}
