/**
 * Phone Number Normalization and Matching Utilities
 * Ensures consistent canonical formatting and robust cross-format matching
 * (e.g. +91 95791 60314, 919579160314, 09579160314, and 9579160314 all resolve and match)
 */

function normalizePhone(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  const cleaned = trimmed.replace(/[\s\-\(\)\.]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';

  // India mobile numbers (10 digits starting with 6, 7, 8, or 9)
  // 12 digits starting with 91: e.g. 919579160314 or +919579160314 -> 9579160314
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return digits.slice(2);
  }
  // 11 digits starting with 0: e.g. 09579160314 -> 9579160314
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) {
    return digits.slice(1);
  }
  // 10 digits starting with 6-9 -> 9579160314
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return digits;
  }

  // General international numbers with leading + (e.g., +15550001)
  if (cleaned.startsWith('+')) {
    return `+${digits}`;
  }

  return digits;
}

function phonesMatch(phone1, phone2) {
  if (!phone1 || !phone2) return false;
  if (phone1 === phone2) return true;

  const norm1 = normalizePhone(phone1);
  const norm2 = normalizePhone(phone2);
  if (norm1 && norm2 && norm1 === norm2) return true;

  const d1 = String(phone1).replace(/\D/g, '');
  const d2 = String(phone2).replace(/\D/g, '');
  if (d1 === d2) return true;

  // Suffix matching for national significant numbers (10 digits)
  if (d1.length >= 10 && d2.length >= 10) {
    if (d1.slice(-10) === d2.slice(-10)) return true;
  }

  return false;
}

module.exports = {
  normalizePhone,
  phonesMatch
};
