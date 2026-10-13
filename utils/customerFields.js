// Shared normalisation + validation for customer input, so the create and
// edit routes treat email / phone identically.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

// Keeps digits and a single leading "+", drops spaces, dashes, dots and
// brackets — so different ways of typing the same number collide on the
// unique index.
export const normalizePhone = (value) => {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  return raw.startsWith("+") ? `+${digits}` : digits;
};

// Returns { value } with cleaned fields, or { error } with a user-facing
// message. `partial` lets the edit route validate only what was sent.
export function parseCustomerInput(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.fullName !== undefined) {
    const fullName = String(body.fullName ?? "").trim().replace(/\s+/g, " ");
    if (!fullName) return { error: "Full name is required." };
    if (fullName.length > 120) return { error: "Full name is too long." };
    out.fullName = fullName;
  }

  if (!partial || body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!email) return { error: "Email is required." };
    if (!EMAIL_RE.test(email)) return { error: "Enter a valid email address." };
    out.email = email;
  }

  if (!partial || body.phone !== undefined) {
    const phone = normalizePhone(body.phone);
    if (!phone.replace(/\D/g, "")) return { error: "Phone is required." };
    const digitCount = phone.replace(/\D/g, "").length;
    if (digitCount < 7 || digitCount > 15) return { error: "Enter a valid phone number (7–15 digits)." };
    out.phone = phone;
  }

  return { value: out };
}
