// Open House: search-reviews endpoint.
//
// Takes a slug (or a raw address) and returns matching reviews from Airtable
// plus an AI-generated synopsis. Falls back through three levels of confidence:
//
//   1. "exact"    — same addressSlug (same unit/house)
//   2. "building" — same buildingSlug (same complex, any unit)
//   3. "suburb"   — same suburbSlug  (other reviews in the same suburb)
//   4. "empty"    — no reviews at any level
//
// Required env vars:
//   AIRTABLE_BASE_ID
//   AIRTABLE_TABLE_NAME
//   AIRTABLE_TOKEN
//   ANTHROPIC_API_KEY      (optional — falls back to placeholder synopsis)

import { slugsFromRaw, parseAddress, formatAddress } from './_lib/slugify.js';
import { summariseReviews } from './_lib/summarise.js';

/**
 * Fetch records from Airtable matching a filter formula.
 *
 * Returns [] on schema errors (e.g. an unknown field name in the formula)
 * rather than throwing, so the caller can fall back to a different query.
 * Throws on real connectivity / auth errors.
 */
async function fetchAirtable(baseId, tableName, token, filterFormula, maxRecords = 25) {
  const url =
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}` +
    `?filterByFormula=${encodeURIComponent(filterFormula)}` +
    `&maxRecords=${maxRecords}` +
    `&sort[0][field]=submittedAt&sort[0][direction]=desc`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const txt = await response.text();
    // 422 with "Unknown field" / "INVALID_FILTER_BY_FORMULA" means the column
    // referenced by the formula doesn't exist yet. Treat as "no matches"
    // so the caller can fall back to legacy queries.
    if (
      response.status === 422 &&
      /UNKNOWN_FIELD_NAME|Unknown field|INVALID_FILTER_BY_FORMULA/i.test(txt)
    ) {
      console.warn('Airtable schema fallback:', txt);
      return [];
    }
    throw new Error(`Airtable ${response.status}: ${txt}`);
  }

  const data = await response.json();
  return (data.records || []).map(r => ({ id: r.id, ...r.fields }));
}

function reviewSummaryFields(records) {
  // Shape the records for the public response — strip PII (email, full names).
  return records.map(r => ({
    id: r.id,
    firstNameInitial: makeDisplayName(r.userName || ''),
    moveInDate: r.moveInDate || null,
    moveOutDate: r.moveOutDate || null,
    propertyType: r.propertyType || null,
    descHome: r.descHome || null,
    goodHome: r.goodHome || null,
    badHome: r.badHome || null,
    descBuilding: r.descBuilding || null,
    goodBuilding: r.goodBuilding || null,
    badBuilding: r.badBuilding || null,
    descSuburb: r.descSuburb || null,
    goodSuburb: r.goodSuburb || null,
    badSuburb: r.badSuburb || null,
    notesNoise: r.notesNoise || null,
    anythingElse: r.anythingElse || null,
    // ratings (numbers) — pass through; the UI decides which to show.
    houseOverall: r.houseOverall ?? null,
    layout: r.layout ?? null,
    kitchen: r.kitchen ?? null,
    bathroom: r.bathroom ?? null,
    laundry: r.laundry ?? null,
    naturalLight: r.naturalLight ?? null,
    privacy: r.privacy ?? null,
    soundInsulation: r.soundInsulation ?? null,
    insulationWinter: r.insulationWinter ?? null,
    insulationSummer: r.insulationSummer ?? null,
    insects: r.insects ?? null,
    mould: r.mould ?? null,
    noiseNeighbour: r.noiseNeighbour ?? null,
    noiseTraffic: r.noiseTraffic ?? null,
    noiseAirplane: r.noiseAirplane ?? null,
    facilityLift: r.facilityLift ?? null,
    facilityParking: r.facilityParking ?? null,
    localVibe: r.localVibe ?? null,
    safety: r.safety ?? null,
    publicTransport: r.publicTransport ?? null,
    localFoodOptions: r.localFoodOptions ?? null,
  }));
}

function makeDisplayName(fullName) {
  if (!fullName) return 'Anonymous';
  const tokens = String(fullName).trim().split(/\s+/);
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[tokens.length - 1].charAt(0).toUpperCase()}.`;
}

/**
 * Compute mean rating across reviews for the keys requested.
 */
