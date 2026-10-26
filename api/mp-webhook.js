// /api/mp-webhook.js — Webhook de Mercado Pago (producción) v2
//
// Qué hace distinto a la versión anterior:
//  * Marca la cuota PAGADA solo si lo cobrado cubre lo que corresponde;
//    si entró menos, registra el cobro como PARCIAL y deja la cuota pendiente.
//  * Registra primero la cobranza y después actualiza la cuota. El índice
//    único de referencia_pago (pagos MP_) evita duplicados aunque MP
//    mande la notificación dos veces a la vez.
//  * Si algo falla al guardar, responde 500 para que Mercado Pago REINTENTE
//    (antes respondía siempre 200 y el pago podía perderse sin avisar).
//  * Fechas en horario de Argentina (antes usaba UTC).
//  * Si con este pago se completan todas las cuotas, pasa el crédito a CANCELADO.

const TZ = 'America/Argentina/Buenos_Aires'
const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
const redondear = n => Math.round(n * 100) / 100

function diasEntre(desdeISO, hastaISO) {
  const [y1, m1, d1] = desdeISO.split('-').map(Number)
  const [y2, m2, d2] = hastaISO.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end()

  const { type, data } = req.body || {}
  const topic = type || req.query?.topic
  const paymentId = data?.id || req.query?.id
  // Solo nos interesan notificaciones de pagos
  if (topic !== 'payment' || !paymentId) return res.status(200).json({ ok: true })

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
  const SUPA_URL     = process.env.SUPA_URL
  const SUPA_KEY     = process.env.SUPA_SERVICE_KEY
  if (!ACCESS_TOKEN || !SUPA_URL || !SUPA_KEY) {
    console.error('mp-webhook: faltan variables de entorno')
    return res.status(500).json({ ok: false, error: 'config' })
  }

  const sb = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json'
  }

  try {
    // 1. Consultar el pago real a Mercado Pago (no se confía en el cuerpo de la notificación)
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    })
    if (!mpResp.ok) {
      console.error('mp-webhook: MP respondió', mpResp.status)
      return res.status(500).json({ ok: false, error: 'mp' })
    }
    const pago = await mpResp.json()

    if (pago.status !== 'approved') return res.status(200).json({ ok: true, ignorado: pago.status })
    const cuotaId = pago.external_reference
    if (!cuotaId) return res.status(200).json({ ok: true, ignorado: 'sin referencia' })

    const monto = Number(pago.transaction_amount)
    if (!(monto > 0)) return res.status(200).json({ ok: true, ignorado: 'monto inválido' })

    // 2. ¿Ya procesamos este pago?
    const dupR = await fetch(
      `${SUPA_URL}/rest/v1/cobranzas?referencia_pago=eq.${encodeURIComponent(String(paymentId))}&select=id`,
      { headers: sb }
    )
    if (dupR.ok && (await dupR.json()).length > 0) return res.status(200).json({ ok: true, duplicado: true })

    // 3. Cuota → crédito (empresa_id y usuario_id)
    const cuotaR = await fetch(
      `${SUPA_URL}/rest/v1/cuotas?id=eq.${encodeURIComponent(cuotaId)}` +
      `&select=id,credito_id,empresa_id,monto_original,fecha_vencimiento,estado`,
      { headers: sb }
    )
    const cuota = cuotaR.ok ? (await cuotaR.json())?.[0] : null
    if (!cuota) {
      console.error('mp-webhook: cuota no encontrada', cuotaId)
      return res.status(200).json({ ok: true, ignorado: 'cuota inexistente' })
    }

    let empresaId = cuota.empresa_id || null
    let usuarioId = null
    const crR = await fetch(
      `${SUPA_URL}/rest/v1/creditos?id=eq.${cuota.credito_id}&select=empresa_id,usuario_id`,
      { headers: sb }
    )
    const cr = crR.ok ? (await crR.json())?.[0] : null
    if (cr) { empresaId = empresaId || cr.empresa_id || null; usuarioId = cr.usuario_id || null }
    if (!empresaId) {
      console.error('mp-webhook: no se pudo determinar la empresa de la cuota', cuotaId)
      return res.status(500).json({ ok: false, error: 'empresa' })
    }

    // 4. ¿Cubre este pago lo que corresponde?
    const cobR = await fetch(
      `${SUPA_URL}/rest/v1/cobranzas?cuota_id=eq.${encodeURIComponent(cuotaId)}&anulada=eq.false&select=monto_cobrado`,
      { headers: sb }
    )
    const previas = cobR.ok ? await cobR.json() : []
    const yaPagado = previas.reduce((s, c) => s + Number(c.monto_cobrado || 0), 0)

    let gracia = 0, pct = 0
    const empR = await fetch(`${SUPA_URL}/rest/v1/empresas?id=eq.${empresaId}&select=config`, { headers: sb })
    if (empR.ok) {
      let cfg = (await empR.json())?.[0]?.config || {}
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = {} } }
      gracia = parseInt(cfg.dias_gracia_recargo) || 0
      pct    = parseFloat(cfg.recargo_diario_pct) || 0
    }

    const hoy = hoyAR()
    const base = Number(cuota.monto_original)
    const dias = diasEntre(cuota.fecha_vencimiento, hoy)
    const recargoHoy = dias > gracia ? redondear(base * (pct / 100) * (dias - gracia)) : 0
    const totalHoy = redondear(base + recargoHoy)
    const esperado = Number(pago.metadata?.monto_esperado) || 0  // monto calculado al crear el link

    const acumulado = redondear(yaPagado + monto)
    const cubre =
      acumulado >= totalHoy - 0.01 ||
      (esperado > 0 && monto >= esperado - 0.01 && acumulado >= base - 0.01)

    // 5. Registrar la cobranza PRIMERO (el índice único evita duplicados)
    const insR = await fetch(`${SUPA_URL}/rest/v1/cobranzas`, {
      method: 'POST',
      headers: { ...sb, Prefer: 'return=minimal' },
      body: JSON.stringify({
        cuota_id:        cuotaId,
        empresa_id:      empresaId,
        usuario_id:      usuarioId,
        monto_cobrado:   monto,
        metodo_pago:     'MP_' + String(pago.payment_type_id || 'ONLINE').toUpperCase(),
        referencia_pago: String(paymentId),
        anulada:         false,
        datos: JSON.stringify({
          mp_payment_id: paymentId,
          mp_status: pago.status,
          esParcial: !cubre,
          montoOriginalCuota: totalHoy
        })
      })
    })
    if (!insR.ok) {
      const txt = await insR.text().catch(() => '')
      // 23505 = violación de unicidad → ya estaba registrado, no es un error
      if (txt.includes('23505') || insR.status === 409) return res.status(200).json({ ok: true, duplicado: true })
      console.error('mp-webhook: no se pudo insertar la cobranza', insR.status, txt)
      return res.status(500).json({ ok: false, error: 'insert' })
    }

    // 6. Si cubre el total → cuota PAGADA (y crédito CANCELADO si era la última)
    if (cubre) {
      const patch = await fetch(`${SUPA_URL}/rest/v1/cuotas?id=eq.${encodeURIComponent(cuotaId)}`, {
        method: 'PATCH',
        headers: sb,
        body: JSON.stringify({ estado: 'PAGADA', fecha_pago: hoy })
      })
      if (!patch.ok) {
        console.error('mp-webhook: no se pudo marcar la cuota PAGADA', patch.status)
        return res.status(500).json({ ok: false, error: 'patch' })
      }

      const restR = await fetch(
        `${SUPA_URL}/rest/v1/cuotas?credito_id=eq.${cuota.credito_id}&estado=not.in.(PAGADA,CANCELADA)&select=id`,
        { headers: sb }
      )
      if (restR.ok && (await restR.json()).length === 0) {
        await fetch(`${SUPA_URL}/rest/v1/creditos?id=eq.${cuota.credito_id}`, {
          method: 'PATCH', headers: sb, body: JSON.stringify({ estado: 'CANCELADO' })
        })
      }
    }

    return res.status(200).json({ ok: true, cubre })
  } catch (err) {
    console.error('mp-webhook error:', err.message)
    // 500 → Mercado Pago reintenta; el índice único evita duplicados
    return res.status(500).json({ ok: false, error: err.message })
  }
}
