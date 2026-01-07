let favorites = [];

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.classList.add('show'), 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

async function loadFavorites() {
    try {
        const token = localStorage.getItem('accessToken');
        if (!token) {
            favorites = [];
            return;
        }

        const response = await authFetch(`${window.location.origin}/api/favorite`, {
            method: 'GET'
        });

        if (response.ok) {
            const data = await response.json();
            favorites = data.favoritePokemon ? [data.favoritePokemon] : [];
        } else {
            // Keep current favorites on non-OK to avoid flicker
            console.warn('Favorites load failed with status', response.status);
        }
    } catch (e) {
        console.error('Error loading favorites:', e);
        // Keep current favorites on error
    }
}

async function saveFavorites() {
    try {
        const token = localStorage.getItem('accessToken');
        if (!token) return;

        if (favorites.length === 0) {
            // Remove favorite
            await authFetch(`${window.location.origin}/api/favorite`, {
                method: 'DELETE'
            });
        } else {
            // Set favorite
            await authFetch(`${window.location.origin}/api/favorite`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ pokemonId: favorites[0].id })
            });
        }
    } catch (e) {
        console.error('Error saving favorites:', e);
    }
}

function renderFavorites() {
    const list = document.getElementById('favoritesList');
    if (!list) return;

    if (!favorites.length) {
        list.innerHTML = '<div style="color:#888; text-align:center; padding:12px;">No favourites yet. Search and add some!</div>';
        return;
    }

    list.innerHTML = favorites.map(f => {
        const spriteUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${f.id}.png`;
        return `
            <div class="fav-card">
                <img src="${spriteUrl}" alt="${f.name}" width="80" height="80" onerror="this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/0.png'">
                <div class="fav-name">${f.name}</div>
                <button class="fav-remove" onclick="removeFavorite(${f.id})">Remove</button>
            </div>
        `;
    }).join('');
}

async function addFavorite(id, name, buttonEl) {
    // Disable button to prevent double-submit
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Adding...';
    }
    
    // Only keep a single favourite at a time
    favorites = [{ id, name }];
    await saveFavorites();
    renderFavorites();
    
    showToast(`${name} added to favourites!`, 'success');
    
    // Re-enable button after delay
    if (buttonEl) {
        setTimeout(() => {
            buttonEl.disabled = false;
            buttonEl.textContent = 'Add to favourites';
        }, 1000);
    }
}

async function removeFavorite(id) {
    const removed = favorites.find(f => f.id === id);
    favorites = favorites.filter(f => f.id !== id);
    await saveFavorites();
    renderFavorites();
    
    if (removed) {
        showToast(`${removed.name} removed from favourites`, 'success');
    }
}

function searchPokemon() {
    const input = document.getElementById('pokeInput').value;
    const resultsDiv = document.getElementById('results');

    if (!input) return;

    // Fetch from the API using current domain
    fetch(`${window.location.origin}/pokemon/search?name=${input}`)
        .then(res => res.json())
        .then(data => {
            resultsDiv.innerHTML = '';
            
            if (data.length === 0) {
                resultsDiv.innerHTML = '<p>No Pokémon found.</p>';
                return;
            }

            // Group by Pokémon ID to handle multiple abilities/types
            const pokemonMap = new Map();
            data.forEach(row => {
                if (!pokemonMap.has(row.id)) {
                    pokemonMap.set(row.id, {
                        id: row.id,
                        name: row.name,
                        types: row.types || [],
                        abilities: row.ability_name ? row.ability_name.split(', ') : []
                    });
                }
            });

            // Display each Pokémon once with combined types
            pokemonMap.forEach(p => {
                const div = document.createElement('div');
                div.className = 'poke-card';
                const spriteUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.id}.png`;
                
                const typeText = p.types.length > 0 ? p.types.join(' / ') : 'Unknown';
                const abilityText = p.abilities.length > 0 ? p.abilities.join(', ') : 'None';
                
                div.innerHTML = `
                    <img src="${spriteUrl}" alt="${p.name}" style="width: 96px; height: 96px;">
                    <div>
                        <h3>${p.name} (#${p.id})</h3>
                        <p>Type: ${typeText}</p>
                        <p>Ability: ${abilityText}</p>
                        <button class="fav-add" onclick="addFavorite(${p.id}, '${p.name.replace(/'/g, "\\'")}', this)">Add to favourites</button>
                    </div>
                `;
                resultsDiv.appendChild(div);
            });
        })
        .catch(err => {
            console.error(err);
            resultsDiv.innerHTML = '<p>Error connecting to server.</p>';
        });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Clear old localStorage favorite data (migration from old system)
    localStorage.removeItem('favoritePokemon');
    
    await loadFavorites();
    renderFavorites();
});

// Reload favorites when user logs in/out in another tab
window.addEventListener('storage', async (e) => {
    if (e.key === 'accessToken') {
        await loadFavorites();
        renderFavorites();
    }
});