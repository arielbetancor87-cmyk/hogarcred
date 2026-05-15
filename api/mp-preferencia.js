export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { idCuota, monto, descripcion, emailCliente, creditoId, numeroCuota } = req.body || {}
  if (!idCuota || !monto) return res.status(400).json({ error: 'idCuota y monto requeridos' })
  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' })
  const preferencia = {
    items: [{ id: idCuota, title: descripcion || `Cuota #${numeroCuota} - HogarCred`, quantity: 1, unit_price: Math.round(parseFloat(monto)), currency_id: 'ARS' }],
    payer: emailCliente ? { email: emailCliente } : undefined,
    back_urls: { success: `https://hogarcred.vercel.app/?pago=ok&cuota=${idCuota}`, failure: `https://hogarcred.vercel.app/?pago=error&cuota=${idCuota}`, pending: `https://hogarcred.vercel.app/?pago=pendiente&cuota=${idCuota}` },
    auto_return: 'approved', external_reference: idCuota,
    notification_url: 'https://hogarcred.vercel.app/api/mp-webhook',
    statement_descriptor: 'HOGARCRED', metadata: { cuota_id: idCuota, credito_id: creditoId || '' }
  }
  try {
    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': idCuota },
      body: JSON.stringify(preferencia)
    })
    const data = await mpResp.json()
    if (!mpResp.ok) return res.status(mpResp.status).json({ error: data.message, details: data })
    return res.status(200).json({ init_point: data.init_point, sandbox_init_point: data.sandbox_init_point, preference_id: data.id })
  } catch (err) { return res.status(500).json({ error: err.message }) }
}