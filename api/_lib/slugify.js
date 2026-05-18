// Open House: shared slug + address normalisation utilities.
//
// We compute three levels of slug for every review so that the results page
// can fall back gracefully: exact address → same building → same suburb.

export function normalise(str) {
  if (str == null) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')     // strip punctuation (keep alnum, space, hyphen)
    .replace(/\s+/g, '-')              // spaces → hyphen
    .replace(/-+/g, '-')               // collapse hyphens
    .replace(/^-|-$/g, '');            // trim hyphens
}

/**
 * Build the three slug levels for a review.
 *
 * @param {{unit?:string, street?:string, suburb?:string, state?:string, postcode?:string}} parts
 * @returns {{addressSlug:string, buildingSlug:string, suburbSlug:string}}
 */
export function buildSlugs(parts) {
  const unit = normalise(parts.unit || '');
  const street = normalise(parts.street || '');
  const suburb = normalise(parts.suburb || '');
  const state = normalise(parts.state || '');
  const postcode = normalise(parts.postcode || '');

  // Building = street + suburb + postcode (no unit). This is what apartments
  // in the same complex share.
  const buildingParts = [street, suburb, postcode].filter(Boolean);
  const buildingSlug = buildingParts.join('-');

  // Address = unit + buildingSlug. For houses with no unit, equals buildingSlug.
  const addressParts = unit ? [`unit-${unit}`, ...buildingParts] : buildingParts;
  const addressSlug = addressParts.join('-');

  // Suburb = suburb + postcode. Postcode disambiguates same-name suburbs across states.
  const suburbParts = [suburb, postcode].filter(Boolean);
  const suburbSlug = suburbParts.join('-');

  return { addressSlug, buildingSlug, suburbSlug };
}

/**
 * Parse a free-text address into its component parts.
 * Best-effort. Mapbox autocomplete is preferred but we accept raw input too.
 *
 * Examples it should handle:
 *  - "21/58-70 Orpington St, Ashfield NSW 2131"
 *  - "Apt 5, 58 Orpington Street, Ashfield NSW 2131"
 *  - "123 Fake Street Ashfield 2131"
 *  - "Ashfield NSW 2131"  (suburb-only search)
 */
export function parseAddress(raw) {
  if (!raw) return {};
  const s = String(raw).trim();

  const out = {
    raw: s,
    unit: '',
    street: '',
    suburb: '',
    state: '',
    postcode: '',
  };

  // Australian postcode is 4 digits at the end.
  const postcodeMatch = s.match(/(\d{4})\s*$/);
  if (postcodeMatch) {
    out.postcode = postcodeMatch[1];
  }

  // Australian state code (2-3 letters) before postcode.
  const stateMatch = s.match(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i);
  if (stateMatch) {
    out.state = stateMatch[1].toUpperCase();
  }

  // Strip postcode + state from the end to leave the address part.
  let body = s
    .replace(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i, '')
    .replace(/\d{4}\s*$/, '')
    .replace(/,\s*$/, '')
    .trim();

  // Look for unit prefix: "21/58", "Apt 5,", "Unit 12 -"
  const unitSlashMatch = body.match(/^(\d+[a-z]?)\s*\/\s*/i);
  if (unitSlashMatch) {
    out.unit = unitSlashMatch[1];
    body = body.slice(unitSlashMatch[0].length).trim();
  } else {
    const unitWordMatch = body.match(/^(?:apt|apartment|unit|u)\.?\s*(\d+[a-z]?)\s*[,\-]?\s*/i);
    if (unitWordMatch) {
      out.unit = unitWordMatch[1];
      body = body.slice(unitWordMatch[0].length).trim();
    }
  }

  // Now split remaining body on commas. Last comma-segment is suburb.
  const segments = body.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    out.street = segments[0];
    out.suburb = segments[segments.length - 1];
  } else if (segments.length === 1) {
    // No comma: guess by splitting on "last word(s) before postcode = suburb"
    // Heuristic: if first token starts with a number it's a street, last 1-2 words are suburb.
    const tokens = segments[0].split(/\s+/);
    if (/^\d/.test(tokens[0])) {
      // Likely "123 Fake Street Ashfield" — suburb is the last 1-2 words.
      // Heuristic: street type words (st, rd, ave, etc.) mark the end of the street.
      const streetTypeRegex = /^(st|street|rd|road|ave|avenue|dr|drive|ln|lane|cres|crescent|ct|court|pl|place|tce|terrace|hwy|highway|blvd|boulevard|pde|parade|cl|close|sq|square|wy|way)\.?$/i;
      let cutoff = -1;
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (streetTypeRegex.test(tokens[i])) {
          cutoff = i;
          break;
        }
      }
      if (cutoff !== -1 && cutoff < tokens.length - 1) {
        out.street = tokens.slice(0, cutoff + 1).join(' ');
        out.suburb = tokens.slice(cutoff + 1).join(' ');
      } else {
        // No detectable street-type word. Assume last token is suburb.
        out.street = tokens.slice(0, -1).join(' ');
        out.suburb = tokens[tokens.length - 1] || '';
      }
    } else {
      // No leading number — treat the whole thing as a suburb (e.g. "Ashfield").
      out.suburb = segments[0];
    }
  }

  return out;
}

/**
 * Build slugs from a free-text address.
 */
export function slugsFromRaw(raw) {
  const parts = parseAddress(raw);
  const slugs = buildSlugs(parts);
  return { ...parts, ...slugs };
}

/**
 * Build a human-friendly display string from parts.
 * Returns something like "21 / 58–70 Orpington St, Ashfield NSW 2131".
 */
export function formatAddress(parts) {
  if (!parts) return '';
  const head = parts.unit ? `${parts.unit} / ${parts.street || ''}`.trim() : (parts.street || '');
  const tail = [parts.suburb, parts.state, parts.postcode].filter(Boolean).join(' ');
  if (head && tail) return `${head}, ${tail}`;
  return head || tail || parts.raw || '';
}
