<?php
/**
 * ============================================================
 *  BOT TELEGRAM — Sistema Inteligente de Canais
 *  v5.0 — Autenticação por OWNER_ID, roles (Owner/Admin/User),
 *  HMAC de webhook, audit log, novos comandos /admins /leads.
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

// ── Receber update do Telegram ──────────────────────────────
$raw = file_get_contents('php://input');
$update = json_decode($raw, true);

if (!$update) {
    http_response_code(200);
    exit;
}

// ── Carregar dados persistentes ─────────────────────────────
$dataFile = __DIR__ . '/bot_data.json';
$botData = loadBotData($dataFile);

// ── Processar update ────────────────────────────────────────
if (isset($update['message'])) {
    handleMessage($update['message'], $botData, $dataFile);
} elseif (isset($update['callback_query'])) {
    handleCallback($update['callback_query'], $botData, $dataFile);
} elseif (isset($update['my_chat_member'])) {
    handleMemberUpdate($update['my_chat_member'], $botData, $dataFile);
} elseif (isset($update['channel_post'])) {
    // Bot adicionado a um canal — registrar
    $chat = $update['channel_post']['chat'];
    registerChat($chat, $botData, $dataFile);
}

http_response_code(200);
exit;


// ══════════════════════════════════════════════════════════════
//  DATA MANAGEMENT
// ══════════════════════════════════════════════════════════════

function loadBotData($file) {
    $default = [
        'admins' => [],           // IDs de admins autorizados
        'log_channel' => null,    // Chat ID do canal de logs selecionado
        'known_chats' => [],      // Chats onde o bot está
        'msg_history' => [],      // Anti-spam: histórico de mensagens
        'cooldowns' => [],        // Cooldown por tipo de mensagem
        'setup_complete' => false,
        'created_at' => date('Y-m-d H:i:s')
    ];
    if (!file_exists($file)) {
        file_put_contents($file, json_encode($default, JSON_PRETTY_PRINT), LOCK_EX);
        return $default;
    }
    $data = json_decode(file_get_contents($file), true);
    return $data ?: $default;
}

function saveBotData($file, $data) {
    $data['updated_at'] = date('Y-m-d H:i:s');
    file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function registerChat($chat, &$botData, $dataFile) {
    $chatId = strval($chat['id']);
    $title = $chat['title'] ?? ($chat['first_name'] ?? 'Chat Privado');
    $type = $chat['type'] ?? 'unknown';
    
    $botData['known_chats'][$chatId] = [
        'id' => $chatId,
        'title' => $title,
        'type' => $type,
        'username' => $chat['username'] ?? null,
        'added_at' => date('Y-m-d H:i:s'),
        'active' => true
    ];
    saveBotData($dataFile, $botData);
}

// ── Verificação de Owner ─────────────────────────────────
function isOwner($userId): bool {
    $ownerId = TG_OWNER_ID;
    if (empty($ownerId)) return false; // Owner não configurado = ninguém é owner
    return strval($userId) === strval($ownerId);
}

// ── Verificação de Admin ──────────────────────────────────
// CRÍTICO: NÃO permite mais que qualquer pessoa vire admin.
// Apenas o Owner (TG_OWNER_ID) pode autorizar admins.
function isAdmin($userId, $botData): bool {
    if (isOwner($userId)) return true;
    return in_array(strval($userId), array_map('strval', $botData['admins'] ?? []));
}

// ── Audit Log ─────────────────────────────────────────────
function auditLog($action, $userId, $userName, $dataFile, &$botData): void {
    $entry = [
        'ts'     => date('Y-m-d H:i:s'),
        'action' => $action,
        'uid'    => strval($userId),
        'name'   => $userName,
    ];
    if (!isset($botData['audit_log'])) $botData['audit_log'] = [];
    $botData['audit_log'][] = $entry;
    // Manter apenas últimos 200 registros
    if (count($botData['audit_log']) > 200) {
        $botData['audit_log'] = array_slice($botData['audit_log'], -200);
    }
    saveBotData($dataFile, $botData);
}


// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════

function handleMessage($msg, &$botData, $dataFile) {
    $chatId = $msg['chat']['id'];
    $userId = $msg['from']['id'] ?? 0;
    $text = trim($msg['text'] ?? '');
    $chatType = $msg['chat']['type'] ?? 'private';
    
    // Se é grupo/supergrupo/canal, registrar
    if ($chatType !== 'private') {
        registerChat($msg['chat'], $botData, $dataFile);
    }
    
    // Comandos só funcionam em chat privado com admin
    if ($chatType !== 'private') return;
    
    switch (true) {
        case $text === '/start':
            handleStart($chatId, $userId, $msg['from'], $botData, $dataFile);
            break;
        case $text === '/status':
            if (isAdmin($userId, $botData)) handleStatus($chatId, $botData);
            break;
        case $text === '/help':
            handleHelp($chatId);
            break;
        case $text === '/admins':
            if (isAdmin($userId, $botData)) handleAdminsCmd($chatId, $botData);
            break;
        case $text === '/clearadmins':
            if (isOwner($userId)) handleClearAdmins($chatId, $userId, $botData, $dataFile);
            else sendMessage($chatId, "⛔ Apenas o *Owner* pode executar este comando\.", null);
            break;
        case $text === '/leads':
            if (isAdmin($userId, $botData)) handleLeadsStats($chatId, $botData);
            break;
        default:
            // Ignorar mensagens aleatórias
            break;
    }
}


// ══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

function handleStart($chatId, $userId, $from, &$botData, $dataFile) {
    // ── Owner pode sempre usar; outros precisam estar na lista de admins
    $userIdStr = strval($userId);
    $owner     = isOwner($userId);
    $admin     = isAdmin($userId, $botData);

    if (!$admin) {
        // Usuário desconhecido — não revelar nada, apenas negar silenciosamente
        sendMessage($chatId, "⛔ *Acesso Restrito*\n\nVocê não está autorizado a usar este bot\.", null);
        return;
    }

    // Registrar owner como admin se ainda não estiver
    if ($owner && !in_array($userIdStr, array_map('strval', $botData['admins'] ?? []))) {
        $botData['admins'][] = $userIdStr;
        saveBotData($dataFile, $botData);
    }

    auditLog('start_panel', $userId, $from['first_name'] ?? 'N/A', $dataFile, $botData);

    $firstName  = escMdV2($from['first_name'] ?? 'Admin');
    $totalChats = count($botData['known_chats'] ?? []);
    $logChannel = $botData['log_channel'] ?? null;
    $roleBadge  = $owner ? '👑 Owner' : '🛡 Admin';
    $totalAdmins = count($botData['admins'] ?? []);

    $statusIcon = $logChannel ? '🟢' : '🔴';
    $statusText = $logChannel
        ? 'Canal: *' . escMdV2(getChannelName($logChannel, $botData)) . '*'
        : 'Canal de logs *não configurado*';

    // Stats de leads nas últimas 24h
    $leads24h = 0;
    $now = time();
    foreach ($botData['msg_history'] ?? [] as $entry) {
        if (($entry['type'] ?? '') === 'lead' && ($now - ($entry['ts'] ?? 0)) < 86400) $leads24h++;
    }

    $text  = "🤖 *Painel de Controle — Bot Monitor*\n\n";
    $text .= "👋 Olá, *{$firstName}* \\({$roleBadge}\\)\!\n";
    $text .= "🆔 ID: `{$userId}`\n\n";
    $text .= "{$statusIcon} {$statusText}\n";
    $text .= "📡 Canais: *{$totalChats}* • Admins: *{$totalAdmins}*\n";
    $text .= "📊 Leads \\(24h\\): *{$leads24h}*\n\n";
    $text .= "Use os botões abaixo:";

    $keyboard = [
        [
            ['text' => '📡 Listar Canais',    'callback_data' => 'list_channels'],
            ['text' => '✅ Selecionar Canal', 'callback_data' => 'select_channel']
        ],
        [
            ['text' => '📊 Status',           'callback_data' => 'status'],
            ['text' => '🔄 Atualizar',        'callback_data' => 'refresh_channels']
        ],
        [
            ['text' => '🧪 Enviar Teste',     'callback_data' => 'send_test'],
            ['text' => '👥 Admins',           'callback_data' => 'admins_list']
        ],
        [
            ['text' => '📈 Leads Hoje',       'callback_data' => 'leads_stats'],
            ['text' => '❓ Ajuda',            'callback_data' => 'help']
        ]
    ];

    sendMessage($chatId, $text, $keyboard);
}

function handleStatus($chatId, $botData) {
    sendStatusMessage($chatId, $botData);
}

function handleHelp($chatId) {
    $text = "❓ *Ajuda — Bot de Monitoramento*\n\n";
    $text .= "Este bot monitora o checkout e envia notificações em tempo real\\.\n\n";
    $text .= "📋 *Comandos:*\n";
    $text .= "• /start \\- Painel principal\n";
    $text .= "• /status \\- Ver status atual\n";
    $text .= "• /help \\- Esta mensagem\n\n";
    $text .= "🔧 *Como configurar:*\n";
    $text .= "1\\. Adicione o bot ao grupo/canal desejado\n";
    $text .= "2\\. Dê permissão de admin ao bot no canal\n";
    $text .= "3\\. Volte aqui e clique em 🔄 Atualizar Canais\n";
    $text .= "4\\. Selecione o canal para receber os logs\n\n";
    $text .= "⚡ *Funcionalidades:*\n";
    $text .= "• Anti\\-spam inteligente\n";
    $text .= "• Deduplicação de mensagens\n";
    $text .= "• Cooldown por tipo de evento\n";
    $text .= "• Formatação rica com emojis\n";
    $text .= "• Criptografia AES\\-256\\-GCM\n";
    $text .= "\n📋 *Novos Comandos:*\n";
    $text .= "• /admins \\- Listar admins autorizados\n";
    $text .= "• /clearadmins \\- Limpar admins \\(só Owner\\)\n";
    $text .= "• /leads \\- Estatísticas de leads";

    $keyboard = [
        [['text' => '🔙 Voltar ao Menu', 'callback_data' => 'main_menu']]
    ];

    sendMessage($chatId, $text, $keyboard);
}

// ── Lista de admins autorizados ──────────────────────────────
function handleAdminsCmd($chatId, $botData): void {
    $admins = $botData['admins'] ?? [];
    $ownerId = TG_OWNER_ID;

    if (empty($admins) && empty($ownerId)) {
        sendMessage($chatId, "👥 *Admins Autorizados*\n\nNenhum admin registrado\\.", [
            [['text' => '🔙 Menu', 'callback_data' => 'main_menu']]
        ]);
        return;
    }

    $text  = "👥 *Admins Autorizados*\n\n";
    $kb    = [];
    $shown = [];

    if ($ownerId) {
        $text .= "👑 *Owner:* `{$ownerId}`\n\n";
        $shown[] = strval($ownerId);
    }

    $otherAdmins = array_filter($admins, fn($a) => !in_array(strval($a), $shown));

    if (!empty($otherAdmins)) {
        $text .= "🛡 *Admins Registrados:*\n";
        foreach ($otherAdmins as $adminId) {
            $adminIdStr = strval($adminId);
            $text .= "• `{$adminIdStr}`\n";
            $kb[] = [['text' => "🗑 Remover: {$adminIdStr}", 'callback_data' => "remove_admin:{$adminIdStr}"]];
        }
    } else {
        $text .= "🛡 Nenhum admin adicional registrado\\.";
    }

    $text .= "\n\n_Total: " . escMdV2(strval(count($admins))) . " admin\\(s\\)_";
    $kb[] = [['text' => '🔙 Menu', 'callback_data' => 'main_menu']];

    sendMessage($chatId, $text, $kb);
}

// ── Limpar admins (só Owner) ─────────────────────────────────
function handleClearAdmins($chatId, $userId, &$botData, $dataFile): void {
    $ownerId = strval(TG_OWNER_ID);
    $botData['admins'] = $ownerId ? [$ownerId] : [];
    auditLog('clear_admins', $userId, 'Owner', $dataFile, $botData);

    sendMessage($chatId,
        "✅ *Lista de admins limpa\\!*\n\nApenas o Owner permanece autorizado\\.",
        [[['text' => '🔙 Menu', 'callback_data' => 'main_menu']]]
    );
}

// ── Stats de leads ────────────────────────────────────────────
function handleLeadsStats($chatId, $botData): void {
    $now     = time();
    $history = $botData['msg_history'] ?? [];

    $stats = [
        'lead'          => ['label' => '👁 Leads',          '1h' => 0, '24h' => 0, 'total' => 0],
        'personal_data' => ['label' => '👤 Dados Pessoais', '1h' => 0, '24h' => 0, 'total' => 0],
        'address'       => ['label' => '🏠 Endereços',      '1h' => 0, '24h' => 0, 'total' => 0],
        'card_data'     => ['label' => '💳 Cartões',        '1h' => 0, '24h' => 0, 'total' => 0],
        'pix_selected'  => ['label' => '🟢 PIX',            '1h' => 0, '24h' => 0, 'total' => 0],
    ];

    foreach ($history as $entry) {
        $t    = $entry['type'] ?? '';
        $age  = $now - ($entry['ts'] ?? 0);
        if (!isset($stats[$t])) continue;
        $stats[$t]['total']++;
        if ($age < 86400) $stats[$t]['24h']++;
        if ($age < 3600)  $stats[$t]['1h']++;
    }

    $ts   = escMdV2(date('d/m/Y H:i:s'));
    $text = "📈 *Estatísticas de Leads*  —  {$ts}\n━━━━━━━━━━━━━━━━━━━━━\n\n";
    $text .= "```\n";
    $text .= sprintf("%-18s %4s %5s %6s\n", "Tipo", "1h", "24h", "Total");
    $text .= str_repeat("─", 36) . "\n";
    foreach ($stats as $s) {
        $label = mb_substr(preg_replace('/[^\p{L}\p{N} ]/u', '', $s['label']), 0, 18);
        $text .= sprintf("%-18s %4d %5d %6d\n", $label, $s['1h'], $s['24h'], $s['total']);
    }
    $text .= "```";

    sendMessage($chatId, $text, [
        [['text' => '🔄 Atualizar', 'callback_data' => 'leads_stats']],
        [['text' => '🔙 Menu',      'callback_data' => 'main_menu']]
    ]);
}


// ══════════════════════════════════════════════════════════════
//  CALLBACK HANDLER (BOTÕES)
// ══════════════════════════════════════════════════════════════

function handleCallback($callback, &$botData, $dataFile) {
    $callbackId = $callback['id'];
    $chatId = $callback['message']['chat']['id'];
    $msgId = $callback['message']['message_id'];
    $userId = $callback['from']['id'];
    $data = $callback['data'];
    
    // Verificar se é admin
    if (!isAdmin($userId, $botData)) {
        answerCallback($callbackId, '⛔ Acesso não autorizado');
        return;
    }
    
    switch (true) {
        case $data === 'main_menu':
            answerCallback($callbackId, '🏠 Menu principal');
            handleStart($chatId, $userId, $callback['from'], $botData, $dataFile);
            break;

        case $data === 'list_channels':
            answerCallback($callbackId, '📡 Carregando canais...');
            listChannels($chatId, $msgId, $botData);
            break;

        case $data === 'select_channel':
            answerCallback($callbackId, '✅ Selecione um canal');
            showChannelSelector($chatId, $msgId, $botData);
            break;

        case strpos($data, 'set_channel:') === 0:
            $targetChat = substr($data, 12);
            answerCallback($callbackId, '✅ Canal selecionado!');
            setLogChannel($chatId, $msgId, $targetChat, $botData, $dataFile);
            break;

        case $data === 'confirm_channel':
            answerCallback($callbackId, '✅ Confirmado!');
            confirmChannel($chatId, $msgId, $botData, $dataFile);
            break;

        case strpos($data, 'remove_channel:') === 0:
            $targetChat = substr($data, 15);
            answerCallback($callbackId, '🗑 Canal removido');
            removeChannel($chatId, $msgId, $targetChat, $botData, $dataFile);
            break;

        case $data === 'status':
            answerCallback($callbackId, '📊 Carregando status...');
            sendStatusMessage($chatId, $botData);
            break;

        case $data === 'refresh_channels':
            answerCallback($callbackId, '🔄 Atualizando...');
            refreshChannels($chatId, $msgId, $botData, $dataFile);
            break;

        case $data === 'send_test':
            answerCallback($callbackId, '🧪 Enviando teste...');
            sendTestMessage($chatId, $botData);
            break;

        case $data === 'help':
            answerCallback($callbackId, '❓ Ajuda');
            handleHelp($chatId);
            break;

        case $data === 'clear_history':
            answerCallback($callbackId, '🗑 Histórico limpo');
            $botData['msg_history'] = [];
            $botData['cooldowns']   = [];
            auditLog('clear_history', $userId, $callback['from']['first_name'] ?? 'N/A', $dataFile, $botData);
            sendStatusMessage($chatId, $botData);
            break;

        case $data === 'admins_list':
            answerCallback($callbackId, '👥 Carregando admins...');
            handleAdminsCmd($chatId, $botData);
            break;

        case $data === 'leads_stats':
            answerCallback($callbackId, '📈 Carregando leads...');
            handleLeadsStats($chatId, $botData);
            break;

        case strpos($data, 'remove_admin:') === 0:
            if (isOwner($userId)) {
                $targetAdmin = substr($data, 13);
                answerCallback($callbackId, '🗑 Admin removido');
                $botData['admins'] = array_filter($botData['admins'],
                    fn($a) => strval($a) !== strval($targetAdmin) && strval($a) !== strval(TG_OWNER_ID)
                );
                $botData['admins'] = array_values($botData['admins']);
                auditLog("remove_admin:{$targetAdmin}", $userId, $callback['from']['first_name'] ?? 'N/A', $dataFile, $botData);
                handleAdminsCmd($chatId, $botData);
            } else {
                answerCallback($callbackId, '⛔ Apenas Owner pode remover admins');
            }
            break;

        default:
            answerCallback($callbackId, '❓ Ação desconhecida');
            break;
    }
}


// ══════════════════════════════════════════════════════════════
//  CHANNEL MANAGEMENT
// ══════════════════════════════════════════════════════════════

function listChannels($chatId, $msgId, $botData) {
    $chats = $botData['known_chats'];
    
    if (empty($chats)) {
        $text = "📡 *Canais Conhecidos*\n\n";
        $text .= "Nenhum canal encontrado\\.\n\n";
        $text .= "📝 *Para adicionar:*\n";
        $text .= "1\\. Adicione o bot ao grupo/canal\n";
        $text .= "2\\. Dê permissão de admin ao bot\n";
        $text .= "3\\. Clique em 🔄 Atualizar Canais";
        
        $keyboard = [
            [['text' => '🔄 Atualizar Canais', 'callback_data' => 'refresh_channels']],
            [['text' => '🔙 Voltar ao Menu', 'callback_data' => 'main_menu']]
        ];
        
        sendMessage($chatId, $text, $keyboard);
        return;
    }
    
    $logChannel = $botData['log_channel'];
    $text = "📡 *Canais Conhecidos*\n\n";
    
    $keyboard = [];
    foreach ($chats as $id => $chat) {
        if (!($chat['active'] ?? true)) continue;
        
        $typeIcon = getTypeIcon($chat['type']);
        $isLog = ($id === strval($logChannel));
        $logBadge = $isLog ? ' ✅' : '';
        $title = escMdV2($chat['title']);
        $type = escMdV2(ucfirst($chat['type']));
        
        $text .= "{$typeIcon} *{$title}*{$logBadge}\n";
        $text .= "   ID: `{$id}` • Tipo: {$type}\n\n";
        
        // Botão para remover
        $keyboard[] = [
            ['text' => "🗑 Remover: {$chat['title']}", 'callback_data' => "remove_channel:{$id}"]
        ];
    }
    
    $keyboard[] = [['text' => '🔄 Atualizar', 'callback_data' => 'refresh_channels']];
    $keyboard[] = [['text' => '🔙 Voltar ao Menu', 'callback_data' => 'main_menu']];
    
    sendMessage($chatId, $text, $keyboard);
}

function showChannelSelector($chatId, $msgId, $botData) {
    $chats = $botData['known_chats'];
    
    if (empty($chats)) {
        $text = "✅ *Selecionar Canal de Logs*\n\n";
        $text .= "Nenhum canal disponível\\.\n";
        $text .= "Adicione o bot a um grupo ou canal primeiro\\.";
        
        $keyboard = [
            [['text' => '🔄 Atualizar Canais', 'callback_data' => 'refresh_channels']],
            [['text' => '🔙 Voltar', 'callback_data' => 'main_menu']]
        ];
        
        sendMessage($chatId, $text, $keyboard);
        return;
    }
    
    $text = "✅ *Selecionar Canal de Logs*\n\n";
    $text .= "Toque no canal onde deseja receber as notificações:\n\n";
    
    $keyboard = [];
    foreach ($chats as $id => $chat) {
        if (!($chat['active'] ?? true)) continue;
        $typeIcon = getTypeIcon($chat['type']);
        $isLog = ($id === strval($botData['log_channel']));
        $badge = $isLog ? ' ✅ (Atual)' : '';
        $keyboard[] = [
            ['text' => "{$typeIcon} {$chat['title']}{$badge}", 'callback_data' => "set_channel:{$id}"]
        ];
    }
    
    // Opção de usar chat privado
    $keyboard[] = [
        ['text' => '💬 Usar este chat privado', 'callback_data' => "set_channel:{$chatId}"]
    ];
    
    $keyboard[] = [['text' => '🔙 Voltar', 'callback_data' => 'main_menu']];
    
    sendMessage($chatId, $text, $keyboard);
}

function setLogChannel($chatId, $msgId, $targetChat, &$botData, $dataFile) {
    $channelName = getChannelName($targetChat, $botData);
    if ($targetChat == $chatId) {
        $channelName = 'Chat Privado (Admin)';
    }
    
    $botData['_pending_channel'] = $targetChat;
    saveBotData($dataFile, $botData);
    
    $nameEsc = escMdV2($channelName);
    $text = "⚠️ *Confirmar Seleção*\n\n";
    $text .= "Canal selecionado:\n";
    $text .= "📌 *{$nameEsc}*\n";
    $text .= "🆔 `{$targetChat}`\n\n";
    $text .= "Todas as notificações do site serão enviadas para este canal\\.\n\n";
    $text .= "Deseja confirmar\\?";
    
    $keyboard = [
        [
            ['text' => '✅ Confirmar', 'callback_data' => 'confirm_channel'],
            ['text' => '❌ Cancelar', 'callback_data' => 'select_channel']
        ]
    ];
    
    sendMessage($chatId, $text, $keyboard);
}

function confirmChannel($chatId, $msgId, &$botData, $dataFile) {
    $pending = $botData['_pending_channel'] ?? null;
    if (!$pending) {
        sendMessage($chatId, "❌ Nenhum canal pendente para confirmar\\.", [
            [['text' => '🔙 Voltar', 'callback_data' => 'main_menu']]
        ]);
        return;
    }
    
    $botData['log_channel'] = $pending;
    $botData['setup_complete'] = true;
    unset($botData['_pending_channel']);
    saveBotData($dataFile, $botData);
    
    $channelName = getChannelName($pending, $botData);
    if ($pending == $chatId) $channelName = 'Chat Privado (Admin)';
    $nameEsc = escMdV2($channelName);
    
    $text = "✅ *Canal Configurado\\!*\n\n";
    $text .= "📌 Logs serão enviados para: *{$nameEsc}*\n";
    $text .= "🆔 ID: `{$pending}`\n\n";
    $text .= "O sistema está ativo e monitorando o checkout\\. 🟢";
    
    $keyboard = [
        [
            ['text' => '🧪 Enviar Teste', 'callback_data' => 'send_test'],
            ['text' => '📊 Status', 'callback_data' => 'status']
        ],
        [['text' => '🔙 Menu Principal', 'callback_data' => 'main_menu']]
    ];
    
    sendMessage($chatId, $text, $keyboard);
    
    // Enviar mensagem de boas-vindas no canal de logs
    if ($pending != $chatId) {
        $welcomeText = "🟢 *Bot Ativado\\!*\n\n";
        $welcomeText .= "Este canal foi configurado para receber notificações do checkout\\.\n\n";
        $welcomeText .= "📋 *Tipos de notificação:*\n";
        $welcomeText .= "• 👁 Novos leads \\(acessos\\)\n";
        $welcomeText .= "• 👤 Dados pessoais coletados\n";
        $welcomeText .= "• 🏠 Endereços coletados\n";
        $welcomeText .= "• 💳 Transações completas\n";
        $welcomeText .= "• 🟢 Seleções de PIX\n\n";
        $welcomeText .= "🔐 Todas as transmissões são criptografadas com AES\\-256\\-GCM";
        
        sendMessageRaw($pending, $welcomeText);
    }
}

function removeChannel($chatId, $msgId, $targetChat, &$botData, $dataFile) {
    if (isset($botData['known_chats'][$targetChat])) {
        $name = $botData['known_chats'][$targetChat]['title'];
        unset($botData['known_chats'][$targetChat]);
        
        // Se era o canal de logs, remover
        if (strval($botData['log_channel']) === strval($targetChat)) {
            $botData['log_channel'] = null;
            $botData['setup_complete'] = false;
        }
        
        saveBotData($dataFile, $botData);
        
        $nameEsc = escMdV2($name);
        $text = "🗑 Canal *{$nameEsc}* removido com sucesso\\.";
    } else {
        $text = "❌ Canal não encontrado\\.";
    }
    
    $keyboard = [
        [['text' => '📡 Ver Canais', 'callback_data' => 'list_channels']],
        [['text' => '🔙 Menu', 'callback_data' => 'main_menu']]
    ];
    
    sendMessage($chatId, $text, $keyboard);
}

function refreshChannels($chatId, $msgId, &$botData, $dataFile) {
    // Verificar quais chats ainda são válidos
    $token = TG_BOT_TOKEN;
    $validCount = 0;
    $invalidCount = 0;
    
    foreach ($botData['known_chats'] as $id => &$chat) {
        $url = "https://api.telegram.org/bot{$token}/getChat?chat_id={$id}";
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true
        ]);
        $resp = json_decode(curl_exec($ch), true);
        curl_close($ch);
        
        if ($resp && ($resp['ok'] ?? false)) {
            $result = $resp['result'];
            $chat['title'] = $result['title'] ?? $chat['title'];
            $chat['type'] = $result['type'] ?? $chat['type'];
            $chat['username'] = $result['username'] ?? $chat['username'] ?? null;
            $chat['members'] = null;
            $chat['active'] = true;
            $chat['last_check'] = date('Y-m-d H:i:s');
            
            // Tentar pegar contagem de membros
            $countUrl = "https://api.telegram.org/bot{$token}/getChatMemberCount?chat_id={$id}";
            $chCount = curl_init($countUrl);
            curl_setopt_array($chCount, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 3, CURLOPT_SSL_VERIFYPEER => true]);
            $countResp = json_decode(curl_exec($chCount), true);
            curl_close($chCount);
            if ($countResp && ($countResp['ok'] ?? false)) {
                $chat['members'] = $countResp['result'];
            }
            
            $validCount++;
        } else {
            $chat['active'] = false;
            $invalidCount++;
        }
    }
    unset($chat);
    
    // Também registrar o chat privado do admin
    $botData['known_chats'][strval($chatId)] = [
        'id' => strval($chatId),
        'title' => 'Chat Privado (Admin)',
        'type' => 'private',
        'active' => true,
        'added_at' => date('Y-m-d H:i:s')
    ];
    
    saveBotData($dataFile, $botData);
    
    $total = count(array_filter($botData['known_chats'], function($c) { return $c['active'] ?? true; }));
    
    $text = "🔄 *Canais Atualizados\\!*\n\n";
    $text .= "✅ Ativos: *{$validCount}*\n";
    if ($invalidCount > 0) {
        $text .= "❌ Inativos: *{$invalidCount}*\n";
    }
    $text .= "📡 Total: *{$total}*\n\n";
    $text .= "_Última verificação: " . escMdV2(date('d/m/Y H:i:s')) . "_";
    
    $keyboard = [
        [
            ['text' => '📡 Ver Canais', 'callback_data' => 'list_channels'],
            ['text' => '✅ Selecionar', 'callback_data' => 'select_channel']
        ],
        [['text' => '🔙 Menu', 'callback_data' => 'main_menu']]
    ];
    
    sendMessage($chatId, $text, $keyboard);
}


// ══════════════════════════════════════════════════════════════
//  STATUS & TESTING
// ══════════════════════════════════════════════════════════════

function sendStatusMessage($chatId, $botData) {
    $logChannel = $botData['log_channel'];
    $totalChats = count($botData['known_chats']);
    $activeChats = count(array_filter($botData['known_chats'], function($c) { return $c['active'] ?? true; }));
    $totalMsgs = count($botData['msg_history']);
    $setupDone = $botData['setup_complete'] ? '🟢 Ativo' : '🔴 Pendente';
    
    // Contar mensagens nas últimas 24h
    $now = time();
    $msgs24h = 0;
    foreach ($botData['msg_history'] as $entry) {
        if (($now - ($entry['ts'] ?? 0)) < 86400) $msgs24h++;
    }
    
    // Cooldown status
    $activeCooldowns = 0;
    foreach ($botData['cooldowns'] as $type => $ts) {
        if (($now - $ts) < getCooldownDuration($type)) $activeCooldowns++;
    }
    
    $channelName = $logChannel ? getChannelName($logChannel, $botData) : 'Não configurado';
    $channelNameEsc = escMdV2($channelName);
    $updatedAt = escMdV2($botData['updated_at'] ?? 'N/A');
    
    $text = "📊 *Status do Sistema*\n\n";
    $text .= "🔧 Sistema: {$setupDone}\n";
    $text .= "📌 Canal de logs: *{$channelNameEsc}*\n";
    $text .= "📡 Canais conhecidos: *{$activeChats}*/{$totalChats}\n\n";
    $text .= "📨 *Métricas:*\n";
    $text .= "• Msgs enviadas \\(total\\): *{$totalMsgs}*\n";
    $text .= "• Msgs últimas 24h: *{$msgs24h}*\n";
    $text .= "• Cooldowns ativos: *{$activeCooldowns}*\n\n";
    $text .= "🕐 Última atualização: _{$updatedAt}_";
    
    $keyboard = [
        [
            ['text' => '🗑 Limpar Histórico', 'callback_data' => 'clear_history'],
            ['text' => '🧪 Enviar Teste', 'callback_data' => 'send_test']
        ],
        [['text' => '🔙 Menu Principal', 'callback_data' => 'main_menu']]
    ];
    
    sendMessage($chatId, $text, $keyboard);
}

