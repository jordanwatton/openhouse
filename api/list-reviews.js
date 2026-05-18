// Open House: list-reviews endpoint.
// Returns a paginated list of all published reviews, newest first, for the
// browse page. Strips PII (only first name + last initial is exposed).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const token = process.env.AIRTABLE_TOKEN;
  if (!baseId || !tableName || !token) {
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}` +
              `?maxRecords=100` +
              `&sort[0][field]=submittedAt&sort[0][direction]=desc`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const txt = await r.text();
      console.error('Airtable list error:', r.status, txt);
      return res.status(502).json({ error: 'Could not load reviews right now.' });
    }
    const data = await r.json();
    const records = (data.records || []).map(rec => {
      const f = rec.fields || {};
      const firstNameInitial = (() => {
        const name = (f.userName || '').trim();
        if (!name) return 'Anonymous';
        const tokens = name.split(/\s+/);
        if (tokens.length === 1) return tokens[0];
        return `${tokens[0]} ${tokens[tokens.length - 1].charAt(0).toUpperCase()}.`;
      })();

      // Group reviews by their building so apartment listings appear once
      // even when multiple apartments in the same complex have been reviewed.
      // The buildingSlug is what we group on; addressSlug is what we link to.
      return {
        id: rec.id,
        addressSlug: f.addressSlug || null,
        buildingSlug: f.buildingSlug || null,
        suburbSlug: f.suburbSlug || null,
        propertyType: f.propertyType || null,
        unit: f.apartmentNumber || null,
        street: f.streetAddress || null,
        suburb: f.suburb || null,
        state: f.state || null,
        postcode: f.postcode || null,
        firstNameInitial,
        moveInDate: f.moveInDate || null,
        moveOutDate: f.moveOutDate || null,
        descHome: f.descHome || null,
        houseOverall: typeof f.houseOverall === 'number' ? f.houseOverall : null,
        submittedAt: f.submittedAt || null,
      };
    });

    // Group by buildingSlug (or addressSlug when no building info) to avoid
    // duplicate cards per building. Each group keeps the newest review as
    // representative and counts how many total there are.
    const groups = new Map();
    for (const r of records) {
      const key = r.buildingSlug || r.addressSlug || r.id;
      if (!groups.has(key)) {
        groups.set(key, { ...r, reviewCount: 1, addressSlug: r.addressSlug });
      } else {
        const g = groups.get(key);
        g.reviewCount += 1;
      }
    }

    return res.status(200).json({
      count: groups.size,
      properties: Array.from(groups.values()),
    });
  } catch (err) {
    console.error('list-reviews error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