function aggregateRatings(reviews, keys) {
  const out = {};
  for (const k of keys) {
    const vals = reviews.map(r => r[k]).filter(v => typeof v === 'number');
    if (vals.length) {
      out[k] = {
        mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
        count: vals.length,
      };
    }
  }
  return out;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !tableName || !token) {
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  // Parse the incoming query. Accept either ?slug=... or ?address=...
  const url = new URL(req.url, `http://${req.headers.host}`);
  const slug = url.searchParams.get('slug');
  const raw  = url.searchParams.get('address');

  let parts;
  let addressSlug;
  let buildingSlug;
  let suburbSlug;
  let display;

  if (raw) {
    const r = slugsFromRaw(raw);
    parts = r;
    addressSlug = r.addressSlug;
    buildingSlug = r.buildingSlug;
    suburbSlug = r.suburbSlug;
    display = formatAddress(r);
  } else if (slug) {
    // The slug encodes the address. We can't reliably parse the parts back out
    // (unit-X-... vs no-unit), but we can still query by addressSlug and fall
    // back to building (everything after the unit segment) and suburb (last 2
    // segments). We also pass the slug as the display when we lack better text.
    addressSlug = slug;
    buildingSlug = slug.startsWith('unit-')
      ? slug.replace(/^unit-[^-]+-/, '')
      : slug;
    // The suburb slug is the last two hyphen-segments (suburb-postcode), if the
    // last segment looks like a 4-digit postcode.
    const segs = slug.split('-');
    if (/^\d{4}$/.test(segs[segs.length - 1]) && segs.length >= 2) {
      suburbSlug = segs.slice(-2).join('-');
    } else {
      suburbSlug = segs.slice(-1).join('-');
    }
    display = slug.replace(/-/g, ' ').replace(/\bunit (\w+)/, '$1 /').replace(/\b\w/g, c => c.toUpperCase());
    parts = parseAddress(display);
  } else {
    return res.status(400).json({ error: 'Provide ?slug=... or ?address=...' });
  }

  try {
    // 1. Exact match
    let scope = 'empty';
    let records = [];
    records = await fetchAirtable(
      baseId,
      tableName,
      token,
      `{addressSlug} = '${addressSlug.replace(/'/g, "\\'")}'`,
      25
    );

    if (records.length > 0) {
      scope = 'exact';
    } else {
      // 2. Building match (same complex, any unit)
      if (buildingSlug && buildingSlug !== addressSlug) {
        records = await fetchAirtable(
          baseId,
          tableName,
          token,
          `{buildingSlug} = '${buildingSlug.replace(/'/g, "\\'")}'`,
          25
        );
        if (records.length > 0) scope = 'building';
      }

      if (records.length === 0 && buildingSlug) {
        // If the new slug fields don't exist yet, fall back to legacy
        // streetAddress/suburb matching so old data still surfaces.
        records = await fetchAirtable(
          baseId,
          tableName,
          token,
          `AND(
            LOWER({streetAddress}) = '${(parts.street || '').toLowerCase().replace(/'/g, "\\'")}',
            LOWER({suburb}) = '${(parts.suburb || '').toLowerCase().replace(/'/g, "\\'")}'
          )`.replace(/\s+/g, ' '),
          25
        );
        if (records.length > 0) scope = 'building';
      }
    }

    // 3. Suburb match
    if (records.length === 0 && suburbSlug) {
      records = await fetchAirtable(
        baseId,
        tableName,
        token,
        `{suburbSlug} = '${suburbSlug.replace(/'/g, "\\'")}'`,
        25
      );
      if (records.length > 0) scope = 'suburb';
    }
    if (records.length === 0 && parts.suburb) {
      records = await fetchAirtable(
        baseId,
        tableName,
        token,
        `LOWER({suburb}) = '${parts.suburb.toLowerCase().replace(/'/g, "\\'")}'`,
        25
      );
      if (records.length > 0) scope = 'suburb';
    }

    const cleanedReviews = reviewSummaryFields(records);

    // Aggregate ratings according to scope.
    const ratingKeys =
      scope === 'exact'
        ? ['houseOverall', 'naturalLight', 'layout', 'kitchen', 'bathroom',
           'soundInsulation', 'insulationWinter', 'insulationSummer',
           'localVibe', 'publicTransport', 'safety', 'localFoodOptions']
        : scope === 'building'
        ? ['soundInsulation', 'facilityLift', 'facilityParking',
           'noiseNeighbour', 'localVibe', 'safety']
        : scope === 'suburb'
        ? ['localVibe', 'localFoodOptions', 'publicTransport', 'safety',
           'noiseTraffic']
        : [];
    const ratings = aggregateRatings(cleanedReviews, ratingKeys);

    // AI synopsis
    const ai = await summariseReviews({
      scope,
      addressDisplay: display,
      reviews: cleanedReviews,
    });

    return res.status(200).json({
      query: {
        addressSlug, buildingSlug, suburbSlug,
        raw: raw || null,
        parts: { unit: parts.unit, street: parts.street, suburb: parts.suburb,
                 state: parts.state, postcode: parts.postcode },
      },
      display,
      scope,
      reviewCount: cleanedReviews.length,
      reviews: cleanedReviews,
      ratings,
      summary: ai,
    });
  } catch (err) {
    console.error('search-reviews error:', err);
    return res.status(500).json({ error: 'Could not search reviews right now.' });
  }
};