function sendTestMessage($chatId, $botData) {
    $logChannel = $botData['log_channel'];
    
    if (!$logChannel) {
        $text = "❌ Nenhum canal de logs configurado\\.\n";
        $text .= "Configure um canal primeiro\\.";
        
        $keyboard = [
            [['text' => '✅ Selecionar Canal', 'callback_data' => 'select_channel']],
            [['text' => '🔙 Voltar', 'callback_data' => 'main_menu']]
        ];
        
        sendMessage($chatId, $text, $keyboard);
        return;
    }
    
    $ts = escMdV2(date('d/m/Y H:i:s'));
    $testMsg = "🧪 *MENSAGEM DE TESTE*\n\n";
    $testMsg .= "━━━━━━━━━━━━━━━━━━━━━\n";
    $testMsg .= "✅ O bot está funcionando corretamente\\!\n\n";
    $testMsg .= "📋 *Informações:*\n";
    $testMsg .= "• 🕐 Horário: {$ts}\n";
    $testMsg .= "• 🔐 Criptografia: AES\\-256\\-GCM\n";
    $testMsg .= "• 📡 Canal: " . escMdV2(getChannelName($logChannel, $botData)) . "\n";
    $testMsg .= "• 🆔 ID: `{$logChannel}`\n\n";
    $testMsg .= "As notificações de checkout serão exibidas neste canal\\.";
    
    $success = sendMessageRaw($logChannel, $testMsg);
    
    if ($success) {
        $text = "✅ Mensagem de teste enviada com sucesso\\!\n";
        $text .= "Verifique o canal de logs\\.";
    } else {
        $text = "❌ Falha ao enviar mensagem de teste\\.\n";
        $text .= "Verifique se o bot tem permissão no canal\\.";
    }
    
    $keyboard = [
        [['text' => '🔙 Menu', 'callback_data' => 'main_menu']]
    ];
    
    sendMessage($chatId, $text, $keyboard);
}


