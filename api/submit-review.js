// Open House: review submission endpoint.
//
// Receives a JSON body from the review form, normalises slider values to
// numbers, adds metadata (status, submittedAt) and POSTs to Airtable.
//
// Required environment variables (set these in the Vercel dashboard):
//   AIRTABLE_BASE_ID     e.g. appXXXXXXXXXXXXXX
//   AIRTABLE_TABLE_NAME  e.g. reviews
//   AIRTABLE_TOKEN       a Personal Access Token with data.records:write scope

// Numeric slider fields. Their values arrive as strings from the form;
// we cast them to integers before sending to Airtable.
const NUMERIC_FIELDS = [
  // Home
  'houseOverall', 'layout', 'kitchen', 'bathroom', 'laundry', 'parking',
  'naturalLight', 'privacy', 'soundInsulation',
  'insulationWinter', 'insulationSummer', 'insects', 'mould',
  // Noise
  'noiseNeighbour', 'noiseTraffic', 'noiseAirplane',
  // Building
  'facilityLift', 'facilityParking', 'facilityGym', 'facilityPool',
  // Suburb
  'localVibe', 'outdoorSpaces', 'localFoodOptions', 'streetParking',
  'publicTransport', 'trafficNeighbourhood', 'safety',
];

// Text fields. Values pass through as strings.
const TEXT_FIELDS = [
  // Property + address
  'propertyType',
  'userName', 'userEmail', 'apartmentNumber', 'streetAddress', 'suburb', 'state', 'postcode',
  // Per-section prose (open-ended)
  'descHome', 'goodHome', 'badHome',
  'descBuilding', 'goodBuilding', 'badBuilding',
  'descSuburb', 'goodSuburb', 'badSuburb',
  // Optional contextual notes
  'parkingNote', 'transportNote', 'anythingElse',
  // Old per-section notes (kept for backwards compatibility with the v1 form)
  'notesHome', 'notesNoise', 'notesBuilding', 'notesSuburb',
  // Local recommendations
  'bestCafes', 'bestCheapEats', 'bestLocalRestaurants', 'bestTakeout', 'bestBarsPubs', 'bestGroceries',
];

// Date fields (ISO strings).
const DATE_FIELDS = ['moveInDate', 'moveOutDate'];

export default async function handler(req, res) {
  // CORS for safety in case the form ever lives on a different origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !tableName || !token) {
    console.error('Missing Airtable env vars');
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  // Vercel parses JSON bodies automatically when Content-Type is application/json.
  const body = req.body || {};

  // Build a clean fields object, only including fields we expect.
  const fields = {};

  for (const key of TEXT_FIELDS) {
    if (typeof body[key] === 'string' && body[key].trim() !== '') {
      fields[key] = body[key].trim();
    }
  }

  for (const key of NUMERIC_FIELDS) {
    if (body[key] !== undefined && body[key] !== '') {
      const n = parseInt(body[key], 10);
      if (!Number.isNaN(n)) fields[key] = n;
    }
  }

  for (const key of DATE_FIELDS) {
    if (typeof body[key] === 'string' && body[key].trim() !== '') {
      // Accept either YYYY-MM or full ISO. Normalise to first-of-month ISO.
      const v = body[key].trim();
      if (/^\d{4}-\d{2}$/.test(v)) {
        fields[key] = new Date(v + '-01T00:00:00Z').toISOString();
      } else {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) fields[key] = d.toISOString();
      }
    }
  }

  // Soft validation: require at least an address fragment so we can attribute
  // the review to a property later.
  const hasAnyAddress = ['streetAddress', 'suburb', 'postcode'].some(
    (k) => typeof fields[k] === 'string' && fields[k].length > 0
  );
  if (!hasAnyAddress) {
    return res.status(400).json({
      error: 'Please tell us at least the street, suburb or postcode.',
    });
  }

  // Metadata.
  fields.status = 'pending';
  fields.submittedAt = new Date().toISOString();

  // POST to Airtable.
  const url =
    'https://api.airtable.com/v0/' +
    baseId +
    '/' +
    encodeURIComponent(tableName);

  try {
    const airtableResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!airtableResponse.ok) {
      const errorText = await airtableResponse.text();
      console.error('Airtable error:', airtableResponse.status, errorText);
      return res.status(502).json({
        error: 'Could not save your review. Please try again in a minute.',
      });
    }

    const result = await airtableResponse.json();
    return res.status(200).json({ success: true, id: result.id });
  } catch (err) {
    console.error('Submission error:', err);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
    });
  }
}
