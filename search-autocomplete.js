/* ============================================================================
   Open House: shared address search + autocomplete.
   ----------------------------------------------------------------------------
   - Builds a slug for an address client-side (matches api/_lib/slugify.js).
   - Mapbox Geocoding suggestion dropdown (when window.OPEN_HOUSE_MAPBOX_TOKEN
     is set). Falls back to plain text submission if not.
   - On submit/selection: navigates to /property/<slug>.

   Drop into any page:
     <input id="searchInput" type="text" />
     <button id="searchSubmit">Search</button>
     <div id="searchSuggestions"></div>

     <script src="/search-autocomplete.js"></script>
     <script>OpenHouseSearch.init({ inputId: 'searchInput', submitId: 'searchSubmit', suggestId: 'searchSuggestions' });</script>
============================================================================ */

(function (global) {

  // ----- Slugify (must mirror api/_lib/slugify.js) -------------------------

  function normalise(str) {
    if (str == null) return '';
    return String(str)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function parseAddress(raw) {
    if (!raw) return {};
    const s = String(raw).trim();
    const out = { raw: s, unit: '', street: '', suburb: '', state: '', postcode: '' };

    const postMatch = s.match(/(\d{4})\s*$/);
    if (postMatch) out.postcode = postMatch[1];
    const stateMatch = s.match(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i);
    if (stateMatch) out.state = stateMatch[1].toUpperCase();

    let body = s
      .replace(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i, '')
      .replace(/\d{4}\s*$/, '')
      .replace(/,\s*$/, '')
      .trim();

    const unitSlash = body.match(/^(\d+[a-z]?)\s*\/\s*/i);
    if (unitSlash) {
      out.unit = unitSlash[1];
      body = body.slice(unitSlash[0].length).trim();
    } else {
      const unitWord = body.match(/^(?:apt|apartment|unit|u)\.?\s*(\d+[a-z]?)\s*[,\-]?\s*/i);
      if (unitWord) {
        out.unit = unitWord[1];
        body = body.slice(unitWord[0].length).trim();
      }
    }

    const segs = body.split(',').map(s => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      out.street = segs[0];
      out.suburb = segs[segs.length - 1];
    } else if (segs.length === 1) {
      const tokens = segs[0].split(/\s+/);
      if (/^\d/.test(tokens[0])) {
        const re = /^(st|street|rd|road|ave|avenue|dr|drive|ln|lane|cres|crescent|ct|court|pl|place|tce|terrace|hwy|highway|blvd|boulevard|pde|parade|cl|close|sq|square|wy|way)\.?$/i;
        let cutoff = -1;
        for (let i = tokens.length - 1; i >= 0; i--) {
          if (re.test(tokens[i])) { cutoff = i; break; }
        }
        if (cutoff !== -1 && cutoff < tokens.length - 1) {
          out.street = tokens.slice(0, cutoff + 1).join(' ');
          out.suburb = tokens.slice(cutoff + 1).join(' ');
        } else {
          out.street = tokens.slice(0, -1).join(' ');
          out.suburb = tokens[tokens.length - 1] || '';
        }
      } else {
        out.suburb = segs[0];
      }
    }
    return out;
  }

  function buildSlugs(parts) {
    const unit = normalise(parts.unit || '');
    const street = normalise(parts.street || '');
    const suburb = normalise(parts.suburb || '');
    const postcode = normalise(parts.postcode || '');
    const buildingParts = [street, suburb, postcode].filter(Boolean);
    const buildingSlug = buildingParts.join('-');
    const addressParts = unit ? [`unit-${unit}`, ...buildingParts] : buildingParts;
    const addressSlug = addressParts.join('-');
    const suburbSlug = [suburb, postcode].filter(Boolean).join('-');
    return { addressSlug, buildingSlug, suburbSlug };
  }

  function slugForAddress(raw) {
    const parts = parseAddress(raw);
    const { addressSlug } = buildSlugs(parts);
    return addressSlug || normalise(raw);
  }

  // ----- Navigation --------------------------------------------------------

  function goToProperty(raw) {
    if (!raw || !raw.trim()) return;
    const slug = slugForAddress(raw);
    if (!slug) return;
    // Pass original raw as a query param so the API can use the cleaner text
    // when the slug round-trip would lose detail (e.g. state code).
    const url = '/property/' + slug + '?address=' + encodeURIComponent(raw);
    window.location.href = url;
  }

  // ----- Mapbox suggestion dropdown (graceful: no-op without token) -------

  function mapboxToken() {
    return global.OPEN_HOUSE_MAPBOX_TOKEN || null;
  }

  let activeSuggestionsRequest = 0;
  let activeSuggestions = [];
  let activeIndex = -1;

  async function fetchSuggestions(q) {
    const token = mapboxToken();
    if (!token || q.length < 3) return [];
    const reqId = ++activeSuggestionsRequest;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
                `?access_token=${encodeURIComponent(token)}` +
                `&country=AU&autocomplete=true&types=address,place,locality,neighborhood,postcode&limit=6`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Mapbox ' + r.status);
      const data = await r.json();
      if (reqId !== activeSuggestionsRequest) return null; // stale
      return (data.features || []).map(f => ({
        label: f.place_name,
        center: f.center,
        context: f.context || [],
        text: f.text,
        address: f.address,
        placeType: (f.place_type || [])[0],
        raw: f,
      }));
    } catch (err) {
      console.warn('Mapbox suggest failed:', err);
      return [];
    }
  }

  function renderSuggestions(suggestEl, items) {
    if (!items || items.length === 0) {
      suggestEl.style.display = 'none';
      suggestEl.innerHTML = '';
      activeSuggestions = [];
      activeIndex = -1;
      return;
    }
    activeSuggestions = items;
    activeIndex = -1;
    suggestEl.style.display = '';
    suggestEl.innerHTML = items.map((s, i) => `
      <div class="oh-suggest-item" role="option" data-idx="${i}">
        <span class="oh-suggest-main">${escapeHtml(s.label.split(',')[0])}</span>
        <span class="oh-suggest-context">${escapeHtml(s.label.split(',').slice(1).join(', ').trim())}</span>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ----- Public API --------------------------------------------------------

  function init(opts) {
    const input = document.getElementById(opts.inputId);
    const button = opts.submitId ? document.getElementById(opts.submitId) : null;
    const form = input && input.closest('form');
    const suggestEl = opts.suggestId ? document.getElementById(opts.suggestId) : null;

    if (!input) {
      console.warn('OpenHouseSearch: input not found:', opts.inputId);
      return;
    }

    function submitNow(rawOverride) {
      const raw = (rawOverride != null) ? rawOverride : (input.value || '').trim();
      if (!raw) return;
      goToProperty(raw);
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submitNow();
      });
    }
    if (button) {
      button.addEventListener('click', function (e) {
        if (button.type === 'submit' && form) return; // form handler covers this
        e.preventDefault();
        submitNow();
      });
    }

    if (!suggestEl) return;

    // Debounce keystrokes
    let debounce;
    input.addEventListener('input', function () {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) {
        renderSuggestions(suggestEl, []);
        return;
      }
      debounce = setTimeout(async () => {
        const items = await fetchSuggestions(q);
        if (items === null) return; // stale
        renderSuggestions(suggestEl, items);
      }, 180);
    });

    input.addEventListener('keydown', function (e) {
      if (!activeSuggestions.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % activeSuggestions.length;
        updateActive(suggestEl);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + activeSuggestions.length) % activeSuggestions.length;
        updateActive(suggestEl);
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        submitNow(activeSuggestions[activeIndex].label);
      } else if (e.key === 'Escape') {
        renderSuggestions(suggestEl, []);
      }
    });

    suggestEl.addEventListener('mousedown', function (e) {
      const item = e.target.closest('.oh-suggest-item');
      if (!item) return;
      const idx = parseInt(item.dataset.idx, 10);
      if (!isNaN(idx) && activeSuggestions[idx]) {
        e.preventDefault();
        submitNow(activeSuggestions[idx].label);
      }
    });

    // Hide on outside click
    document.addEventListener('mousedown', function (e) {
      if (!suggestEl.contains(e.target) && e.target !== input) {
        suggestEl.style.display = 'none';
      }
    });
  }

  function updateActive(suggestEl) {
    const items = suggestEl.querySelectorAll('.oh-suggest-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  global.OpenHouseSearch = {
    init,
    slugForAddress,
    goToProperty,
    parseAddress,
    buildSlugs,
  };

})(window);
