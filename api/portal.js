// /api/portal.js — Puerta única del panel público del cliente (link de WhatsApp)
//
// Reemplaza el acceso directo a la base con la clave pública. Con esta
// función, el navegador del cliente ya no puede leer clientes/créditos de
// nadie: solo recibe lo del crédito cuyo link tiene, y solo lo necesario.
//
// Acciones (POST, JSON):
//   estado : { crId }                     → ¿el contrato ya está firmado?
//   panel  : { crId }                     → cuotas del crédito con el monto exacto a pagar
//   cuota  : { cuotaId }                  → estado de una cuota (confirmar un pago)
//   firmar : { crId, firmaData, dni }     → guarda la firma (valida el DNI en el servidor)
//
// Variables de entorno (ya existentes en Vercel): SUPA_URL, SUPA_SERVICE_KEY
//
// No se agregan cabeceras CORS a propósito: solo la propia página puede llamarla.

const TZ = 'America/Argentina/Buenos_Aires'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_FIRMA = 2_000_000   // caracteres (una firma PNG real pesa mucho menos)

const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
const redondear = n => Math.round(n * 100) / 100
const soloDigitos = s => String(s || '').replace(/\D/g, '')

function diasEntre(desdeISO, hastaISO) {
  const [y1, m1, d1] = desdeISO.split('-').map(Number)
  const [y2, m2, d2] = hastaISO.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
}

