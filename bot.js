/**
 * ============================================================
 *  BOT POLLING LOCAL — Monitor de Checkout
 *  v5.0 — Token via .env, exponential backoff, audit log,
 *  novos comandos /admins /leads /clearadmins, role system.
 *
 *  Roda localmente via long-polling (sem HTTPS necessário).
 *  Persiste config em pagamento/api/bot_data.json
 * ============================================================
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Carregar .env ─────────────────────────────────────────────
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...rest] = trimmed.split('=');
    const v = rest.join('=').trim();
    if (k && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const TOKEN    = process.env.TG_BOT_TOKEN || '';
const OWNER_ID = process.env.TG_OWNER_ID  || '';

if (!TOKEN) {
  console.error('❌ TG_BOT_TOKEN não definido. Configure o arquivo .env');
  process.exit(1);
}
if (!OWNER_ID) {
  console.warn('⚠️  TG_OWNER_ID não definido. Apenas comandos públicos funcionarão.');
}

const DATA_FILE = path.join(__dirname, 'pagamento', 'api', 'bot_data.json');

// ── Cores ─────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m'
};

function log(icon, label, msg, color = C.reset) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`${C.dim}[${ts}]${C.reset} ${icon} ${color}${C.bright}${label}${C.reset} ${msg}`);
}

// ── Roles ─────────────────────────────────────────────────────
function isOwner(userId) {
  return OWNER_ID && String(userId) === String(OWNER_ID);
}

function isAdmin(userId, data) {
  if (isOwner(userId)) return true;
  return (data.admins || []).includes(String(userId));
}

// ── Audit Log ─────────────────────────────────────────────────
function auditLog(action, userId, userName, data) {
  if (!data.audit_log) data.audit_log = [];
  data.audit_log.push({
    ts:     new Date().toLocaleString('pt-BR'),
    action, uid: String(userId), name: userName
  });
  if (data.audit_log.length > 200) data.audit_log = data.audit_log.slice(-200);
}

// ── Bot Data ──────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw  = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (!data.admins) data.admins = [];
      if (!data.known_chats) data.known_chats = {};
      if (!data.msg_history) data.msg_history = [];
      if (!data.cooldowns)   data.cooldowns   = {};
      // Garantir owner sempre presente
      if (OWNER_ID && !data.admins.includes(OWNER_ID)) {
        data.admins.push(OWNER_ID);
        saveData(data);
      }
      return data;
    }
  } catch(e) {
    log('⚠️', 'DATA', `Erro ao carregar bot_data.json: ${e.message}`, C.yellow);
  }
  const fresh = {
    admins:         OWNER_ID ? [OWNER_ID] : [],
    log_channel:    null,
    known_chats:    {},
    msg_history:    [],
    cooldowns:      {},
    audit_log:      [],
    setup_complete: false
  };
  saveData(fresh);
  return fresh;
}

function saveData(data) {
  // Garantir owner sempre presente
  if (OWNER_ID && !data.admins.includes(OWNER_ID)) data.admins.push(OWNER_ID);
  data.updated_at = new Date().toLocaleString('pt-BR');
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) {
    log('❌', 'DATA', `Erro ao salvar bot_data.json: ${e.message}`, C.red);
  }
}

// ── Verificação de permissão dinâmica via API ─────────────────
async function checkAdminPermission(userId, data) {
  const uStr = String(userId);
  if (isOwner(userId)) {
    if (!data.admins.includes(OWNER_ID)) { data.admins.push(OWNER_ID); saveData(data); }
    return { authorized: true, isOwner: true, role: '👑 Owner' };
  }
  if (data.admins.includes(uStr)) {
    return { authorized: true, isOwner: false, role: '🛡 Admin' };
  }
  // Verificação dinâmica em grupos conhecidos
  const targetChats = [];
  if (data.log_channel) targetChats.push(data.log_channel);
  for (const [cId, c] of Object.entries(data.known_chats || {})) {
    if (c?.active && c.type !== 'private' && !targetChats.includes(cId)) targetChats.push(cId);
  }
  for (const chatId of targetChats) {
    const r = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
    if (r.ok && ['creator','administrator'].includes(r.result?.status)) {
      if (!data.admins.includes(uStr)) { data.admins.push(uStr); saveData(data); }
      return { authorized: true, isOwner: false, role: '🛡 Admin do Grupo' };
    }
  }
  return { authorized: false, isOwner: false, role: 'Usuário' };
}

// ── Escape MarkdownV2 ─────────────────────────────────────────
function esc(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ── Telegram API ──────────────────────────────────────────────
function tgApi(method, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body || {});
    const opts = {
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(data);
    req.end();
  });
}

// ── getUpdates com exponential backoff ────────────────────────
let offset = 0;
let consecutiveErrors = 0;
const MAX_BACKOFF_MS   = 30000;
const BASE_BACKOFF_MS  = 1000;

async function getUpdates() {
  const result = await tgApi('getUpdates', {
    offset,
    timeout: 30,
    allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post']
  });
  if (!result.ok || !result.result) {
    consecutiveErrors++;
    const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
    log('⚠️', 'POLLING', `Erro #${consecutiveErrors}. Backoff: ${backoff / 1000}s`, C.yellow);
    await new Promise(r => setTimeout(r, backoff));
    return [];
  }
  consecutiveErrors = 0;
  if (result.result.length > 0) {
    offset = result.result[result.result.length - 1].update_id + 1;
  }
  return result.result;
}

// ── Enviar mensagem ───────────────────────────────────────────
async function sendMsg(chatId, text, keyboard) {
  const body = {
    chat_id: chatId, text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const r = await tgApi('sendMessage', body);
  if (!r.ok) {
    // Fallback plain
    body.text = text.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
    delete body.parse_mode;
    await tgApi('sendMessage', body);
  }
  return r;
}

async function answerCb(id, text) {
  await tgApi('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}

// ── Refresh info de chat ──────────────────────────────────────
async function refreshChatInfo(chatId) {
  const [chatInfo, memberCount] = await Promise.all([
    tgApi('getChat', { chat_id: chatId }),
    tgApi('getChatMemberCount', { chat_id: chatId })
  ]);
  if (chatInfo.ok) {
    const c = chatInfo.result;
    return {
      id: String(chatId), title: c.title || c.first_name || `Chat ${chatId}`,
      type: c.type, username: c.username || null,
      members: memberCount.ok ? memberCount.result : null,
      active: true, last_check: new Date().toLocaleString('pt-BR')
    };
  }
  return null;
}

function getChannelName(data, chatId) {
  return data.known_chats?.[String(chatId)]?.title || `Chat ${chatId}`;
}

// ══════════════════════════════════════════════════════════════
//  HANDLERS DE COMANDO
// ══════════════════════════════════════════════════════════════

async function handleStart(chatId, userId, from) {
  const data = loadData();
  const perm = await checkAdminPermission(userId, data);

  if (!perm.authorized) {
    await sendMsg(chatId, `⛔ *Acesso Restrito*\n\nVocê não está autorizado a usar este bot\\.`, []);
    log('⛔', 'NEGADO', `${from.first_name || 'User'} (${userId})`, C.red);
    return;
  }

  data.known_chats[String(chatId)] = {
    id: String(chatId), title: `${from.first_name || 'Admin'} (Chat Privado)`,
    type: 'private', active: true, added_at: new Date().toLocaleString('pt-BR')
  };
  auditLog('start_panel', userId, from.first_name || 'N/A', data);
  saveData(data);
  log('👤', 'CONECTADO', `${from.first_name} [${perm.role}] (${userId})`, C.green);

  const name        = esc(from.first_name || 'Admin');
  const totalChats  = Object.keys(data.known_chats).length;
  const logChannel  = data.log_channel;
  const totalAdmins = (data.admins || []).length;
  const statusIcon  = logChannel ? '🟢' : '🔴';
  const channelTxt  = logChannel ? `Canal: *${esc(getChannelName(data, logChannel))}*` : 'Canal *não configurado*';

  // Stats 24h
  const now = Date.now();
  const leads24h = (data.msg_history || []).filter(e => e.type === 'lead' && (now / 1000 - e.ts) < 86400).length;

  const text = `🤖 *Painel de Controle*\n\n👋 Olá, *${name}* \\(${esc(perm.role)}\\)\\!\n🆔 ID: \`${userId}\`\n\n${statusIcon} ${channelTxt}\n📡 Canais: *${totalChats}* • Admins: *${totalAdmins}*\n📊 Leads \\(24h\\): *${leads24h}*\n\nUse os botões abaixo:`;

  await sendMsg(chatId, text, [
    [{ text: '📡 Listar Canais',   callback_data: 'list_channels'   }, { text: '✅ Selecionar Canal', callback_data: 'select_channel' }],
    [{ text: '📊 Status',          callback_data: 'status'          }, { text: '🔄 Atualizar',        callback_data: 'refresh_channels' }],
    [{ text: '🧪 Enviar Teste',    callback_data: 'send_test'       }, { text: '👥 Admins',           callback_data: 'admins_list' }],
    [{ text: '📈 Leads Hoje',      callback_data: 'leads_stats'     }, { text: '❓ Ajuda',            callback_data: 'help' }]
  ]);
}

async function handleAdminsList(chatId, userId) {
  const data    = loadData();
  const admins  = data.admins || [];
  const ownerId = OWNER_ID;

  let text = `👥 *Admins Autorizados*\n\n`;
  const kb = [];

  if (ownerId) {
    text += `👑 *Owner:* \`${esc(ownerId)}\`\n\n`;
  }

  const others = admins.filter(a => String(a) !== String(ownerId));
  if (others.length) {
    text += `🛡 *Admins Registrados:*\n`;
    for (const a of others) {
      text += `• \`${esc(String(a))}\`\n`;
      if (isOwner(userId)) {
        kb.push([{ text: `🗑 Remover: ${a}`, callback_data: `rem_admin:${a}` }]);
      }
    }
  } else {
    text += `🛡 Nenhum admin adicional\\.`;
  }

  text += `\n\n_Total: ${admins.length} admin\\(s\\)_`;
  kb.push([{ text: '🔙 Menu', callback_data: 'main_menu' }]);
  await sendMsg(chatId, text, kb);
}

async function handleLeadsStats(chatId) {
  const data    = loadData();
  const history = data.msg_history || [];
  const now     = Date.now() / 1000;

  const types = {
    lead:          { label: 'Leads',        '1h': 0, '24h': 0, total: 0 },
    personal_data: { label: 'Dados Pessoais', '1h': 0, '24h': 0, total: 0 },
    address:       { label: 'Endereços',    '1h': 0, '24h': 0, total: 0 },
    card_data:     { label: 'Cartoes',      '1h': 0, '24h': 0, total: 0 },
    pix_selected:  { label: 'PIX',         '1h': 0, '24h': 0, total: 0 },
  };

  for (const e of history) {
    const t   = e.type;
    const age = now - (e.ts || 0);
    if (!types[t]) continue;
    types[t].total++;
    if (age < 86400) types[t]['24h']++;
    if (age < 3600)  types[t]['1h']++;
  }

  const ts   = esc(new Date().toLocaleString('pt-BR'));
  let text   = `📈 *Estatísticas de Leads*  —  ${ts}\n\`\`\`\n`;
  text += `${'Tipo'.padEnd(18)} ${'1h'.padStart(4)} ${'24h'.padStart(5)} ${'Total'.padStart(6)}\n`;
  text += '─'.repeat(36) + '\n';
  for (const s of Object.values(types)) {
    text += `${s.label.padEnd(18)} ${String(s['1h']).padStart(4)} ${String(s['24h']).padStart(5)} ${String(s.total).padStart(6)}\n`;
  }
  text += '```';

  await sendMsg(chatId, text, [
    [{ text: '🔄 Atualizar', callback_data: 'leads_stats' }],
    [{ text: '🔙 Menu',      callback_data: 'main_menu'   }]
  ]);
}

async function handleListChannels(chatId, data) {
  const chats = data.known_chats;
  if (!Object.keys(chats).length) {
    await sendMsg(chatId, `📡 *Canais Conhecidos*\n\nNenhum canal encontrado\\.`, [
      [{ text: '🔄 Atualizar', callback_data: 'refresh_channels' }],
      [{ text: '🔙 Menu',      callback_data: 'main_menu' }]
    ]);
    return;
  }
  const icons = { group: '👥', supergroup: '👥', channel: '📢', private: '💬' };
  let text = `📡 *Canais Conhecidos \\(${Object.keys(chats).length}\\)*\n\n`;
  const kb = [];
  for (const [id, chat] of Object.entries(chats)) {
    if (!chat.active) continue;
    const icon  = icons[chat.type] || '📡';
    const isLog = String(data.log_channel) === String(id);
    const badge = isLog ? ' ✅' : '';
    text += `${icon} *${esc(chat.title)}*${badge}\n   \`${id}\`\n\n`;
    kb.push([{ text: `🗑 Remover: ${chat.title.substring(0, 25)}`, callback_data: `rem:${id}` }]);
  }
  kb.push([{ text: '🔄 Atualizar', callback_data: 'refresh_channels' }]);
  kb.push([{ text: '🔙 Menu',      callback_data: 'main_menu' }]);
  await sendMsg(chatId, text, kb);
}

async function handleSelectChannel(chatId, data) {
  const chats = Object.values(data.known_chats).filter(c => c.active);
  if (!chats.length) {
    await sendMsg(chatId, `✅ *Selecionar Canal de Logs*\n\nNenhum canal disponível\\.`, [
      [{ text: '🔄 Atualizar', callback_data: 'refresh_channels' }],
      [{ text: '🔙 Menu',      callback_data: 'main_menu' }]
    ]);
    return;
  }
  const icons = { group: '👥', supergroup: '👥', channel: '📢', private: '💬' };
  const kb = [];
  for (const chat of chats) {
    const icon  = icons[chat.type] || '📡';
    const isLog = String(data.log_channel) === String(chat.id);
    const badge = isLog ? ' ✅ (Atual)' : '';
    kb.push([{ text: `${icon} ${chat.title}${badge}`, callback_data: `set:${chat.id}` }]);
  }
  kb.push([{ text: '🔙 Menu', callback_data: 'main_menu' }]);
  await sendMsg(chatId, `✅ *Selecionar Canal de Logs*\n\nEscolha onde receber as notificações:`, kb);
}

async function handleSetChannel(chatId, targetId, data) {
  const name = getChannelName(data, targetId) || `Chat ${targetId}`;
  data._pending = targetId;
  saveData(data);
  await sendMsg(chatId,
    `⚠️ *Confirmar Seleção*\n\nCanal: *${esc(name)}*\nID: \`${esc(targetId)}\`\n\nDeseja confirmar\\?`,
    [[{ text: '✅ Confirmar', callback_data: 'confirm' }, { text: '❌ Cancelar', callback_data: 'select_channel' }]]
  );
}

async function handleConfirm(chatId, data, fromUser) {
  const pending = data._pending;
  if (!pending) {
    await sendMsg(chatId, `❌ Nenhuma seleção pendente\\.`, [[{ text: '🔙 Menu', callback_data: 'main_menu' }]]);
    return;
  }
  data.log_channel    = pending;
  data.setup_complete = true;
  delete data._pending;
  auditLog(`set_channel:${pending}`, fromUser.id, fromUser.first_name || 'N/A', data);
  saveData(data);
  const name = getChannelName(data, pending);
  log('✅', 'CANAL', `${name} (${pending})`, C.green);
  await sendMsg(chatId,
    `✅ *Canal Configurado\\!*\n\n📌 Logs: *${esc(name)}*\n🆔 \`${esc(pending)}\`\n\n🟢 Sistema ativo e monitorando o checkout\\.`,
    [[{ text: '🧪 Teste', callback_data: 'send_test' }, { text: '📊 Status', callback_data: 'status' }],
     [{ text: '🔙 Menu',  callback_data: 'main_menu' }]]
  );
  if (String(pending) !== String(chatId)) {
    await tgApi('sendMessage', {
      chat_id: pending,
      text: `🟢 *Bot Ativado\\!*\n\nEste canal receberá notificações do checkout\\.\n\n📋 *Eventos:*\n• 👁 Leads\n• 👤 Dados pessoais\n• 🏠 Endereços\n• 💳 Transações\n• 🟢 PIX\n\n✅ Dados validados antes de enviar \\(CPF ✓ Luhn ✓ Email ✓\\)\n🔐 AES\\-256\\-GCM`,
      parse_mode: 'MarkdownV2', disable_web_page_preview: true
    });
  }
}

async function handleRefresh(chatId, data) {
  let valid = 0, invalid = 0;
  for (const id of Object.keys(data.known_chats)) {
    const info = await refreshChatInfo(id);
    if (info) {
      data.known_chats[id] = { ...data.known_chats[id], ...info };
      valid++;
    } else {
      data.known_chats[id].active = false;
      if (String(data.log_channel) === id) { data.log_channel = null; data.setup_complete = false; }
      invalid++;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  saveData(data);
  const total = Object.values(data.known_chats).filter(c => c.active).length;
  await sendMsg(chatId,
    `🔄 *Canais Atualizados\\!*\n\n✅ Ativos: *${valid}*\n${invalid ? `❌ Inativos: *${invalid}*\n` : ''}📡 Total: *${total}*\n\n_${esc(new Date().toLocaleString('pt-BR'))}_`,
    [[{ text: '📡 Ver Canais', callback_data: 'list_channels' }, { text: '✅ Selecionar', callback_data: 'select_channel' }],
     [{ text: '🔙 Menu',       callback_data: 'main_menu' }]]
  );
}

async function handleStatus(chatId, data) {
  const now       = Date.now();
  const logCh     = data.log_channel;
  const chName    = logCh ? getChannelName(data, logCh) : 'Não configurado';
  const total     = Object.values(data.known_chats).filter(c => c.active).length;
  const setup     = data.setup_complete ? '🟢 Ativo' : '🔴 Pendente';
  const msgs24h   = (data.msg_history || []).filter(e => (now / 1000 - e.ts) < 86400).length;
  const totalMsgs = (data.msg_history || []).length;
  const admins    = (data.admins || []).length;

  await sendMsg(chatId,
    `📊 *Status do Sistema*\n\n🔧 Sistema: ${setup}\n📌 Canal: *${esc(chName)}*\n📡 Canais ativos: *${total}*\n👥 Admins: *${admins}*\n\n📨 *Mensagens:*\n• Total: *${totalMsgs}*\n• Últimas 24h: *${msgs24h}*\n\n🔐 Criptografia: AES\\-256\\-GCM\n🕐 _${esc(new Date().toLocaleString('pt-BR'))}_`,
    [[{ text: '🗑 Limpar Histórico', callback_data: 'clear_history' }, { text: '🧪 Teste', callback_data: 'send_test' }],
     [{ text: '📈 Leads',           callback_data: 'leads_stats'   }, { text: '🔙 Menu',  callback_data: 'main_menu' }]]
  );
}

async function handleTest(chatId, data) {
  const logCh = data.log_channel;
  if (!logCh) {
    await sendMsg(chatId, `❌ Nenhum canal configurado\\.`, [[{ text: '✅ Selecionar', callback_data: 'select_channel' }]]);
    return;
  }
  const ts   = esc(new Date().toLocaleString('pt-BR'));
  const name = esc(getChannelName(data, logCh));
  const r    = await tgApi('sendMessage', {
    chat_id: logCh,
    text: `🧪 *MENSAGEM DE TESTE*\n\n━━━━━━━━━━━━━━━━━━━━━\n✅ Bot funcionando corretamente\\!\n\n• 🕐 ${ts}\n• 🔐 AES\\-256\\-GCM ativo\n• 📡 Canal: ${name}\n• ✅ Validação de dados: CPF ✓ Email ✓ Luhn ✓\n\nNotificações serão enviadas aqui\\.`,
    parse_mode: 'MarkdownV2', disable_web_page_preview: true
  });
  const ok = r.ok;
  log(ok ? '✅' : '❌', 'TESTE', ok ? `Enviado → ${logCh}` : r.description, ok ? C.green : C.red);
  await sendMsg(chatId,
    ok ? `✅ Teste enviado com sucesso\\!\nVerifique o canal de logs\\.` : `❌ Falha ao enviar\\.\nVerifique se o bot é admin no canal\\.`,
    [[{ text: '🔙 Menu', callback_data: 'main_menu' }]]
  );
}

async function handleRemove(chatId, targetId, data) {
  const name = getChannelName(data, targetId);
  delete data.known_chats[targetId];
  if (String(data.log_channel) === String(targetId)) { data.log_channel = null; data.setup_complete = false; }
  saveData(data);
  await sendMsg(chatId, `🗑 Canal *${esc(name)}* removido\\.`, [
    [{ text: '📡 Ver Canais', callback_data: 'list_channels' }],
    [{ text: '🔙 Menu',       callback_data: 'main_menu' }]
  ]);
}

// ══════════════════════════════════════════════════════════════
//  PROCESSAR UPDATE
// ══════════════════════════════════════════════════════════════

// Rate limit de callbacks por userId (anti-flood de botões)
const cbRateLimit = {};
function checkCbRate(userId) {
  const now = Date.now();
  if (!cbRateLimit[userId]) cbRateLimit[userId] = [];
  cbRateLimit[userId] = cbRateLimit[userId].filter(ts => now - ts < 5000);
  if (cbRateLimit[userId].length >= 8) return false;
  cbRateLimit[userId].push(now);
  return true;
}

async function processUpdate(update) {
  const data = loadData();

  // Mensagem de texto
  if (update.message) {
    const msg      = update.message;
    const chatId   = msg.chat.id;
    const userId   = msg.from?.id;
    const text     = msg.text?.trim() || '';
    const chatType = msg.chat.type;

    if (chatType !== 'private') {
      data.known_chats[String(chatId)] = {
        id: String(chatId), title: msg.chat.title || 'Grupo',
        type: chatType, username: msg.chat.username || null,
        active: true, added_at: new Date().toLocaleString('pt-BR')
      };
      saveData(data);
      log('📡', 'CHAT', `${msg.chat.title} (${chatId})`, C.cyan);
      return;
    }

    const perm = await checkAdminPermission(userId, data);
    if (!perm.authorized) {
      await sendMsg(chatId, `⛔ *Acesso Restrito*\n\nVocê não está autorizado a usar este bot\\.`, []);
      return;
    }

    // ── Bot callback-only: apenas /start abre o painel ──────────────────
    // Todos os outros comandos e textos são silenciosamente ignorados.
    // Toda navegação ocorre via botões InlineKeyboard.
    if (text === '/start' || text === '/start@' + (process.env.BOT_USERNAME || '')) {
      await handleStart(chatId, userId, msg.from);
    }
    // Qualquer outro texto → ignorado (sem resposta = sem pegada)
    return;
  }

  // Callback de botão
  if (update.callback_query) {
    const cb     = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const cbData = cb.data;

    const perm = await checkAdminPermission(userId, data);
    if (!perm.authorized) {
      await answerCb(cb.id, '⛔ Acesso restrito');
      return;
    }

    if (!checkCbRate(userId)) {
      await answerCb(cb.id, '⏳ Aguarde um momento...');
      return;
    }

    await answerCb(cb.id, '');

    if      (cbData === 'main_menu')         await handleStart(chatId, userId, cb.from);
    else if (cbData === 'list_channels')     await handleListChannels(chatId, data);
    else if (cbData === 'select_channel')    await handleSelectChannel(chatId, data);
    else if (cbData === 'confirm')           await handleConfirm(chatId, data, cb.from);
    else if (cbData === 'refresh_channels')  await handleRefresh(chatId, data);
    else if (cbData === 'status')            await handleStatus(chatId, data);
    else if (cbData === 'send_test')         await handleTest(chatId, data);
    else if (cbData === 'admins_list')       await handleAdminsList(chatId, userId);
    else if (cbData === 'leads_stats')       await handleLeadsStats(chatId);
    else if (cbData === 'help') {
      await sendMsg(chatId, `❓ Use /start para abrir o painel\\.`, [[{ text: '🏠 Menu', callback_data: 'main_menu' }]]);
    }
    else if (cbData === 'clear_history') {
      const d = loadData(); d.msg_history = []; d.cooldowns = {};
      auditLog('clear_history', userId, cb.from.first_name || 'N/A', d);
      saveData(d);
      await sendMsg(chatId, `🗑 Histórico limpo\\.`, [[{ text: '📊 Status', callback_data: 'status' }]]);
    }
    else if (cbData.startsWith('set:'))       await handleSetChannel(chatId, cbData.slice(4), data);
    else if (cbData.startsWith('rem:'))       await handleRemove(chatId, cbData.slice(4), data);
    else if (cbData.startsWith('rem_admin:')) {
      if (isOwner(userId)) {
        const targetAdmin = cbData.slice(10);
        data.admins = data.admins.filter(a => String(a) !== String(targetAdmin) && String(a) !== String(OWNER_ID));
        auditLog(`remove_admin:${targetAdmin}`, userId, cb.from.first_name || 'N/A', data);
        saveData(data);
        await handleAdminsList(chatId, userId);
      }
    }
    return;
  }

  // Bot adicionado/removido de grupo
  if (update.my_chat_member) {
    const mcu       = update.my_chat_member;
    const chat      = mcu.chat;
    const newStatus = mcu.new_chat_member?.status;

    if (['member', 'administrator'].includes(newStatus)) {
      data.known_chats[String(chat.id)] = {
        id: String(chat.id), title: chat.title || 'Grupo',
        type: chat.type, username: chat.username || null,
        active: true, added_at: new Date().toLocaleString('pt-BR')
      };
      saveData(data);
      log('➕', 'BOT ADICIONADO', `${chat.title} (${chat.id})`, C.green);
      for (const adminId of data.admins) {
        await sendMsg(adminId,
          `📡 *Novo canal detectado\\!*\n\n📌 *${esc(chat.title)}*\n🆔 \`${chat.id}\`\n\nDeseja usar para logs\\?`,
          [[{ text: '✅ Usar como Logs', callback_data: `set:${chat.id}` }, { text: '❌ Ignorar', callback_data: 'main_menu' }]]
        );
      }
    } else if (['kicked', 'left'].includes(newStatus)) {
      if (data.known_chats[String(chat.id)]) data.known_chats[String(chat.id)].active = false;
      if (String(data.log_channel) === String(chat.id)) {
        data.log_channel    = null;
        data.setup_complete = false;
        for (const adminId of data.admins) {
          await sendMsg(adminId,
            `⚠️ *Canal de logs removido\\!*\n\nBot removido de *${esc(chat.title)}*\\.\nConfigure um novo canal\\.`,
            [[{ text: '✅ Selecionar Canal', callback_data: 'select_channel' }]]
          );
        }
      }
      saveData(data);
      log('➖', 'BOT REMOVIDO', `${chat.title} (${chat.id})`, C.yellow);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN LOOP
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log(`${C.bright}${C.blue}
╔══════════════════════════════════════════════════════════════╗
║       🤖  BOT POLLING v5.0 — Monitor de Checkout            ║
╚══════════════════════════════════════════════════════════════╝${C.reset}

  ${C.green}✅ Token carregado via .env${C.reset}
  ${C.cyan}📡 Modo: Long-polling (exponential backoff)${C.reset}
  ${C.yellow}👑 Owner ID: ${OWNER_ID || 'NÃO DEFINIDO'}${C.reset}
  ${C.magenta}🔐 Validação: CPF ✓ Email ✓ Luhn ✓ CEP ✓${C.reset}

  ${C.bright}🚀 Abra o Telegram e envie /start para o bot${C.reset}
  ${C.dim}Pressione Ctrl+C para parar${C.reset}
`);

  const data = loadData();
  if (data.log_channel) {
    log('✅', 'CANAL ATIVO', `${getChannelName(data, data.log_channel)} (${data.log_channel})`, C.green);
  } else {
    log('⚠️', 'SEM CANAL', 'Envie /start no bot para configurar o canal de logs', C.yellow);
  }
  console.log('');

  // Long-polling loop com exponential backoff integrado
  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        await processUpdate(update);
      }
    } catch(e) {
      consecutiveErrors++;
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
      log('❌', 'LOOP ERROR', `${e.message} — retry em ${backoff / 1000}s`, C.red);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

process.on('SIGINT', () => {
  console.log(`\n${C.yellow}⚡ Bot parado.${C.reset}\n`);
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log('💥', 'UNCAUGHT', e.message, C.red);
  // Não encerra — continua rodando
});

process.on('unhandledRejection', (reason) => {
  log('💥', 'REJECTION', String(reason), C.red);
});

main();
