// /api/mp-webhook.js — Webhook de Mercado Pago (producción)
// Recibe la notificación de pago, verifica con MP, y marca la cuota como PAGADA
// + crea el registro de cobranza CON empresa_id y usuario_id correctos.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end()

  const { type, data } = req.body || {}
  if (type !== 'payment' || !data?.id) return res.status(200).json({ ok: true })

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
  const SUPA_URL     = process.env.SUPA_URL
  const SUPA_KEY     = process.env.SUPA_SERVICE_KEY

  try {
    // 1. Consultar el pago a Mercado Pago
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
    })
    const pago = await mpResp.json()

    // Solo procesar pagos aprobados
    if (pago.status !== 'approved') return res.status(200).json({ ok: true })

    const cuotaId = pago.external_reference
    const hoy = new Date().toISOString().split('T')[0]
    if (!cuotaId || !SUPA_KEY) return res.status(200).json({ ok: true })

    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json'
    }

    // 2. Idempotencia: ¿ya existe una cobranza para este pago de MP? (evita duplicados)
    const existeResp = await fetch(
      `${SUPA_URL}/rest/v1/cobranzas?referencia_pago=eq.${encodeURIComponent(String(data.id))}&select=id`,
      { headers }
    )
    const existentes = await existeResp.json().catch(() => [])
    if (Array.isArray(existentes) && existentes.length > 0) {
      return res.status(200).json({ ok: true, duplicado: true })
    }

    // 3. Buscar la cuota para obtener credito_id (y de ahí empresa_id + usuario_id)
    const cuotaResp = await fetch(
      `${SUPA_URL}/rest/v1/cuotas?id=eq.${cuotaId}&select=id,credito_id,empresa_id`,
      { headers }
    )
    const cuotas = await cuotaResp.json().catch(() => [])
    const cuota  = cuotas?.[0]

    let empresaId = cuota?.empresa_id || null
    let usuarioId = null

    // 4. Buscar el crédito para sacar empresa_id y usuario_id si falta
    if (cuota?.credito_id) {
      const crResp = await fetch(
        `${SUPA_URL}/rest/v1/creditos?id=eq.${cuota.credito_id}&select=empresa_id,usuario_id`,
        { headers }
      )
      const creds = await crResp.json().catch(() => [])
      const cr = creds?.[0]
      if (cr) {
        empresaId = empresaId || cr.empresa_id || null
        usuarioId = cr.usuario_id || null
      }
    }

    // 5. Marcar la cuota como PAGADA
    await fetch(`${SUPA_URL}/rest/v1/cuotas?id=eq.${cuotaId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ estado: 'PAGADA', fecha_pago: hoy })
    })

    // 6. Crear la cobranza CON empresa_id y usuario_id
    await fetch(`${SUPA_URL}/rest/v1/cobranzas`, {
      method: 'POST', headers,
      body: JSON.stringify({
        cuota_id:        cuotaId,
        empresa_id:      empresaId,
        usuario_id:      usuarioId,
        monto_cobrado:   pago.transaction_amount,
        metodo_pago:     'MP_' + (pago.payment_type_id || 'ONLINE').toUpperCase(),
        referencia_pago: String(data.id),
        anulada:         false,
        datos: JSON.stringify({ mp_payment_id: data.id, mp_status: pago.status })
      })
    })

    return res.status(200).json({ ok: true })
  } catch (err) {
    // Siempre responder 200 a MP para que no reintente infinitamente
    return res.status(200).json({ ok: true, error: err.message })
  }
}
