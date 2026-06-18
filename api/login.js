// /api/login.js
// Función serverless de Vercel — reemplaza el login directo desde el navegador.
//
// Qué hace:
// 1. Recibe { username, password } desde la app.
// 2. Consulta la tabla "usuarios" en Supabase usando la SERVICE ROLE KEY
//    (clave secreta que SOLO vive en el servidor, nunca llega al navegador).
// 3. Si las credenciales son correctas, firma un token (JWT) que incluye
//    el empresa_id del usuario, usando el JWT Secret del proyecto Supabase.
// 4. Devuelve ese token a la app. Desde ahí en adelante, todas las consultas
//    a Supabase usan ese token en lugar de la clave pública (anon key),
//    y las reglas de seguridad (RLS) en la base de datos solo van a
//    devolver datos de SU empresa.
//
// Variables de entorno necesarias en Vercel (Project Settings → Environment Variables):
//   SUPABASE_SERVICE_ROLE_KEY  → Supabase → Project Settings → API → service_role key
//   SUPABASE_JWT_SECRET        → Supabase → Project Settings → API → JWT Settings → JWT Secret
// (Nunca pegues estas dos claves en el código ni me las mandes a mí por chat.
//  Se configuran directo en el panel de Vercel.)

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ljsbgdqqjiwjtjlbdrzn.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET    = process.env.SUPABASE_JWT_SECRET;

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader  = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const data = `${encHeader}.${encPayload}`;
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest();
  return `${data}.${base64url(sig)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  if (!SERVICE_KEY || !JWT_SECRET) {
    res.status(500).json({ error: 'Servidor mal configurado: faltan variables de entorno en Vercel.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (!username || !password) {
    res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    return;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/usuarios?username=eq.${encodeURIComponent(username)}&activo=eq.true&select=*`;
    const r = await fetch(url, {
      headers: {
        apikey:        SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY
      }
    });

    if (!r.ok) {
      res.status(502).json({ error: 'Error consultando la base de datos' });
      return;
    }

    const rows = await r.json();
    const user = rows && rows[0];

    // Comparación de contraseña — TODO recomendado a futuro: migrar a hash (bcrypt)
    if (!user || user.password !== password) {
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signJWT({
      sub:        user.id,
      role:       'authenticated',
      empresa_id: user.empresa_id,
      username:   user.username,
      iat:        now,
      exp:        now + 60 * 60 * 12 // 12 horas
    });

    res.status(200).json({
      token,
      user: {
        id:             user.id,
        username:       user.username,
        nombreCompleto: user.nombre_completo,
        esAdmin:        user.es_admin === true || user.es_admin === 'true',
        activo:         user.activo,
        permisos:       typeof user.permisos === 'string' ? JSON.parse(user.permisos || '[]') : (user.permisos || []),
        empresaId:      user.empresa_id
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
};
