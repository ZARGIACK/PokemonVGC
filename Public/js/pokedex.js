const API_URL = window.location.origin;

/* ===========================
   LOAD TYPES FROM DATABASE
=========================== */
function loadTypes() {
  fetch(`${API_URL}/types`)
    .then(res => res.json())
    .then(types => {
      const select = document.getElementById('typeFilter');
      types.forEach(t => {
        const option = document.createElement('option');
        option.value = t.type_name;
        option.textContent = t.type_name;
        select.appendChild(option);
      });
    })
    .catch(err => console.error('Failed to load types', err));
}

/* ===========================
  UTILITIES
=========================== */
function parseTypes(typesField) {
  if (!typesField) return [];
  if (Array.isArray(typesField)) return typesField.map(t => String(t).trim()).filter(Boolean);
  
  try {
   const parsed = JSON.parse(typesField);
   if (Array.isArray(parsed)) return parsed.map(t => String(t).trim()).filter(Boolean);
  } catch (e) {}
  // fallback: split on common delimiters
  const str = String(typesField);
  const parts = str.split(/[,\/|;]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 0) return parts;
  return [];
}

/* ===========================
  LOAD POKEMON WITH FILTERS
=========================== */
function loadPokemon() {
  // Close detail view if open
  const detail = document.getElementById('pokemon-detail');
  if (detail) detail.remove();
  
  const grid = document.getElementById('pokedex');
  grid.style.display = '';

  const filtersEl = document.querySelector('.filters');
  let errorEl = document.getElementById('searchError');
  if (!errorEl) {
    errorEl = document.createElement('div');
    errorEl.id = 'searchError';
    errorEl.style.color = 'red';
    errorEl.style.fontWeight = '600';
    errorEl.style.marginLeft = '8px';
    filtersEl.appendChild(errorEl);
  }

  const rawSearch = document.getElementById('searchInput').value;
  const search = rawSearch.trim();
  const type = document.getElementById('typeFilter').value;

  // Validate search: allow letters, numbers, spaces, apostrophes, hyphens, periods; max 50 chars
  const isValid = /^[A-Za-z0-9\s'\-.]{0,50}$/.test(search);
  if (!isValid) {
    errorEl.textContent = 'Use letters/numbers only (max 50 characters).';
    return;
  }
  errorEl.textContent = '';

  let url = `${API_URL}/pokemon?search=${encodeURIComponent(search)}`;
  if (type) url += `&type=${encodeURIComponent(type)}`;

  fetch(url)
    .then(res => res.json())
    .then(pokemon => {
      grid.innerHTML = '';

      if (!Array.isArray(pokemon) || pokemon.length === 0) {
        errorEl.textContent = 'No Pokémon found. Try another name or type.';
        return;
      }

      errorEl.textContent = '';

      pokemon.forEach(p => {
        const card = document.createElement('div');
        card.className = 'pokedex-card';

        const typesArr = parseTypes(p.types);
        const spriteUrl = `https://pokeapi.co/api/v2/pokemon/${p.id}`;

        card.innerHTML = `
              <img src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.id}.png" alt="${p.name}" style="width:96px;height:96px;object-fit:contain;margin-bottom:8px;" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/%3E%3C/svg%3E'">
              <h3>#${p.id} ${p.name}</h3>
              <div>
                ${typesArr.map(t => `<span class="type-badge type-${t.toLowerCase().replace(/\s+/g,'-')}">${t}</span>`).join('')}
              </div>
            `;

        // attach id and make card clickable to navigate to a detail view
        card.dataset.id = p.id;
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          // navigate to same page with query param (frontend can read ?id= to load details)
          window.location.href = `pokedex.html?id=${p.id}`;
        });

        grid.appendChild(card);
      });
    })
    .catch(err => {
      console.error('Failed to load pokemon list', err);
      grid.innerHTML = '';
      errorEl.textContent = 'Could not load Pokémon. Please try again.';
    });
}

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
  loadTypes();
  loadPokemon();

  // Add event listeners for search and filter
  document.getElementById('searchInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      loadPokemon();
    }
  });
  document.getElementById('searchBtn').addEventListener('click', loadPokemon);
});
document.getElementById('typeFilter').addEventListener('change', loadPokemon);

// If URL has ?id=, fetch and render detail view
function loadDetailFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) return;

  // Reset search inputs when loading detail
  document.getElementById('searchInput').value = '';
  document.getElementById('typeFilter').value = '';

  fetch(`${API_URL}/pokemon/${id}`)
    .then(res => {
      if (!res.ok) throw new Error('Not found');
      return res.json();
    })
    .then(p => renderDetail(p))
    .catch(err => {
      console.error('Failed to load pokemon detail', err);
    });
}