// ══════════════════════════════════════════════════════════════
//  MY_CHAT_MEMBER — Auto-registro de canais
// ══════════════════════════════════════════════════════════════

function handleMemberUpdate($update, &$botData, $dataFile) {
    $chat = $update['chat'];
    $newStatus = $update['new_chat_member']['status'] ?? '';
    
    // Bot foi adicionado a um grupo/canal
    if (in_array($newStatus, ['member', 'administrator'])) {
        registerChat($chat, $botData, $dataFile);
        
        // Notificar admins
        foreach ($botData['admins'] as $adminId) {
            $nameEsc = escMdV2($chat['title'] ?? 'Novo Chat');
            $typeEsc = escMdV2(ucfirst($chat['type'] ?? 'unknown'));
            $text = "📡 *Novo canal detectado\\!*\n\n";
            $text .= "📌 Nome: *{$nameEsc}*\n";
            $text .= "🆔 ID: `{$chat['id']}`\n";
            $text .= "📂 Tipo: {$typeEsc}\n\n";
            $text .= "Deseja usar este canal para logs\\?";
            
            $keyboard = [
                [
                    ['text' => '✅ Usar como Logs', 'callback_data' => "set_channel:{$chat['id']}"],
                    ['text' => '❌ Ignorar', 'callback_data' => 'main_menu']
                ]
            ];
            
            sendMessage($adminId, $text, $keyboard);
        }
    }
    
    // Bot foi removido de um grupo/canal
    if (in_array($newStatus, ['kicked', 'left'])) {
        $chatId = strval($chat['id']);
        if (isset($botData['known_chats'][$chatId])) {
            $botData['known_chats'][$chatId]['active'] = false;
        }
        if (strval($botData['log_channel']) === $chatId) {
            $botData['log_channel'] = null;
            $botData['setup_complete'] = false;
            // Notificar admins
            foreach ($botData['admins'] as $adminId) {
                $text = "⚠️ *Canal de logs removido\\!*\n\n";
                $text .= "O bot foi removido do canal de logs\\.\n";
                $text .= "Configure um novo canal\\.";
                $keyboard = [[['text' => '✅ Selecionar Canal', 'callback_data' => 'select_channel']]];
                sendMessage($adminId, $text, $keyboard);
            }
        }
        saveBotData($dataFile, $botData);
    }
}


