// /api/mp-preferencia.js — crea la preferencia de pago de Mercado Pago
// El MONTO se calcula acá, en el servidor, a partir de la base de datos.
// Lo que mande el navegador en "monto" se ignora (se podía manipular).
//
// Variables de entorno necesarias en Vercel (ya existentes):
//   MP_ACCESS_TOKEN, SUPA_URL, SUPA_SERVICE_KEY

const TZ = 'America/Argentina/Buenos_Aires'

function hoyAR() {
  // YYYY-MM-DD en horario de Argentina
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}

function diasEntre(desdeISO, hastaISO) {
  const [y1, m1, d1] = desdeISO.split('-').map(Number)
  const [y2, m2, d2] = hastaISO.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
}

const redondear = n => Math.round(n * 100) / 100

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { idCuota, descripcion, emailCliente, creditoId, numeroCuota } = req.body || {}
  if (!idCuota || typeof idCuota !== 'string') return res.status(400).json({ error: 'idCuota requerido' })

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
  const SUPA_URL     = process.env.SUPA_URL
  const SUPA_KEY     = process.env.SUPA_SERVICE_KEY
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' })
  if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: 'Base de datos no configurada en el servidor' })

  const sb = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json'
  }

  try {
    // 1. Cuota (si el id no es un UUID válido, Supabase responde error → se rechaza)
    const cuotaR = await fetch(
      `${SUPA_URL}/rest/v1/cuotas?id=eq.${encodeURIComponent(idCuota)}` +
      `&select=id,credito_id,empresa_id,monto_original,fecha_vencimiento,estado,numero_cuota`,
      { headers: sb }
    )
    if (!cuotaR.ok) return res.status(400).json({ error: 'Cuota inválida' })
    const cuota = (await cuotaR.json())?.[0]
    if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' })
    if (cuota.estado === 'PAGADA')    return res.status(409).json({ error: 'Esta cuota ya está pagada' })
    if (cuota.estado === 'CANCELADA') return res.status(409).json({ error: 'Esta cuota fue cancelada' })

    // 2. Lo ya cobrado (cobranzas no anuladas)
    const cobR = await fetch(
      `${SUPA_URL}/rest/v1/cobranzas?cuota_id=eq.${encodeURIComponent(idCuota)}&anulada=eq.false&select=monto_cobrado`,
      { headers: sb }
    )
    const cobranzas = cobR.ok ? await cobR.json() : []
    const yaPagado = cobranzas.reduce((s, c) => s + Number(c.monto_cobrado || 0), 0)

    // 3. Configuración de mora de la empresa
    let gracia = 0, pct = 0
    if (cuota.empresa_id) {
      const empR = await fetch(
        `${SUPA_URL}/rest/v1/empresas?id=eq.${cuota.empresa_id}&select=config`,
        { headers: sb }
      )
      if (empR.ok) {
        const emp = (await empR.json())?.[0]
        let cfg = emp?.config || {}
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
        gracia = parseInt(cfg.dias_gracia_recargo) || 0
        pct    = parseFloat(cfg.recargo_diario_pct) || 0
      }
    }

    // 4. Monto a cobrar = original + recargo por mora − ya pagado
    const base = Number(cuota.monto_original)
    const hoy = hoyAR()
    const diasAtraso = diasEntre(cuota.fecha_vencimiento, hoy)
    const recargo = diasAtraso > gracia ? redondear(base * (pct / 100) * (diasAtraso - gracia)) : 0
    const saldo = redondear(base + recargo - yaPagado)
    if (!(saldo > 0)) return res.status(409).json({ error: 'La cuota no tiene saldo pendiente' })

    // 5. Preferencia en Mercado Pago
    const titulo = (descripcion || `Cuota #${cuota.numero_cuota || numeroCuota || ''} - HogarCred`).toString().slice(0, 120)
    const preferencia = {
      items: [{
        id: idCuota,
        title: titulo,
        quantity: 1,
        unit_price: saldo,
        currency_id: 'ARS'
      }],
      payer: emailCliente ? { email: String(emailCliente).slice(0, 120) } : undefined,
      back_urls: {
        success: `https://hogarcred.vercel.app/?pago=ok&cuota=${idCuota}`,
        failure: `https://hogarcred.vercel.app/?pago=error&cuota=${idCuota}`,
        pending: `https://hogarcred.vercel.app/?pago=pendiente&cuota=${idCuota}`
      },
      auto_return: 'approved',
      external_reference: idCuota,
      notification_url: 'https://hogarcred.vercel.app/api/mp-webhook',
      statement_descriptor: 'HOGARCRED',
      metadata: {
        cuota_id: idCuota,
        credito_id: cuota.credito_id || creditoId || '',
        monto_esperado: saldo
      }
    }

    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        // La clave incluye monto y día: si cambia el saldo, se crea una preferencia nueva
        'X-Idempotency-Key': `${idCuota}-${Math.round(saldo * 100)}-${hoy}`
      },
      body: JSON.stringify(preferencia)
    })
    const data = await mpResp.json()
    if (!mpResp.ok) return res.status(mpResp.status).json({ error: data.message || 'Error de Mercado Pago', details: data })

    return res.status(200).json({
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      preference_id: data.id,
      monto_cobrar: saldo
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
