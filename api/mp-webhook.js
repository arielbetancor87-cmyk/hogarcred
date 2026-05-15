export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end()
  const { type, data } = req.body || {}
  if (type !== 'payment' || !data?.id) return res.status(200).json({ ok: true })
  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
  const SUPA_URL = process.env.SUPA_URL
  const SUPA_KEY = process.env.SUPA_SERVICE_KEY
  try {
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } })
    const pago = await mpResp.json()
    if (pago.status !== 'approved') return res.status(200).json({ ok: true })
    const cuotaId = pago.external_reference
    const hoy = new Date().toISOString().split('T')[0]
    if (cuotaId && SUPA_KEY) {
      await fetch(`${SUPA_URL}/rest/v1/cuotas?id=eq.${cuotaId}`, { method: 'PATCH', headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'PAGADA', fecha_pago: hoy }) })
      await fetch(`${SUPA_URL}/rest/v1/cobranzas`, { method: 'POST', headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cuota_id: cuotaId, monto_cobrado: pago.transaction_amount, metodo_pago: 'MP_' + (pago.payment_type_id || 'ONLINE').toUpperCase(), referencia_pago: String(data.id), anulada: false, datos: JSON.stringify({ mp_payment_id: data.id, mp_status: pago.status }) }) })
    }
    return res.status(200).json({ ok: true })
  } catch (err) { return res.status(200).json({ ok: true }) }
}