function renderDetail(p) {
  // hide grid
  const grid = document.getElementById('pokedex');
  grid.style.display = 'none';

  // remove existing detail if any
  let existing = document.getElementById('pokemon-detail');
  if (existing) existing.remove();

  const container = document.createElement('section');
  container.id = 'pokemon-detail';
  container.style.padding = '20px';
  const detailTypes = parseTypes(p.types);

  const stats = p.stats || {};
  const statConfig = [
    { key: 'hp', label: 'HP', color: '#f08030' },
    { key: 'attack', label: 'ATK', color: '#f83828' },
    { key: 'sp_atk', label: 'SP.ATK', color: '#a890f0' },
    { key: 'defence', label: 'DEF', color: '#f8b858' },
    { key: 'sp_def', label: 'SP.DEF', color: '#a8b820' },
    { key: 'spd', label: 'SPD', color: '#f85888' }
  ];
  const statsHtml = statConfig.map(({ key, label, color }) => {
    const val = stats[key] || 0;
    const pct = Math.min((val / 150) * 100, 100);
    return `<div class="stat-row"><span class="stat-label">${label}</span><div class="stat-bar-container"><div class="stat-bar" style="width:${pct}%;background-color:${color};"></div></div><span class="stat-value">${val}</span></div>`;
  }).join('');
  const totalStat = statConfig.reduce((sum, { key }) => sum + (stats[key] || 0), 0);

  // Use smaller sprite that works without GitHub raw
  const spriteUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.id}.png`;

  container.innerHTML = `
    <button id="detail-back" style="margin-bottom:12px;">← Back</button>
    <div style="text-align:center;margin:20px 0;">
      <img src="${spriteUrl}" alt="${p.name}" style="max-width:300px;width:100%;height:auto;object-fit:contain;background:#f5f5f5;border-radius:8px;padding:10px;" loading="lazy" onerror="this.style.display='none'">
    </div>
    <h2 style="text-align:center;">#${p.id} ${p.name}</h2>
    <div><strong>Types:</strong> <span class="type-row">${ detailTypes.map(t => `<span class="type-badge type-${t.toLowerCase().replace(/\s+/g,'-')}">${t}</span>`).join('') }</span></div>
    <div><strong>Abilities:</strong> ${ (p.abilities || []).join(', ') }</div>
    <div style="margin-top:16px;"><strong>Base Stats</strong><div class="stats-container" style="max-width:450px;">${statsHtml}<div class="stat-total">Total: ${totalStat}</div></div></div>
    <div style="margin-top:20px;"><strong>Moves Learned:</strong></div>
    <table class="moves-table">
      <thead>
        <tr>
          <th>Move</th>
          <th>Type</th>
          <th>Cat.</th>
          <th>Power</th>
          <th>Acc.</th>
        </tr>
      </thead>
      <tbody id="moves-list">
        ${ (p.moves || []).slice(0,100).map(m => {
          const category = m.category || 'status';
          const categoryText = category.charAt(0).toUpperCase() + category.slice(1);
          const power = m.power || '—';
          const accuracy = m.accuracy ? m.accuracy : (m.accuracy === null ? '∞' : '—');
          const moveType = (m.type || 'normal').toLowerCase().replace(/\s+/g, '-');
          const moveCode = m.code || '';
          return `<tr>
            <td><a href="#" class="move-link" data-move-code="${moveCode}" title="View details for ${m.name}">${m.name}</a></td>
            <td><span class="type-badge type-${moveType}">${(m.type || 'Normal').toUpperCase()}</span></td>
            <td><span class="category-text">${categoryText}</span></td>
            <td>${power}</td>
            <td>${accuracy}</td>
          </tr>`;
        }).join('') }
      </tbody>
    </table>
  `;

  document.querySelector('.main').appendChild(container);

  // Add move detail modal
  const modal = document.createElement('div');
  modal.id = 'move-modal';
  modal.className = 'move-modal';
  modal.innerHTML = `
    <div class="move-modal-content">
      <span class="move-modal-close">&times;</span>
      <h3 id="move-modal-title">Move Details</h3>
      <div id="move-modal-body"></div>
    </div>
  `;
  document.body.appendChild(modal);

  // Add click handlers for move links
  document.querySelectorAll('.move-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const moveCode = link.dataset.moveCode;
      if (moveCode) showMoveDetails(moveCode);
    });
  });

  // Modal close handler
  modal.querySelector('.move-modal-close').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  window.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  document.getElementById('detail-back').addEventListener('click', () => {
    // remove query param and show grid
    window.history.replaceState({}, '', 'pokedex.html');
    container.remove();
    grid.style.display = '';
  });
}

// run on load
loadDetailFromQuery();

// Function to show move details in modal
function showMoveDetails(moveCode) {
  const modal = document.getElementById('move-modal');
  const title = document.getElementById('move-modal-title');
  const body = document.getElementById('move-modal-body');

  body.innerHTML = '<p style="text-align:center;">Loading...</p>';
  modal.style.display = 'block';

  fetch(`${API_URL}/moves/${moveCode}`)
    .then(res => {
      if (!res.ok) throw new Error('Move not found');
      return res.json();
    })
    .then(move => {
      const categoryText = (move.category || 'status').charAt(0).toUpperCase() + (move.category || 'status').slice(1);
      const power = move.power || '—';
      const accuracy = move.accuracy ? move.accuracy : (move.accuracy === null ? '∞' : '—');
      const moveType = (move.type || 'normal').toLowerCase().replace(/\s+/g, '-');

      title.textContent = move.name;
      body.innerHTML = `
        <div class="move-detail-grid">
          <div class="move-detail-row">
            <strong>Type:</strong>
            <span class="type-badge type-${moveType}">${(move.type || 'Normal').toUpperCase()}</span>
          </div>
          <div class="move-detail-row">
            <strong>Category:</strong>
            <span>${categoryText}</span>
          </div>
          <div class="move-detail-row">
            <strong>Power:</strong>
            <span>${power}</span>
          </div>
          <div class="move-detail-row">
            <strong>Accuracy:</strong>
            <span>${accuracy}</span>
          </div>
        </div>
        ${move.effect ? `<div class="move-description">
          <strong>Description:</strong>
          <p>${move.effect}</p>
        </div>` : ''}
      `;
    })
    .catch(err => {
      console.error('Failed to load move details', err);
      body.innerHTML = '<p style="color:red;text-align:center;">Failed to load move details</p>';
    });
}
