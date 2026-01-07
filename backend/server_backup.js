require('dotenv').config();
const express=require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db=require('./db');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_EXPIRES_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7);
const REFRESH_LIFETIME_MS = REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000;

const q = (sql, params) => new Promise((resolve, reject) => db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

const signAccessToken = (user) => jwt.sign({ sub: user.id, role: user.role }, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES });

async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
  await q('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?,?,?)', [userId, token, expiresAt]);
  return token;
}

async function rotateRefreshToken(oldToken) {
  const rows = await q('SELECT user_id, expires_at FROM refresh_tokens WHERE token = ? LIMIT 1', [oldToken]);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await q('DELETE FROM refresh_tokens WHERE token = ?', [oldToken]);
    return null;
  }
  await q('DELETE FROM refresh_tokens WHERE token = ?', [oldToken]);
  const newToken = await issueRefreshToken(row.user_id);
  return { userId: row.user_id, newToken };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
  return next();
};

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from Public folder (absolute path from backend dir)
const publicPath = path.resolve(__dirname, '../Public');
console.log('Serving static files from:', publicPath);
app.use(express.static(publicPath));

app.get('/',(req,res)=>{
    res.send('Backend is running');
});

// Auth: register
app.post('/auth/register', async (req, res) => {
  try {
    const { name = '', email = '', password = '' } = req.body || {};
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim();
    const trimmedPass = String(password);

    if (!trimmedName || trimmedName.length > 20) return res.status(400).json({ error: 'Name is required (max 20 chars)' });
    const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailRe.test(trimmedEmail) || trimmedEmail.length > 200) return res.status(400).json({ error: 'Invalid email' });
    if (trimmedPass.length < 8 || trimmedPass.length > 200) return res.status(400).json({ error: 'Password must be 8-200 characters' });

    const existing = await q('SELECT id FROM users WHERE email = ? LIMIT 1', [trimmedEmail]);
    if (existing && existing.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(trimmedPass, 10);
    await q('INSERT INTO users (name, email, pass, role) VALUES (?,?,?,?)', [trimmedName, trimmedEmail, hash, 'player']);
    return res.status(201).json({ success: true });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Auth: login
app.post('/auth/login', async (req, res) => {
  try {
    const { email = '', password = '' } = req.body || {};
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedPass = String(password);

    if (!trimmedEmail || !trimmedPass) return res.status(400).json({ error: 'Email and password required' });

    const rows = await q('SELECT id, name, email, pass, role FROM users WHERE email = ? LIMIT 1', [trimmedEmail]);
    if (!rows || !rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];

    const ok = await bcrypt.compare(trimmedPass, user.pass || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    return res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Auth: refresh access token
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const userRows = await q('SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1', [rotated.userId]);
    if (!userRows || !userRows.length) return res.status(401).json({ error: 'User not found' });
    const user = userRows[0];

    const accessToken = signAccessToken(user);
    return res.json({
      accessToken,
      refreshToken: rotated.newToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    console.error('refresh error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Auth: logout
app.post('/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    await q('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
    return res.json({ success: true });
  } catch (e) {
    console.error('logout error', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/pokemon/search', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name.length > 50) return res.status(400).json({ error: 'Search too long (max 50 chars)' });

  const sql = `
    SELECT 
      p.sid AS id,
      p.name,
      pt.type_name,
      pt.type_name1,
      pa.ability_name
    FROM pokemon p
    LEFT JOIN pokemon_types pt ON p.sid = pt.pokemon_sid
    LEFT JOIN pokemon_abilities pa ON p.sid = pa.pokemon_sid
    WHERE p.name LIKE ?
    LIMIT 100
  `;

  db.query(sql, [`%${name}%`], (err, results) => {
    if (err) return res.status(500).json(err);
    
    // Group by Pokémon ID to deduplicate and combine types/abilities
    const map = new Map();
    (results || []).forEach(r => {
      const id = r.id;
      if (!map.has(id)) {
        map.set(id, { id: r.id, name: r.name, types: new Set(), abilities: new Set() });
      }
      const entry = map.get(id);
      if (r.type_name) entry.types.add(r.type_name);
      if (r.type_name1) entry.types.add(r.type_name1);
      if (r.ability_name) entry.abilities.add(r.ability_name);
    });
    
    // Convert to display format with types as array
    const payload = Array.from(map.values()).map(e => ({
      id: e.id,
      name: e.name,
      types: Array.from(e.types),
      ability_name: e.abilities.size > 0 ? Array.from(e.abilities).join(', ') : null
    }));
    
    res.json(payload);
  });
});

app.get('/pokemon', (req, res) => {
  const { search = '', type = '' } = req.query;
  const searchTerm = String(search || '').trim();
  if (searchTerm.length > 50) return res.status(400).json({ error: 'Search too long (max 50 chars)' });

  let sql = `
    SELECT 
      p.sid AS id,
      p.name,
      pt.type_name,
      pt.type_name1
    FROM pokemon p
    LEFT JOIN pokemon_types pt ON p.sid = pt.pokemon_sid
    WHERE p.name LIKE ?
  `;

  const params = [`%${searchTerm}%`];

  if (type) {
    sql += ` AND p.sid IN (
      SELECT pt2.pokemon_sid
      FROM pokemon_types pt2
      WHERE pt2.type_name = ?
    )`;
    params.push(type);
  }

  // If no search term provided (team builder fetching all), return all Pokemon
  // Otherwise limit to 300 results for search performance
  const limit = searchTerm === '' ? 2000 : 300;
  sql += `
    ORDER BY p.sid ASC
    LIMIT ${limit}
  `;

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json(err)
    const map = new Map();
    (results || []).forEach(r => {
      const id = r.id;
      if (!map.has(id)) map.set(id, { id: r.id, name: r.name, types: [] });
      const entry = map.get(id);
      if (r.type_name) entry.types.push(r.type_name);
      if (r.type_name1) entry.types.push(r.type_name1);
    });
    const payload = Array.from(map.values()).map(e => {
      e.types = Array.from(new Set((e.types || []).map(t => String(t).trim()).filter(Boolean)));
      return e;
    });

    res.json(payload);
  });
});

app.get('/types', (req, res) => {
  const sql = `SELECT name AS type_name FROM types ORDER BY name`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// Detailed pokemon 
app.get('/pokemon/:id', (req, res) => {
  const id = req.params.id;

  // 1) basic info
  const qPokemon = `SELECT sid AS id, name FROM pokemon WHERE sid = ? LIMIT 1`;
  db.query(qPokemon, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err });
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const pokemon = rows[0];

    // 2) types 
    const qTypes = `SELECT type_name, type_name1 FROM pokemon_types WHERE pokemon_sid = ?`;
    db.query(qTypes, [id], (err2, typesRows) => {
      if (err2) return res.status(500).json({ error: err2 });
      const all = [];
      (typesRows || []).forEach(r => {
        if (r.type_name) all.push(r.type_name);
        if (r.type_name1) all.push(r.type_name1);
      });
      pokemon.types = Array.from(new Set(all.map(t => String(t).trim()).filter(Boolean)));

      // 3) abilities
      const qAbilities = `SELECT ability_name FROM pokemon_abilities WHERE pokemon_sid = ?`;
      db.query(qAbilities, [id], (err3, abilityRows) => {
        if (err3) return res.status(500).json({ error: err3 });
        pokemon.abilities = (abilityRows || []).map(r => r.ability_name);

        // 4) base stats (bst table)
        const qStats = `SELECT hp, attack, sp_atk, defence, sp_def, spd FROM bst WHERE pokemon_sid = ? LIMIT 1`;
        db.query(qStats, [id], (errStats, statsRows) => {
          if (errStats) {
            pokemon.stats = {};
          } else if (statsRows && statsRows.length > 0) {
            const s = statsRows[0];
            pokemon.stats = {
              hp: s.hp,
              attack: s.attack,
              sp_atk: s.sp_atk,
              defence: s.defence,
              sp_def: s.sp_def,
              spd: s.spd
            };
          } else {
            pokemon.stats = {};
          }

          // 5) moves 
          const qMoves = `
            SELECT m.code, m.name, m.type_name AS type, m.power, m.accuracy, m.category
            FROM pokemon_moves pm
            JOIN moves m ON pm.move_code = m.code
            WHERE pm.pokemon_sid = ?
            LIMIT 500
          `;

          db.query(qMoves, [id], (err4, moveRows) => {
            if (err4) {
              // if table missing or other issue, don't fail — return empty moves
              pokemon.moves = [];
              return res.json(pokemon);
            }
            pokemon.moves = (moveRows || []).map(r => ({ code: r.code, name: r.name, type: r.type, power: r.power, accuracy: r.accuracy, category: r.category }));
            return res.json(pokemon);
          });
        });
      });
    });
  });
});

// Damage calculator API (replacement for PHP dmgCalc.php)
app.post('/api/dmgcalc', (req, res) => {
  const { attacker, defender, attacker_level = 50, move } = req.body || {};
  
  // Input validation
  if (!attacker || typeof attacker !== 'string') return res.status(400).json({ error: 'Attacker name is required and must be a string' });
  if (!defender || typeof defender !== 'string') return res.status(400).json({ error: 'Defender name is required and must be a string' });
  if (!move || typeof move !== 'string') return res.status(400).json({ error: 'Move name is required and must be a string' });
  
  const level = Number(attacker_level);
  if (isNaN(level) || level < 1 || level > 100) return res.status(400).json({ error: 'Attacker level must be a number between 1 and 100' });

  const attacker_trim = attacker.trim();
  const defender_trim = defender.trim();
  const move_trim = move.trim();

  if (attacker_trim.length === 0) return res.status(400).json({ error: 'Attacker name cannot be empty' });
  if (defender_trim.length === 0) return res.status(400).json({ error: 'Defender name cannot be empty' });
  if (move_trim.length === 0) return res.status(400).json({ error: 'Move name cannot be empty' });
  if (attacker_trim.length > 100 || defender_trim.length > 100 || move_trim.length > 100) return res.status(400).json({ error: 'Input names too long (max 100 chars)' });

  // helper to run a single-row query promise
  const q = (sql, params) => new Promise((resolve, reject) => db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

  (async () => {
    try {
      // attacker sid
      let rows = await q('SELECT sid FROM pokemon WHERE name = ? LIMIT 1', [attacker_trim]);
      if (!rows || rows.length === 0) return res.status(400).json({ error: `Pokémon "${attacker_trim}" not found` });
      const attacker_sid = rows[0].sid;

      // defender sid
      rows = await q('SELECT sid FROM pokemon WHERE name = ? LIMIT 1', [defender_trim]);
      if (!rows || rows.length === 0) return res.status(400).json({ error: `Pokémon "${defender_trim}" not found` });
      const defender_sid = rows[0].sid;

      // attacker stats
      rows = await q('SELECT hp, attack, sp_atk, defence, sp_def, spd FROM bst WHERE pokemon_sid = ? LIMIT 1', [attacker_sid]);
      const atkStats = (rows && rows[0]) || {};
      if (!atkStats.hp) return res.status(500).json({ error: 'Attacker stats not found in database' });

      // defender stats
      rows = await q('SELECT hp, attack, sp_atk, defence, sp_def, spd FROM bst WHERE pokemon_sid = ? LIMIT 1', [defender_sid]);
      const defStats = (rows && rows[0]) || {};
      if (!defStats.hp) return res.status(500).json({ error: 'Defender stats not found in database' });

      // move details
      rows = await q('SELECT code, power, accuracy, type_name, category FROM moves WHERE name = ? LIMIT 1', [move_trim]);
      if (!rows || rows.length === 0) return res.status(400).json({ error: `Move "${move_trim}" not found` });
      const mv = rows[0];
      
      // validate move power and category
      if (mv.power === null || mv.power === undefined || mv.power === 0) return res.status(400).json({ error: `Move "${move_trim}" has no power (status move?)` });
      if (!['Physical', 'Special'].includes(mv.category)) return res.status(500).json({ error: 'Invalid move category in database' });

      // check move usable
      rows = await q('SELECT 1 FROM pokemon_moves WHERE pokemon_sid = ? AND move_code = ? LIMIT 1', [attacker_sid, mv.code]);
      if (!rows || rows.length === 0) return res.status(400).json({ error: `Pokémon "${attacker_trim}" cannot learn "${move_trim}"` });

      // defender types
      rows = await q('SELECT type_name, type_name1 FROM pokemon_types WHERE pokemon_sid = ?', [defender_sid]);
      let defender_types = [];
      (rows || []).forEach(r => { if (r.type_name) defender_types.push(r.type_name); if (r.type_name1) defender_types.push(r.type_name1); });
      defender_types = Array.from(new Set(defender_types.map(t => String(t).trim()).filter(Boolean)));

      // type strengths/weaknesses (from types table)
      rows = await q('SELECT strength, weakness FROM types WHERE name = ? LIMIT 1', [mv.type_name]);
      let type_multiplier = 1.0;
      if (rows && rows.length > 0) {
        const td = rows[0];
        const strengths = (td.strength || '').split(',').map(s => s.trim()).filter(Boolean);
        const weaknesses = (td.weakness || '').split(',').map(s => s.trim()).filter(Boolean);
        defender_types.forEach(dt => {
          if (strengths.includes(dt)) type_multiplier *= 2;
          if (weaknesses.includes(dt)) type_multiplier *= 0.5;
        });
      }

      // STAB
      rows = await q('SELECT type_name, type_name1 FROM pokemon_types WHERE pokemon_sid = ?', [attacker_sid]);
      let attacker_types = [];
      (rows || []).forEach(r => { if (r.type_name) attacker_types.push(r.type_name); if (r.type_name1) attacker_types.push(r.type_name1); });
      attacker_types = Array.from(new Set(attacker_types.map(t => String(t).trim()).filter(Boolean)));
      const stab = attacker_types.includes(mv.type_name) ? 1.5 : 1.0;

      const attacker_level_num = Number(level) || 50;
      const attack_stat = mv.category === 'Physical' ? (atkStats.attack || 0) : (atkStats.sp_atk || 0);
      const defence_stat = mv.category === 'Physical' ? (defStats.defence || 1) : (defStats.sp_def || 1);

      const base_damage = (((2 * attacker_level_num / 5) + 2) * (mv.power || 0) * (attack_stat / (defence_stat || 1))) / 50 + 2;
      const damage = Math.floor(base_damage * stab * type_multiplier);

      return res.json({ damage, details: { base_damage: Math.floor(base_damage), stab, type_multiplier } });
    } catch (e) {
      console.error('dmgcalc error', e);
      return res.status(500).json({ error: 'Server error: ' + e.message });
    }
  })();
});

// Map: region encounters
app.get('/region/encounters', (req, res) => {
  const regionName = String(req.query.name || '').trim();
  if (!regionName) return res.status(400).json({ error: 'Region name required' });

  const sql = `
    SELECT
      r.description AS region_desc,
      p.name AS pokemon_name,
      r.catch_rate,
      e.encounter_rate,
      e.method
    FROM regions r
    LEFT JOIN encounters e ON r.id = e.region_id
    LEFT JOIN pokemon p ON e.pokemon_sid = p.sid
    WHERE r.name = ?
  `;

  db.query(sql, [regionName], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.json(result || []);
  });
});

// ========================
//   GYM TRACKER API ROUTES
// ========================

// 1. Get all distinct regions
app.get('/api/regions', async (req, res) => {
    try {
        const rows = await q('SELECT DISTINCT region FROM gyms ORDER BY region');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching regions:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Get all gyms with necessary fields
app.get('/api/gyms', async (req, res) => {
    try {
        const rows = await q(`
            SELECT id, gym_name, leader, region, gym_number
            FROM gyms
            ORDER BY region, gym_number
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching gyms:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Get user gym progress (auth required)
app.get('/api/user-progress', authMiddleware, async (req, res) => {
  const userId = req.user.id;
    try {
      const rows = await q(`
        SELECT 
          gym_id,
          start_date,
          end_date,
          CASE 
            WHEN end_date IS NOT NULL THEN DATEDIFF(end_date, start_date) + 1
            ELSE NULL
          END AS duration_days
        FROM user_gym_progress
        WHERE user_id = ?
      `, [userId]);
      // Ensure we always return an array
      if (!Array.isArray(rows)) return res.json([]);
      res.json(rows);
    } catch (err) {
      console.error('user-progress error:', err);
      // Return empty array to avoid frontend crash; log error for diagnostics
      res.json([]);
    }
});

// 4. Start a gym (set start_date) (auth required)
app.post('/api/start-gym', authMiddleware, async (req, res) => {
    const { gym_id } = req.body;
  const userId = req.user.id;

    try {
        const gym = await q('SELECT region, gym_number FROM gyms WHERE id = ?', [gym_id]);
        if (gym.length === 0) return res.status(404).json({ error: 'Gym not found' });

        if (gym[0].gym_number > 1) {
            const prev = await q(`
                SELECT end_date FROM user_gym_progress up
                JOIN gyms g ON up.gym_id = g.id
                WHERE g.region = ? AND g.gym_number = ? AND up.user_id = ?
            `, [gym[0].region, gym[0].gym_number - 1, userId]);

            if (prev.length === 0 || !prev[0].end_date) {
                return res.status(403).json({ error: 'Complete previous gym first' });
            }
        }

        await q(`
            INSERT INTO user_gym_progress (user_id, gym_id, start_date)
            VALUES (?, ?, CURDATE())
            ON DUPLICATE KEY UPDATE start_date = CURDATE()
        `, [userId, gym_id]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 5. Mark gym as completed (set end_date) (auth required)
app.post('/api/mark-gym-complete', authMiddleware, async (req, res) => {
    const { gym_id, end_date } = req.body;
    const userId = req.user.id;

    if (!gym_id) {
        return res.status(400).json({ error: 'gym_id is required' });
    }

    try {
        const dateToSet = end_date || null;
        await q(`
            UPDATE user_gym_progress 
            SET end_date = ${dateToSet ? '?' : 'CURDATE()'}
            WHERE user_id = ? AND gym_id = ? AND start_date IS NOT NULL
        `, dateToSet ? [dateToSet, userId, gym_id] : [userId, gym_id]);
    } catch (err) {
        console.error('Error marking complete:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin: Fix a gym end_date to today's date
app.post('/api/admin/fix-gym-end-date', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { gym_id, user_id, end_date } = req.body || {};
    const userId = user_id || req.user?.id || 1;
    if (!gym_id) return res.status(400).json({ error: 'gym_id is required' });

    const dateToSet = end_date || null;
    await q(`
      UPDATE user_gym_progress
      SET end_date = ${dateToSet ? '?' : 'CURDATE()'}
      WHERE user_id = ? AND gym_id = ? AND start_date IS NOT NULL
    `, dateToSet ? [dateToSet, userId, gym_id] : [userId, gym_id]);

    res.json({ success: true });
  } catch (err) {
    console.error('fix-gym-end-date error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 6. List all Elite Four members
app.get('/api/elite-four', async (req, res) => {
    try {
        const rows = await q('SELECT name, region FROM elite_four ORDER BY region, id');
        res.json(rows);
    } catch (err) {
        res.status(500).json({error: 'Database error'});
    }
});

// 7. Get user's Elite Four progress per region (auth required)
app.get('/api/user-elite-progress', authMiddleware, async (req, res) => {
  const userId = req.user.id;
    try {
        const rows = await q(`
            SELECT 
                region,
                start_date,
                end_date,
                IF(end_date IS NOT NULL, DATEDIFF(end_date, start_date) + 1, NULL) AS duration_days
            FROM user_elite_four_progress
            WHERE user_id = ?
        `, [userId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({error: 'Database error'});
    }
});

// 8. Start Elite Four challenge for region (auth required)
app.post('/api/start-elite-four', authMiddleware, async (req, res) => {
    const { region } = req.body;
  const userId = req.user.id;

    if (!region) return res.status(400).json({error: 'Region required'});

    try {
        // Check 8 gyms completed
        const completedCount = await q(`
            SELECT COUNT(*) as cnt 
            FROM user_gym_progress up
            JOIN gyms g ON up.gym_id = g.id
            WHERE up.user_id = ? 
              AND g.region = ?
              AND up.end_date IS NOT NULL
        `, [userId, region]);

        if (completedCount[0].cnt < 8) {
            return res.status(403).json({error: 'You must defeat all 8 gyms first!'});
        }

        await q(`
            INSERT INTO user_elite_four_progress (user_id, region, start_date)
            VALUES (?, ?, CURDATE())
            ON DUPLICATE KEY UPDATE start_date = CURDATE()
        `, [userId, region]);

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: 'Server error'});
    }
});

// 9. Complete Elite Four challenge (auth required)
app.post('/api/complete-elite-four', authMiddleware, async (req, res) => {
    const { region, end_date } = req.body;
    const userId = req.user.id;

    try {
        const dateToSet = end_date || null;
        await q(`
            UPDATE user_elite_four_progress
            SET end_date = ${dateToSet ? '?' : 'CURDATE()'}
            WHERE user_id = ? AND region = ? AND start_date IS NOT NULL
        `, dateToSet ? [dateToSet, userId, region] : [userId, region]);
    } catch (err) {
        console.error(err);
        res.status(500).json({error: 'Server error'});
    }
});

// ========================
//   TEAM BUILDER API ROUTES
// ========================

// Get available moves for a Pokémon
app.get('/pokemon/:id/moves', (req, res) => {
    const id = req.params.id;

    const sql = `
        SELECT m.code, m.name, m.type_name as type, m.power, m.accuracy, m.category
        FROM pokemon_moves pm
        JOIN moves m ON pm.move_code = m.code
        WHERE pm.pokemon_sid = ?
        ORDER BY m.name
    `;

    db.query(sql, [id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// Get abilities for a Pokémon
app.get('/pokemon/:id/abilities', (req, res) => {
    const id = req.params.id;

    const sql = `
        SELECT ability_name
        FROM pokemon_abilities
        WHERE pokemon_sid = ?
        ORDER BY ability_name
    `;

    db.query(sql, [id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results.map(r => r.ability_name));
    });
});

// Get all items
app.get('/items', (req, res) => {
    const sql = 'SELECT item_no, name FROM items ORDER BY name LIMIT 500';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// Get all natures
app.get('/natures', (req, res) => {
    const sql = 'SELECT name FROM nature ORDER BY name';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results.map(r => r.name));
    });
});

// Save team to database (auth required)
app.post('/team/save', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { teamName, teamData, format } = req.body;

    if (!teamData || !Array.isArray(teamData)) {
        return res.status(400).json({ error: 'Invalid team data' });
    }

    try {
        // Check if player exists
        const playerCheck = await q('SELECT user_id FROM player WHERE user_id = ?', [userId]);
        if (playerCheck.length === 0) {
            // Create player record if doesn't exist
            await q('INSERT INTO player (user_id) VALUES (?)', [userId]);
        }

      // Enforce max 5 teams per user (unless updating existing team name)
      const desiredName = teamName || 'My Team';
      const existingTeam = await q('SELECT id FROM teams WHERE player_id = ? AND team_name = ? LIMIT 1', [userId, desiredName]);
      if (!existingTeam.length) {
        const [{ count }] = await q('SELECT COUNT(*) AS count FROM teams WHERE player_id = ?', [userId]);
        if (count >= 5) {
          return res.status(400).json({ error: 'Team limit reached (max 5). Delete a team before saving a new one.' });
        }
      }

        // Create or update team
        const teamResult = await q(`
            INSERT INTO teams (player_id, team_name, format, created_at)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE team_name = ?, format = ?
      `, [userId, desiredName, format || 'VGC', desiredName, format || 'VGC']);

      const teamId = teamResult.insertId || (await q('SELECT id FROM teams WHERE player_id = ? AND team_name = ? ORDER BY created_at DESC LIMIT 1', [userId, desiredName]))[0].id;

        // Delete existing team pokemon
        await q('DELETE FROM team_pokemon WHERE team_id = ?', [teamId]);

        // Insert each pokemon
        for (let i = 0; i < teamData.length; i++) {
            const pokemon = teamData[i];
            if (!pokemon) continue;

            // Get item_no from item name
            let itemNo = null;
            if (pokemon.item) {
                const itemResult = await q('SELECT item_no FROM items WHERE name = ? LIMIT 1', [pokemon.item]);
                if (itemResult.length > 0) itemNo = itemResult[0].item_no;
            }

            // Ensure ability exists in ability table, insert if missing
            if (pokemon.ability) {
                const abilityCheck = await q('SELECT name FROM ability WHERE name = ? LIMIT 1', [pokemon.ability]);
                if (abilityCheck.length === 0) {
                    await q('INSERT IGNORE INTO ability (name) VALUES (?)', [pokemon.ability]);
                }
            }

            // Insert team_pokemon
            const tpResult = await q(`
                INSERT INTO team_pokemon (team_id, slot, pokemon_sid, item_no, ability_name, nature, level, gender, shiny)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [teamId, i + 1, pokemon.id, itemNo, pokemon.ability, pokemon.nature, pokemon.level || 50, pokemon.gender || 'N', pokemon.shiny ? 1 : 0]);

            const teamPokemonId = tpResult.insertId;

            // Insert moves
            if (pokemon.selectedMoves && Array.isArray(pokemon.selectedMoves)) {
                for (let j = 0; j < pokemon.selectedMoves.length; j++) {
                    const moveName = pokemon.selectedMoves[j];
                    if (!moveName) continue;

                    const moveResult = await q('SELECT code FROM moves WHERE name = ? LIMIT 1', [moveName]);
                    if (moveResult.length > 0) {
                        await q('INSERT INTO team_pokemon_moves (team_pokemon_id, move_code, slot) VALUES (?, ?, ?)',
                            [teamPokemonId, moveResult[0].code, j + 1]);
                    }
                }
            }

            // Insert EVs
            const evs = pokemon.evs || { hp: 0, attack: 0, defence: 0, sp_atk: 0, sp_def: 0, spd: 0 };
            await q(`
                INSERT INTO team_pokemon_evs (team_pokemon_id, hp, atk, def, spa, spd, spe)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [teamPokemonId, evs.hp, evs.attack, evs.defence, evs.sp_atk, evs.sp_def, evs.spd]);

            // Insert IVs
            const ivs = pokemon.ivs || { hp: 31, attack: 31, defence: 31, sp_atk: 31, sp_def: 31, spd: 31 };
            await q(`
                INSERT INTO team_pokemon_ivs (team_pokemon_id, hp, atk, def, spa, spd, spe)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [teamPokemonId, ivs.hp, ivs.attack, ivs.defence, ivs.sp_atk, ivs.sp_def, ivs.spd]);
        }

        res.json({ success: true, teamId });
    } catch (err) {
        console.error('team save error:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Load team from database (auth required)
app.get('/team/load', authMiddleware, async (req, res) => {
    const userId = req.user.id;

    try {
        const teams = await q('SELECT * FROM teams WHERE player_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);

        if (teams.length === 0) return res.json({ team: null });

        const teamId = teams[0].id;
        const teamName = teams[0].team_name;

        // Load all pokemon in team
        const teamPokemon = await q(`
            SELECT 
                tp.*,
                p.name as pokemon_name,
                i.name as item_name
            FROM team_pokemon tp
            JOIN pokemon p ON tp.pokemon_sid = p.sid
            LEFT JOIN items i ON tp.item_no = i.item_no
            WHERE tp.team_id = ?
            ORDER BY tp.slot
        `, [teamId]);

        const teamData = [];
        for (const tp of teamPokemon) {
            // Get moves
            const moves = await q(`
                SELECT m.name
                FROM team_pokemon_moves tpm
                JOIN moves m ON tpm.move_code = m.code
                WHERE tpm.team_pokemon_id = ?
                ORDER BY tpm.slot
            `, [tp.id]);

            // Get EVs
            const evs = await q('SELECT * FROM team_pokemon_evs WHERE team_pokemon_id = ?', [tp.id]);
            // Get IVs
            const ivs = await q('SELECT * FROM team_pokemon_ivs WHERE team_pokemon_id = ?', [tp.id]);

            // Get pokemon full details
            const pokemonDetails = await q('SELECT * FROM pokemon WHERE sid = ?', [tp.pokemon_sid]);
            const types = await q('SELECT type_name, type_name1 FROM pokemon_types WHERE pokemon_sid = ?', [tp.pokemon_sid]);
            const abilities = await q('SELECT ability_name FROM pokemon_abilities WHERE pokemon_sid = ?', [tp.pokemon_sid]);
            const stats = await q('SELECT * FROM bst WHERE pokemon_sid = ?', [tp.pokemon_sid]);

            teamData.push({
                id: tp.pokemon_sid,
                name: tp.pokemon_name,
                types: types.length > 0 ? [types[0].type_name, types[0].type_name1].filter(Boolean) : [],
                abilities: abilities.map(a => a.ability_name),
                stats: stats.length > 0 ? stats[0] : {},
                level: tp.level,
                ability: tp.ability_name,
                item: tp.item_name,
                nature: tp.nature,
                gender: tp.gender,
                shiny: tp.shiny === 1,
                selectedMoves: moves.map(m => m.name),
                evs: evs.length > 0 ? {
                    hp: evs[0].hp,
                    attack: evs[0].atk,
                    defence: evs[0].def,
                    sp_atk: evs[0].spa,
                    sp_def: evs[0].spd,
                    spd: evs[0].spe
                } : {},
                ivs: ivs.length > 0 ? {
                    hp: ivs[0].hp,
                    attack: ivs[0].atk,
                    defence: ivs[0].def,
                    sp_atk: ivs[0].spa,
                    sp_def: ivs[0].spd,
                    spd: ivs[0].spe
                } : {}
            });
        }

        // Fill empty slots
        while (teamData.length < 6) {
            teamData.push(null);
        }

        res.json({ team: teamData, teamName });
    } catch (err) {
        console.error('team load error:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// List all teams for current user
app.get('/team/list', authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const teams = await q('SELECT id, team_name, created_at FROM teams WHERE player_id = ? ORDER BY created_at DESC', [userId]);
    res.json({ teams });
  } catch (err) {
    console.error('team list error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Delete a team by name
app.delete('/team/delete', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { teamName } = req.body;

  if (!teamName || teamName.trim() === '') {
    return res.status(400).json({ error: 'Team name is required' });
  }

  try {
    // Find the team
    const team = await q('SELECT id FROM teams WHERE player_id = ? AND team_name = ? LIMIT 1', [userId, teamName]);
    if (!team || team.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const teamId = team[0].id;

    // Delete associated data (cascade deletes)
    await q('DELETE FROM team_pokemon_moves WHERE team_pokemon_id IN (SELECT id FROM team_pokemon WHERE team_id = ?)', [teamId]);
    await q('DELETE FROM team_pokemon_evs WHERE team_pokemon_id IN (SELECT id FROM team_pokemon WHERE team_id = ?)', [teamId]);
    await q('DELETE FROM team_pokemon_ivs WHERE team_pokemon_id IN (SELECT id FROM team_pokemon WHERE team_id = ?)', [teamId]);
    await q('DELETE FROM team_pokemon WHERE team_id = ?', [teamId]);
    await q('DELETE FROM teams WHERE id = ?', [teamId]);

    res.json({ success: true });
  } catch (err) {
    console.error('team delete error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// ==================== FAVORITES ====================

// Get user's favorite Pokemon
app.get('/api/favorite', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const rows = await q('SELECT pokemon_sid FROM player WHERE user_id = ? LIMIT 1', [userId]);
    
    if (!rows || rows.length === 0) {
      return res.json({ favoritePokemon: null });
    }
    
    const pokemonSid = rows[0].pokemon_sid;
    if (!pokemonSid) {
      return res.json({ favoritePokemon: null });
    }
    
    // Get Pokemon details
    const pokemonRows = await q('SELECT sid, name FROM pokemon WHERE sid = ? LIMIT 1', [pokemonSid]);
    
    if (!pokemonRows || pokemonRows.length === 0) {
      return res.json({ favoritePokemon: null });
    }
    
    res.json({
      favoritePokemon: {
        id: pokemonRows[0].sid,
        name: pokemonRows[0].name
      }
    });
  } catch (err) {
    console.error('get favorite error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Set user's favorite Pokemon
app.post('/api/favorite', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pokemonId } = req.body;
    
    if (!pokemonId) {
      return res.status(400).json({ error: 'Pokemon ID is required' });
    }
    
    // Verify Pokemon exists
    const pokemonRows = await q('SELECT sid FROM pokemon WHERE sid = ? LIMIT 1', [pokemonId]);
    if (!pokemonRows || pokemonRows.length === 0) {
      return res.status(400).json({ error: 'Invalid Pokemon ID' });
    }
    
    // Update player's favorite Pokemon
    await q('UPDATE player SET pokemon_sid = ? WHERE user_id = ?', [pokemonId, userId]);
    
    res.json({ success: true, pokemonId });
  } catch (err) {
    console.error('set favorite error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Remove user's favorite Pokemon
app.delete('/api/favorite', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    await q('UPDATE player SET pokemon_sid = NULL WHERE user_id = ?', [userId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('remove favorite error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

app.listen(3000,()=>{
  console.log('Server running on https://localhost:3000');
});

// ========================
//   ADMIN USERS MANAGEMENT
// ========================

// List users (admin only)
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const users = await q('SELECT id, name, email, role FROM users ORDER BY id ASC LIMIT 500');
    res.json(users);
  } catch (err) {
    console.error('admin users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set user role (admin only)
app.post('/api/admin/set-role', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { user_id, role } = req.body || {};
    if (!user_id || !['admin','player'].includes(role)) return res.status(400).json({ error: 'Invalid input' });

    await q('UPDATE users SET role = ? WHERE id = ?', [role, user_id]);

    // Sync admin table when promoting/demoting
    if (role === 'admin') {
      await q('INSERT IGNORE INTO admin (user_id) VALUES (?)', [user_id]);
    } else {
      await q('DELETE FROM admin WHERE user_id = ?', [user_id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('admin set-role error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Fix Elite Four end_date to today's date for a region
app.post('/api/admin/fix-elite-end-date', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { region, user_id, end_date } = req.body || {};
    const userId = user_id || req.user?.id || 1;
    if (!region) return res.status(400).json({ error: 'region is required' });

    const dateToSet = end_date || null;
    await q(`
      UPDATE user_elite_four_progress
      SET end_date = ${dateToSet ? '?' : 'CURDATE()'}
      WHERE user_id = ? AND region = ? AND start_date IS NOT NULL
    `, dateToSet ? [dateToSet, userId, region] : [userId, region]);

    res.json({ success: true });
  } catch (err) {
    console.error('fix-elite-end-date error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});