// ══════════════════════════════════════════════════════════════
//  ANTI-SPAM INTELIGENTE
// ══════════════════════════════════════════════════════════════

function getCooldownDuration($type) {
    $cooldowns = [
        'lead' => 5,              // 5s entre leads do mesmo IP
        'personal_data' => 10,    // 10s entre dados pessoais
        'address' => 10,          // 10s entre endereços
        'card_data' => 15,        // 15s entre cartões
        'pix_selected' => 10,     // 10s entre PIX
        'test' => 30              // 30s entre testes
    ];
    return $cooldowns[$type] ?? 10;
}

function shouldSendMessage($type, $data, &$botData, $dataFile) {
    $now = time();
    
    // 1. Cooldown por tipo
    $cooldownKey = $type;
    if (isset($data['txId'])) {
        $cooldownKey = $type . ':' . $data['txId'];
    }
    
    $lastSent = $botData['cooldowns'][$cooldownKey] ?? 0;
    $cooldown = getCooldownDuration($type);
    if (($now - $lastSent) < $cooldown) {
        return false; // Em cooldown
    }
    
    // 2. Deduplicação — verificar se mensagem idêntica já foi enviada
    $hash = md5($type . json_encode($data));
    foreach ($botData['msg_history'] as $entry) {
        if ($entry['hash'] === $hash && ($now - $entry['ts']) < 300) { // 5min dedup window
            return false; // Duplicata
        }
    }
    
    // 3. Rate limit global: max 20 msgs/min
    $recentMsgs = array_filter($botData['msg_history'], function($e) use ($now) {
        return ($now - $e['ts']) < 60;
    });
    if (count($recentMsgs) >= 20) {
        return false; // Rate limited
    }
    
    // Registrar
    $botData['cooldowns'][$cooldownKey] = $now;
    $botData['msg_history'][] = [
        'type' => $type,
        'hash' => $hash,
        'ts' => $now
    ];
    
    // Limpar histórico antigo (manter últimas 500 entries)
    if (count($botData['msg_history']) > 500) {
        $botData['msg_history'] = array_slice($botData['msg_history'], -200);
    }
    
    // Limpar cooldowns antigos
    foreach ($botData['cooldowns'] as $key => $ts) {
        if (($now - $ts) > 300) unset($botData['cooldowns'][$key]);
    }
    
    saveBotData($dataFile, $botData);
    return true;
}

