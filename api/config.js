// Open House: public client-side config.
//
// Returns the Mapbox public token (pk.*) which is safe to expose to the
// browser. We serve it from a server endpoint rather than embedding it in
// HTML so that GitHub's secret scanner doesn't flag pushes.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    mapboxToken: process.env.MAPBOX_TOKEN || null,
  });
}