function parseJSONSeguro(v) {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

class ErrorPortal extends Error {
  constructor(status, codigo, mensaje) { super(mensaje); this.status = status; this.codigo = codigo }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo', mensaje: 'Método no permitido' })

  const SUPA_URL = process.env.SUPA_URL
  const SUPA_KEY = process.env.SUPA_SERVICE_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ error: 'config', mensaje: 'Servidor sin configurar' })
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {}

  const sb = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' }

  const get = async (ruta) => {
    const r = await fetch(`${SUPA_URL}/rest/v1/${ruta}`, { headers: sb })
    if (!r.ok) throw new ErrorPortal(502, 'base', 'No se pudo consultar los datos')
    return r.json()
  }

  const uuid = (v, campo) => {
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ErrorPortal(400, 'invalido', `${campo} inválido`)
    return v.toLowerCase()
  }

  try {
    switch (body.accion) {

      // ─────────────────────────────────────────────────────────────
      case 'estado': {
        const crId = uuid(body.crId, 'crId')
        const cr = (await get(`creditos?id=eq.${crId}&select=id,datos`))[0]
        if (!cr) throw new ErrorPortal(404, 'no_encontrado', 'Crédito no encontrado')

        const f = (await get(`firmas?credito_id=eq.${crId}&select=firma_fecha&order=firma_fecha.desc&limit=1`))[0]
        if (f) return res.status(200).json({ firmado: true, firmaFecha: f.firma_fecha || null })

        const d = parseJSONSeguro(cr.datos)
        if (d.firmaData) return res.status(200).json({ firmado: true, firmaFecha: d.firmaFecha || null })
        return res.status(200).json({ firmado: false, firmaFecha: null })
      }

      // ─────────────────────────────────────────────────────────────
      case 'panel': {
        const crId = uuid(body.crId, 'crId')
        const cr = (await get(`creditos?id=eq.${crId}&select=id,estado,empresa_id`))[0]
        if (!cr) throw new ErrorPortal(404, 'no_encontrado', 'Crédito no encontrado')

        // Las cuotas canceladas (por ejemplo, por una refinanciación) no se le muestran al cliente
        const cuotas = await get(
          `cuotas?credito_id=eq.${crId}&estado=neq.CANCELADA` +
          `&select=id,numero_cuota,fecha_vencimiento,monto_original,monto_recargo,estado,fecha_pago` +
          `&order=numero_cuota.asc`
        )

        // Lo ya cobrado de cada cuota (cobranzas no anuladas)
        const pagadoPorCuota = {}
        if (cuotas.length) {
          const ids = cuotas.map(q => q.id).join(',')
          const cobs = await get(`cobranzas?cuota_id=in.(${ids})&anulada=eq.false&select=cuota_id,monto_cobrado`)
          cobs.forEach(c => { pagadoPorCuota[c.cuota_id] = (pagadoPorCuota[c.cuota_id] || 0) + Number(c.monto_cobrado || 0) })
        }

        // Configuración de mora de la empresa (misma fórmula que mp-preferencia)
        let gracia = 0, pct = 0
        if (cr.empresa_id) {
          const emp = (await get(`empresas?id=eq.${cr.empresa_id}&select=config`))[0]
          const cfg = parseJSONSeguro(emp?.config)
          gracia = parseInt(cfg.dias_gracia_recargo) || 0
          pct    = parseFloat(cfg.recargo_diario_pct) || 0
        }

        const hoy = hoyAR()
        const salida = cuotas.map(q => {
          const base = Number(q.monto_original)
          let saldo = 0, recargo = Number(q.monto_recargo || 0)
          if (q.estado !== 'PAGADA') {
            const dias = diasEntre(q.fecha_vencimiento, hoy)
            recargo = dias > gracia ? redondear(base * (pct / 100) * (dias - gracia)) : 0
            saldo = Math.max(0, redondear(base + recargo - (pagadoPorCuota[q.id] || 0)))
          }
          return {
            id: q.id,
            numero_cuota: q.numero_cuota,
            fecha_vencimiento: q.fecha_vencimiento,
            monto_original: base,
            monto_recargo: recargo,
            estado: q.estado,
            fecha_pago: q.fecha_pago || null,
            saldo            // monto exacto que se cobrará si paga ahora
          }
        })

        return res.status(200).json({ credito: { id: cr.id, estado: cr.estado }, cuotas: salida })
      }

      // ─────────────────────────────────────────────────────────────
      case 'cuota': {
        const cuotaId = uuid(body.cuotaId, 'cuotaId')
        const q = (await get(`cuotas?id=eq.${cuotaId}&select=id,estado,fecha_pago,credito_id`))[0]
        if (!q) throw new ErrorPortal(404, 'no_encontrado', 'Cuota no encontrada')
        return res.status(200).json({ id: q.id, estado: q.estado, fecha_pago: q.fecha_pago || null, credito_id: q.credito_id })
      }

      // ─────────────────────────────────────────────────────────────
      case 'firmar': {
        const crId = uuid(body.crId, 'crId')
        const firmaData = body.firmaData
        if (typeof firmaData !== 'string' || !firmaData.startsWith('data:image/png;base64,') || firmaData.length > MAX_FIRMA) {
          throw new ErrorPortal(400, 'firma_invalida', 'La firma no es válida. Dibujala de nuevo.')
        }

        const cr = (await get(`creditos?id=eq.${crId}&select=id,cliente_id,datos,estado`))[0]
        if (!cr) throw new ErrorPortal(404, 'no_encontrado', 'Crédito no encontrado')

        // El DNI se valida contra el del cliente en la base (antes se comparaba en el navegador)
        const cli = cr.cliente_id ? (await get(`clientes?id=eq.${cr.cliente_id}&select=dni`))[0] : null
        const dniReal = soloDigitos(cli?.dni)
        const dniIng  = soloDigitos(body.dni)
        if (!dniReal || !dniIng || dniReal !== dniIng) {
          throw new ErrorPortal(403, 'dni', 'El DNI no coincide con el del titular del crédito.')
        }

        // Una vez firmado no se puede volver a firmar con el mismo link
        const ya = await get(`firmas?credito_id=eq.${crId}&select=id&limit=1`)
        if (ya.length) throw new ErrorPortal(409, 'ya_firmado', 'Este contrato ya fue firmado.')

        const firmaFecha = new Date().toISOString()
        const ins = await fetch(`${SUPA_URL}/rest/v1/firmas`, {
          method: 'POST',
          headers: { ...sb, Prefer: 'return=minimal' },
          body: JSON.stringify({
            credito_id:    crId,
            firma_data:    firmaData,
            firma_fecha:   firmaFecha,
            firmado_desde: 'whatsapp_link',
            dni_firmante:  dniIng
          })
        })
        if (!ins.ok) {
          console.error('portal firmar: no se pudo guardar', ins.status, await ins.text().catch(() => ''))
          throw new ErrorPortal(502, 'base', 'No se pudo guardar la firma. Intentá de nuevo.')
        }

        // Dejar la firma también en creditos.datos, SIN pisar los demás datos del crédito
        // (antes se reemplazaba todo el campo). Si falla no es grave: la tabla firmas ya la tiene.
        try {
          const datos = { ...parseJSONSeguro(cr.datos), firmaData, firmaFecha, estado_contrato: 'firmada' }
          await fetch(`${SUPA_URL}/rest/v1/creditos?id=eq.${crId}`, {
            method: 'PATCH',
            headers: { ...sb, Prefer: 'return=minimal' },
            body: JSON.stringify({ datos: JSON.stringify(datos) })
          })
        } catch (e) { console.warn('portal firmar: no se pudo actualizar creditos.datos', e.message) }

        return res.status(200).json({ ok: true, firmaFecha })
      }

      default:
        throw new ErrorPortal(400, 'accion', 'Acción desconocida')
    }
  } catch (err) {
    if (err instanceof ErrorPortal) return res.status(err.status).json({ error: err.codigo, mensaje: err.message })
    console.error('portal error:', err.message)
    return res.status(500).json({ error: 'interno', mensaje: 'Error interno' })
  }
}
