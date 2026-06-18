// /api/login.js — Login seguro HogarCred
const crypto = require('crypto');

// Acepta tanto el nombre nuevo como el que ya existía en Vercel (SUPA_SERVICE_KEY)
const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.SUPA_URL
  || 'https://ljsbgdqqjiwjtjlbdrzn.supabase.co';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPA_SERVICE_KEY;

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(enc).digest();
  return `${enc}.${base64url(sig)}`;
}

module.exports = async (req, res) => {
  // CORS para llamadas desde el mismo dominio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' }); return;
  }

  // Diagnóstico de variables (sin exponer los valores)
  if (!SERVICE_KEY) {
    res.status(500).json({ error: 'Falta SERVICE_KEY. Variables disponibles: ' + Object.keys(process.env).filter(k => k.startsWith('SUPA') || k.startsWith('SUPABASE')).join(', ') });
    return;
  }
  if (!JWT_SECRET) {
    res.status(500).json({ error: 'Falta SUPABASE_JWT_SECRET' }); return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !password) {
    res.status(400).json({ error: 'Usuario y contraseña requeridos' }); return;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/usuarios?username=eq.${encodeURIComponent(username)}&activo=eq.true&select=*`;
    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      res.status(502).json({ error: `Supabase respondió ${r.status}: ${errText.slice(0, 200)}` });
      return;
    }

    const rows = await r.json();
    const user = rows?.[0];

    if (!user || user.password !== password) {
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); return;
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signJWT({
      sub: user.id, role: 'authenticated',
      empresa_id: user.empresa_id, username: user.username,
      iat: now, exp: now + 60 * 60 * 12
    });

    res.status(200).json({
      token,
      user: {
        id: user.id, username: user.username,
        nombreCompleto: user.nombre_completo,
        esAdmin: user.es_admin === true || user.es_admin === 'true',
        activo: user.activo,
        permisos: typeof user.permisos === 'string' ? JSON.parse(user.permisos || '[]') : (user.permisos || []),
        empresaId: user.empresa_id
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
};
