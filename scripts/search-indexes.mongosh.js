// scripts/search-indexes.mongosh.js
//
// Creates every index used by the paginated / type-ahead lists
// (Saved Comparisons, Tire Size Option, Vehicle Notes, User Management).
//
// Run it ONCE per environment, then run the backfill (see below):
//
//   mongosh "mongodb://localhost:27017/extremewheel" scripts/search-indexes.mongosh.js
//
// or paste the commands into an open mongosh session (`use extremewheel` first).
// Safe to re-run: createIndex is a no-op when an identical index already exists.
//
// The server never builds indexes on its own (autoIndex is off in config/db.js),
// so without this script the lists still work but scan the whole collection.
//
// Index names match the ones declared in models/*.js — keep them in sync.

// ---------------------------------------------------------------- Vehicle Notes
db.vehiclenotes.createIndex({ createdAt: -1, _id: -1 }, { name: "vn_created_idx" });
db.vehiclenotes.createIndex({ make: 1, model: 1, type: 1, createdAt: -1, _id: -1 }, { name: "vn_make_model_type_created_idx" });
db.vehiclenotes.createIndex({ year: 1, createdAt: -1, _id: -1 }, { name: "vn_year_created_idx" });
db.vehiclenotes.createIndex({ customer: 1, createdAt: -1, _id: -1 }, { name: "vn_customer_created_idx" });
// multikey (array of word prefixes) — powers type-ahead
db.vehiclenotes.createIndex({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "vn_search_tokens_idx" });
// text index — whole-word / stemmed fallback search
db.vehiclenotes.createIndex(
  { name: "text", make: "text", model: "text", type: "text", year: "text" },
  { name: "vn_text_idx", weights: { name: 10, make: 5, model: 5, type: 3, year: 1 }, default_language: "english" }
);

// ------------------------------------------------------------ Saved Comparisons
db.savedcomparisons.createIndex({ createdAt: -1, _id: -1 }, { name: "sc_created_idx" });
db.savedcomparisons.createIndex({ make: 1, model: 1, type: 1, createdAt: -1, _id: -1 }, { name: "sc_make_model_type_created_idx" });
db.savedcomparisons.createIndex({ year: 1, createdAt: -1, _id: -1 }, { name: "sc_year_created_idx" });
db.savedcomparisons.createIndex({ customer: 1, createdAt: -1, _id: -1 }, { name: "sc_customer_created_idx" });
db.savedcomparisons.createIndex({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "sc_search_tokens_idx" });
db.savedcomparisons.createIndex(
  { name: "text", make: "text", model: "text", type: "text", year: "text", "comparison.summary": "text" },
  {
    name: "sc_text_idx",
    weights: { name: 10, make: 5, model: 5, type: 3, year: 1, "comparison.summary": 4 },
    default_language: "english",
  }
);

// ------------------------------------------------------- Tire Size Option (presets)
db.tireoptions.createIndex({ createdAt: -1, _id: -1 }, { name: "to_created_idx" });
db.tireoptions.createIndex({ customer: 1, createdAt: -1, _id: -1 }, { name: "to_customer_created_idx" });
db.tireoptions.createIndex({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "to_search_tokens_idx" });
db.tireoptions.createIndex({ label: "text" }, { name: "to_text_idx", default_language: "english" });

// ------------------------------------------------------------------- Customers
// (customer-name search on the three lists above resolves ids through this)
db.customers.createIndex({ searchTokens: 1 }, { name: "cu_search_tokens_idx" });

// ----------------------------------------------------------------------- Users
db.users.createIndex({ createdAt: -1, _id: -1 }, { name: "us_created_idx" });
db.users.createIndex({ searchTokens: 1, createdAt: -1, _id: -1 }, { name: "us_search_tokens_idx" });
db.users.createIndex(
  { name: "text", email: "text" },
  { name: "us_text_idx", weights: { name: 10, email: 5 }, default_language: "english" }
);

print("Search / pagination indexes are in place. Now run:  npm run backfill:search-tokens");
