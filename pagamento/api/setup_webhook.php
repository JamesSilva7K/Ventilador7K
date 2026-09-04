<?php
/**
 * ============================================================
 *  WEBHOOK SETUP — Registrar bot no Telegram
 *  
 *  Execute UMA VEZ para configurar o webhook.
 *  Acesse: https://seu-dominio.com/pagamento/api/setup_webhook.php
 *  
 *  Depois pode deletar este arquivo por segurança.
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

$token = TG_BOT_TOKEN;

// Detectar URL base automaticamente
$protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = $_SERVER['HTTP_HOST'];
$path = dirname($_SERVER['SCRIPT_NAME']);
$webhookUrl = "{$protocol}://{$host}{$path}/bot.php";

// Ação
$action = $_GET['action'] ?? 'set';

echo "<pre style='font-family:monospace;background:#1a1a2e;color:#e94560;padding:20px;border-radius:10px;'>\n";
echo "🤖 Telegram Bot Webhook Setup\n";
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

if ($action === 'info') {
    // Info do bot
    $url = "https://api.telegram.org/bot{$token}/getMe";
    $response = json_decode(file_get_contents($url), true);
    
    if ($response['ok']) {
        $bot = $response['result'];
        echo "✅ Bot encontrado!\n";
        echo "📌 Nome: {$bot['first_name']}\n";
        echo "🆔 Username: @{$bot['username']}\n";
        echo "🔢 ID: {$bot['id']}\n";
    } else {
        echo "❌ Erro ao buscar info do bot\n";
    }
    
    // Webhook status
    $url = "https://api.telegram.org/bot{$token}/getWebhookInfo";
    $response = json_decode(file_get_contents($url), true);
    
    if ($response['ok']) {
        $info = $response['result'];
        echo "\n📡 Webhook Status:\n";
        echo "   URL: " . ($info['url'] ?: '(não configurado)') . "\n";
        echo "   Pending: " . ($info['pending_update_count'] ?? 0) . "\n";
        echo "   Last error: " . ($info['last_error_message'] ?? 'nenhum') . "\n";
    }
    
} elseif ($action === 'set') {
    echo "📡 Configurando webhook...\n";
    echo "   URL: {$webhookUrl}\n\n";
    
    $url = "https://api.telegram.org/bot{$token}/setWebhook";
    $postData = [
        'url' => $webhookUrl,
        'allowed_updates' => json_encode(['message', 'callback_query', 'my_chat_member', 'channel_post']),
        'drop_pending_updates' => true,
        'max_connections' => 40
    ];
    
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $postData,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true
    ]);
    
    $response = json_decode(curl_exec($ch), true);
    curl_close($ch);
    
    if ($response['ok'] ?? false) {
        echo "✅ Webhook configurado com sucesso!\n\n";
        echo "🎯 Próximos passos:\n";
        echo "   1. Abra o Telegram\n";
        echo "   2. Procure o bot\n";
        echo "   3. Envie /start\n";
        echo "   4. Configure o canal de logs pelos botões\n";
        echo "   5. Delete este arquivo por segurança\n";
    } else {
        echo "❌ Erro: " . ($response['description'] ?? 'desconhecido') . "\n";
        echo "\n⚠️  O webhook requer HTTPS com certificado válido!\n";
    }
    
} elseif ($action === 'delete') {
    $url = "https://api.telegram.org/bot{$token}/deleteWebhook?drop_pending_updates=true";
    $response = json_decode(file_get_contents($url), true);
    
    if ($response['ok'] ?? false) {
        echo "✅ Webhook removido com sucesso!\n";
    } else {
        echo "❌ Erro ao remover webhook\n";
    }
}

echo "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
echo "📋 Ações disponíveis:\n";
echo "   ?action=set    — Configurar webhook\n";
echo "   ?action=info   — Ver status do bot\n";
echo "   ?action=delete — Remover webhook\n";
echo "</pre>\n";
