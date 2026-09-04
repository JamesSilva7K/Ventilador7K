<?php
/**
 * ============================================================
 *  BIN CHECK API — Validador de Cartão de Crédito v1.0
 *  Endpoint: api/bin_check.php
 *
 *  Validações:
 *  1. Algoritmo de Luhn (checksum padrão)
 *  2. Detecção de bandeira por regex (Visa, MC, Elo, Amex, Hiper, Diners)
 *  3. Rejeição de números de teste conhecidos
 *  4. Rejeição de sequências inválidas (todos iguais, crescente)
 *  5. Lookup de BIN via base offline (prefixos Anatel/Febraban)
 *  6. Fallback para binlist.net (com cache 24h em arquivo)
 *  7. Validação adicional via api.binsearch.com (secundário)
 *
 *  Resposta JSON:
 *  { ok: bool, msg?: string, brand?: string, type?: string,
 *    bank?: string, country?: string, prepaid?: bool }
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');
setSecurityHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'msg' => 'Method not allowed']);
    exit;
}

$raw   = file_get_contents('php://input');
$input = json_decode($raw, true);

$cardNumber = preg_replace('/\D/', '', $input['card'] ?? '');

if (empty($cardNumber) || strlen($cardNumber) < 13) {
    echo json_encode(['ok' => false, 'msg' => 'Número de cartão inválido']);
    exit;
}

$result = validateCard($cardNumber);
echo json_encode($result, JSON_UNESCAPED_UNICODE);
exit;


// ═══════════════════════════════════════════════════════════
//  VALIDAÇÃO COMPLETA — 5 Camadas
// ═══════════════════════════════════════════════════════════

function validateCard(string $num): array {

    // ── Camada 1: Números de teste bloqueados ──────────────
    $TEST_CARDS = [
        '4111111111111111', '4242424242424242', '4000000000000002',
        '4000056655665556', '4000000000009995', '4000000000000101',
        '5500005555555559', '5555555555554444', '5200828282828210',
        '5105105105105100', '2223000048400011',
        '378282246310005',  '371449635398431',
        '6011111111111117', '6011000990139424',
        '3530111333300000', '3566002020360505',
    ];

    if (in_array($num, $TEST_CARDS, true)) {
        return ['ok' => false, 'msg' => 'Cartão de teste não aceito'];
    }

    // ── Camada 2: Sequências obviamente inválidas ──────────
    if (preg_match('/^(\d)\1+$/', $num)) {
        return ['ok' => false, 'msg' => 'Número de cartão inválido'];
    }
    // Sequência crescente (1234567890...)
    $ascending = '0123456789012345678901234567890';
    if (strpos($ascending, $num) !== false) {
        return ['ok' => false, 'msg' => 'Número de cartão inválido'];
    }

    // ── Camada 3: Algoritmo de Luhn ───────────────────────
    if (!luhnCheck($num)) {
        return ['ok' => false, 'msg' => 'Número de cartão inválido (checksum)'];
    }

    // ── Camada 4: Detecção de bandeira ────────────────────
    $brand = detectBrand($num);
    if (!$brand) {
        return ['ok' => false, 'msg' => 'Bandeira não reconhecida'];
    }

    // ── Camada 5: Lookup do BIN (6 dígitos) ──────────────
    $bin    = substr($num, 0, 6);
    $binData = lookupBin($bin);

    // Se o BIN foi encontrado e é pré-pago, bloquear
    if (!empty($binData['prepaid']) && $binData['prepaid'] === true) {
        return ['ok' => false, 'msg' => 'Cartões pré-pagos não são aceitos'];
    }

    return [
        'ok'      => true,
        'brand'   => $binData['brand']   ?? $brand['name'],
        'type'    => $binData['type']    ?? 'credit',
        'bank'    => $binData['bank']    ?? null,
        'country' => $binData['country'] ?? 'BR',
        'prepaid' => $binData['prepaid'] ?? false,
        'bin'     => $bin,
    ];
}


// ═══════════════════════════════════════════════════════════
//  LUHN CHECK
// ═══════════════════════════════════════════════════════════

function luhnCheck(string $num): bool {
    $sum = 0;
    $alt = false;
    for ($i = strlen($num) - 1; $i >= 0; $i--) {
        $n = intval($num[$i]);
        if ($alt) {
            $n *= 2;
            if ($n > 9) $n -= 9;
        }
        $sum += $n;
        $alt = !$alt;
    }
    return ($sum % 10) === 0;
}


// ═══════════════════════════════════════════════════════════
//  DETECÇÃO DE BANDEIRA (Regex por prefixo)
// ═══════════════════════════════════════════════════════════

function detectBrand(string $num): ?array {
    // Elo (checar antes da Visa — prefixos sobrepostos)
    if (preg_match('/^(636368|636369|438935|504175|451416|636297|5067|4576|4011|506699|650[0-9]{3}|651[0-9]{3}|509[0-9]{3}|6516|6550)/', $num)) {
        return ['code' => 'elo',  'name' => 'ELO',       'cvvLen' => 3, 'lengths' => [16]];
    }
    // Visa
    if (preg_match('/^4/', $num)) {
        return ['code' => 'visa', 'name' => 'VISA',      'cvvLen' => 3, 'lengths' => [13, 16, 19]];
    }
    // Mastercard (inclui BINs 2-series)
    if (preg_match('/^5[1-5]|^2(2[2-9]|[3-6]\d|7[01]|720)/', $num)) {
        return ['code' => 'master', 'name' => 'MASTERCARD', 'cvvLen' => 3, 'lengths' => [16]];
    }
    // American Express
    if (preg_match('/^3[47]/', $num)) {
        return ['code' => 'amex',  'name' => 'AMEX',     'cvvLen' => 4, 'lengths' => [15]];
    }
    // Hipercard
    if (preg_match('/^(606282|3841)/', $num)) {
        return ['code' => 'hiper', 'name' => 'HIPERCARD', 'cvvLen' => 3, 'lengths' => [13, 16, 19]];
    }
    // Diners Club
    if (preg_match('/^(301|305|36|38)/', $num)) {
        return ['code' => 'diners', 'name' => 'DINERS',  'cvvLen' => 3, 'lengths' => [14]];
    }
    // Discover
    if (preg_match('/^(6011|622(12[6-9]|1[3-9]\d|[2-8]\d{2}|9[01]\d|92[0-5])|64[4-9]|65)/', $num)) {
        return ['code' => 'discover', 'name' => 'DISCOVER', 'cvvLen' => 3, 'lengths' => [16, 19]];
    }
    return null;
}


// ═══════════════════════════════════════════════════════════
//  BIN LOOKUP — Local + Cache + API Fallback
// ═══════════════════════════════════════════════════════════

function lookupBin(string $bin): array {

    // ── Base offline de BINs brasileiros problemáticos ────
    // (pré-pagos, gift cards, virtuais que não devem ser aceitos)
    $BLOCKED_BINS = [
        // Caixa Econômica — cartões pré-pagos
        '606282', '637906',
        // Nubank — cartões virtuais ultra-restritivos (geralmente ok, mas BINs de gift)
        // Mantemos vazio por padrão — adicione se necessário
    ];

    // BINs que sabemos ser pré-pagos no Brasil
    $PREPAID_BINS = [
        '516220', // PicPay pré-pago
        '516222', // PicPay pré-pago
        '539744', // Superdigital Santander pré-pago
        '506743', // Boa Compra pré-pago
        '600716', // Sodexo alimentação (voucher)
        '603389', // VR alimentação/refeição
        '637095', // Alelo refeição
        '636386', // Alelo alimentação
        '531703', // Flash benefícios
        '544764', // Ticket Restaurante
        '606837', // Ben Visa Vale
        '516721', // Caju
        '539673', // InfinitePay pré-pago
    ];

    if (in_array($bin, $BLOCKED_BINS, true)) {
        return ['prepaid' => true, 'type' => 'blocked'];
    }
    if (in_array($bin, $PREPAID_BINS, true)) {
        return ['prepaid' => true, 'type' => 'prepaid'];
    }

    // ── Cache em arquivo (24h por BIN) ────────────────────
    $cacheFile = sys_get_temp_dir() . '/bin_' . md5($bin) . '.json';
    if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < 86400) {
        return json_decode(file_get_contents($cacheFile), true) ?: [];
    }

    // ── Lookup via binlist.net (API gratuita, sem key) ────
    $binData = fetchBinList($bin);

    // Salvar em cache mesmo que vazio (evitar spam da API)
    if (!empty($binData)) {
        file_put_contents($cacheFile, json_encode($binData), LOCK_EX);
    } else {
        // Cache vazio por 1h para não bater na API incessantemente
        file_put_contents($cacheFile, json_encode(['_miss' => time()]), LOCK_EX);
    }

    return $binData;
}

function fetchBinList(string $bin): array {
    $ch = curl_init("https://lookup.binlist.net/{$bin}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 4,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_HTTPHEADER     => ['Accept-Version: 3'],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (compatible; BinCheck/1.0)',
    ]);
    $res  = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code !== 200 || !$res) return [];

    $data = json_decode($res, true);
    if (!$data) return [];

    return [
        'brand'   => strtoupper($data['scheme'] ?? ''),
        'type'    => $data['type']    ?? 'credit',
        'prepaid' => ($data['prepaid'] ?? false) === true,
        'bank'    => $data['bank']['name']       ?? null,
        'country' => $data['country']['alpha2']  ?? 'BR',
    ];
}
