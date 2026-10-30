// utils/pagination.js
//
// Keyset ("cursor") pagination + type-ahead suggestions shared by the Saved
// Comparisons, Tire Size Option, Vehicle Notes and User Management lists.
//
// Why cursors instead of skip/limit: `skip(n)` makes MongoDB walk and throw away
// n documents on every request, so page 3,000 of a 50,000-row list is slow and
// rows shift between pages when something is added or deleted. A cursor says
// "give me the 10 rows after THIS one" and the compound index { createdAt:-1,
// _id:-1 } jumps straight there — every page costs the same, however deep.
//
// Search order of preference (see `search` below):
//   1. "tokens"  — indexed match on the multikey `searchTokens` field: word
//                   prefixes while typing, whole words once a suggestion is
//                   picked (`exact`).
//   2. "text"    — only if (1) found nothing on the first page: MongoDB's text
//                   index (whole words, English stemming: "tyres" ~ "tyre").

import crypto from "crypto";
import { decodeCursor, encodeCursor, CursorError } from "./cursor.js";
import { queryTerms, queryWords } from "./searchTokens.js";
import logToFile from "../logger.js";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;
const MAX_Q_LENGTH = 80;

export function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/** Trimmed, length-capped search string from a query-string value. */
export const cleanQuery = (raw) => (typeof raw === "string" ? raw.trim().slice(0, MAX_Q_LENGTH) : "");

/** Plain string from a query-string value (arrays / objects from `?a[b]=` tricks become ""). */
export const cleanString = (raw) => (typeof raw === "string" ? raw.trim().slice(0, 120) : "");

const fingerprintOf = (params) => {
  const stable = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .map((k) => [k, params[k]]);
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22);
};

// "Rows older than the cursor row" for a (createdAt desc, _id desc) ordering.
// The extra createdAt: { $lte } gives the planner a plain range to bound the
// index scan with; the $or then trims the ties on the boundary timestamp.
const afterCursor = (cur) => {
  const at = new Date(cur.t);
  return {
    $and: [
      { createdAt: { $lte: at } },
      { $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: cur.i } }] },
    ],
  };
};

/**
 * One page of a list.
 *
 * @param {object}   o
 * @param {Model}    o.Model
 * @param {string}   o.scope        list name; bound into the cursor
 * @param {string}   o.userId       signed-in user; bound into the cursor
 * @param {string}   [o.q]          the search box text
 * @param {boolean}  [o.exact]      whole-word matching (a suggestion was picked) instead of prefixes
 * @param {object}   [o.params]     the raw filter params (bound into the cursor so it can't be reused with other filters)
 * @param {object}   [o.filters]    the equivalent MongoDB filter fragment
 * @param {object[]} [o.searchAlso] extra `$or` branches for token search (e.g. { customer: { $in: ids } })
 * @param {number}   [o.limit]
 * @param {string}   [o.cursor]     the opaque cursor from the previous page
 * @param {string}   [o.select]
 * @param {Array}    [o.populate]   [[path, fields], ...]
 * @param {boolean}  [o.withTotal]  add a cheap estimated total (only sensible when nothing is filtered)
 */
export async function keysetPage({
  Model,
  scope,
  userId,
  q = "",
  exact = false,
  params = {},
  filters = {},
  searchAlso = [],
  limit = DEFAULT_PAGE_SIZE,
  cursor,
  select,
  populate = [],
  withTotal = false,
}) {
  const terms = queryTerms(q, { exact });
  const ctx = { scope, userId: String(userId), fp: fingerprintOf({ ...params, q: terms.join(" ") }) };
  const cur = cursor ? decodeCursor(cursor, ctx) : null;
  const hasFilters = Object.keys(filters).length > 0;

  const run = async (mode) => {
    const and = [];
    if (hasFilters) and.push(filters);
    if (terms.length) {
      if (mode === "text") and.push({ $text: { $search: q } });
      else {
        const tokenClause = { searchTokens: { $all: terms } };
        and.push(searchAlso.length ? { $or: [tokenClause, ...searchAlso] } : tokenClause);
      }
    }
    if (cur) and.push(afterCursor(cur));

    let query = Model.find(and.length ? { $and: and } : {})
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1); // one extra row tells us whether there is a next page without a count()
    if (select) query = query.select(select);
    for (const [path, fields] of populate) query = query.populate(path, fields);

    let rows;
    try {
      rows = await query.lean();
    } catch (err) {
      // The text pass is only a best-effort fallback for an otherwise empty
      // result (and needs the text index from scripts/search-indexes.mongosh.js),
      // so if it fails the list just stays empty instead of turning into a 500.
      if (mode !== "text") throw err;
      logToFile(`[Pagination] ${scope}: text search fallback failed (${err.message}). Is the text index created?`);
      rows = [];
    }

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id), m: mode }, ctx)
      : null;
    return { items, hasMore, nextCursor, mode };
  };

  // A cursor remembers which strategy produced it, so page 2 continues page 1's.
  let result = await run(cur?.m === "text" ? "text" : "tokens");
  if (!cur && result.items.length === 0 && terms.length > 0) result = await run("text");

  return {
    items: result.items,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    pageSize: limit,
    searchMode: terms.length ? result.mode : null, // "text" => "no exact matches, showing related results"
    total: withTotal && !terms.length && !hasFilters ? await Model.estimatedDocumentCount() : null,
  };
}

/**
 * Type-ahead suggestions: up to `max` distinct strings that the typed words are
 * prefixes of, newest records first. One indexed query for at most `scan` rows.
 *
 * @param {(doc) => {text:string, kind:string}[]} o.candidates  suggestion strings a matching document offers
 * @param {() => Promise<{text:string, kind:string}[]>} [o.extra]  additional suggestions from elsewhere (e.g. customer names)
 * @param {Record<string, number>} [o.caps]  at most this many suggestions of a kind (so "make"/"model"/"year" don't crowd out names)
 */
export async function suggest({ Model, q, filters = {}, select, candidates, extra, caps = {}, max = 8, scan = 40 }) {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const words = queryWords(q);

  const [docs, more] = await Promise.all([
    Model.find({ ...filters, searchTokens: { $all: terms } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(scan)
      .select(select)
      .lean(),
    extra ? extra() : [],
  ]);

  const matchesAll = (text) => {
    const textWords = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((w) => textWords.some((tw) => tw.startsWith(w)));
  };

  const seen = new Set();
  const scored = [];
  for (const c of [...more, ...docs.flatMap((d) => candidates(d))]) {
    if (!c?.text) continue;
    const key = c.text.toLowerCase();
    if (seen.has(key) || !matchesAll(c.text)) continue;
    seen.add(key);
    // Best first: the string *starts* with what was typed, then shorter strings.
    const startsWith = key.startsWith(words[words.length - 1]) || key.startsWith(String(q).trim().toLowerCase());
    scored.push({ ...c, score: (startsWith ? 0 : 1000) + key.length });
  }
  const perKind = {};
  return scored
    .sort((a, b) => a.score - b.score)
    .filter((c) => {
      perKind[c.kind] = (perKind[c.kind] || 0) + 1;
      return perKind[c.kind] <= (caps[c.kind] ?? max);
    })
    .slice(0, max)
    .map(({ text, kind }) => ({ text, kind }));
}

/** Wraps a page / suggest handler: an invalid cursor becomes a clean 400 the client can recover from. */
export const pageRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof CursorError) return res.status(400).json({ message: err.message, code: err.code });
    next(err);
  }
};