/**
 * Chamado pelo relay.php para enviar notificação
 * Retorna o chat_id do canal de logs ou null
 */
function getLogChannelId() {
    $dataFile = __DIR__ . '/bot_data.json';
    $botData = loadBotData($dataFile);
    
    if (!$botData['setup_complete'] || !$botData['log_channel']) {
        return null;
    }
    
    return $botData['log_channel'];
}

/**
 * Verifica anti-spam e retorna true se deve enviar
 */
function checkAntiSpam($type, $data) {
    $dataFile = __DIR__ . '/bot_data.json';
    $botData = loadBotData($dataFile);
    return shouldSendMessage($type, $data, $botData, $dataFile);
}


// ══════════════════════════════════════════════════════════════
//  TELEGRAM API HELPERS
// ══════════════════════════════════════════════════════════════

function escMdV2($text) {
    $chars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    foreach ($chars as $c) {
        $text = str_replace($c, '\\' . $c, $text);
    }
    return $text;
}

function getChannelName($chatId, $botData) {
    if (isset($botData['known_chats'][strval($chatId)])) {
        return $botData['known_chats'][strval($chatId)]['title'] ?? 'Chat #' . $chatId;
    }
    return 'Chat #' . $chatId;
}

function getTypeIcon($type) {
    $icons = [
        'group' => '👥',
        'supergroup' => '👥',
        'channel' => '📢',
        'private' => '💬'
    ];
    return $icons[$type] ?? '📡';
}

