// middleware/sanitize.js
//
// NoSQL operator-injection guard. A JSON body such as
//     { "email": { "$ne": null } }          or        { "image": { "$ne": null } }
// can slip a MongoDB operator into a query or update (log in without knowing the
// email, `$pull` every gallery photo, …). No legitimate request from this app
// ever sends a key that starts with "$", so any request that does is refused
// outright instead of being "cleaned" and processed.
//
// Checked: the parsed JSON body and the query string. (Express 5's default query
// parser is the flat one, which yields keys like "make[$ne]" rather than nested
// objects, so for the query string a "$" anywhere in a key name is refused.)
// The scan is iterative, so a maliciously deep body can't overflow the stack.

function bodyHasOperatorKey(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === "object") stack.push(item);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (key.startsWith("$")) return true;
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return false;
}

export function rejectOperatorKeys(req, res, next) {
  const queryKeys = req.query ? Object.keys(req.query) : [];
  if (queryKeys.some((key) => key.includes("$")) || bodyHasOperatorKey(req.body)) {
    return res.status(400).json({ message: "Invalid request." });
  }
  next();
}

// Express 5 leaves req.body undefined when a request carries no body, so the
// `const { email } = req.body` in a handler would throw (a 500). Give handlers
// an empty object instead, so they answer with their normal 400 validation.
export function ensureBody(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}