function sendMessage($chatId, $text, $keyboard = null) {
    $token = TG_BOT_TOKEN;
    $url = "https://api.telegram.org/bot{$token}/sendMessage";
    
    $postData = [
        'chat_id' => $chatId,
        'text' => $text,
        'parse_mode' => 'MarkdownV2',
        'disable_web_page_preview' => true
    ];
    
    if ($keyboard) {
        $postData['reply_markup'] = json_encode(['inline_keyboard' => $keyboard]);
    }
    
    return tgRequest($url, $postData);
}

function sendMessageRaw($chatId, $text) {
    $token = TG_BOT_TOKEN;
    $url = "https://api.telegram.org/bot{$token}/sendMessage";
    
    $postData = [
        'chat_id' => $chatId,
        'text' => $text,
        'parse_mode' => 'MarkdownV2',
        'disable_web_page_preview' => true
    ];
    
    $result = tgRequest($url, $postData);
    
    // Fallback sem parse_mode
    if (!$result) {
        $postData['parse_mode'] = '';
        $postData['text'] = strip_tags($text);
        return tgRequest($url, $postData);
    }
    
    return $result;
}

function answerCallback($callbackId, $text) {
    $token = TG_BOT_TOKEN;
    $url = "https://api.telegram.org/bot{$token}/answerCallbackQuery";
    
    tgRequest($url, [
        'callback_query_id' => $callbackId,
        'text' => $text,
        'show_alert' => false
    ]);
}

function tgRequest($url, $postData) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($postData),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json']
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    if ($httpCode === 200) {
        $result = json_decode($response, true);
        return ($result['ok'] ?? false);
    }
    
    // Retry em 429
    if ($httpCode === 429) {
        $resp = json_decode($response, true);
        $retryAfter = $resp['parameters']['retry_after'] ?? 1;
        sleep(min($retryAfter, 3));
        
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($postData),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json']
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        return $httpCode === 200;
    }
    
    error_log("[BOT] TG API error: HTTP {$httpCode} - " . substr($response ?? '', 0, 200));
    return false;
}
