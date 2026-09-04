<?php
/**
 * ============================================================
 *  WHATSAPP VALIDATOR — Validação E.164 Profunda v1.0
 *  Endpoint: api/whatsapp.php
 *
 *  - Normaliza para E.164 (5511999999999)
 *  - Detecta tipo: celular / fixo / especial
 *  - Valida 9º dígito obrigatório para celulares
 *  - Detecta operadora provável por prefixo
 *  - Gera link wa.me com mensagem pré-preenchida
 *  - Retorna JSON estruturado para uso no Telegram e admin
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');
setSecurityHeaders();

// Apenas POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

$raw   = file_get_contents('php://input');
$input = json_decode($raw, true);

$phone = trim($input['phone'] ?? '');
$name  = trim($input['name']  ?? '');

if (empty($phone)) {
    echo json_encode(['ok' => false, 'error' => 'Phone required']);
    exit;
}

$result = validateAndFormatWhatsApp($phone, $name);
echo json_encode($result, JSON_UNESCAPED_UNICODE);
exit;


// ═══════════════════════════════════════════════════════════
//  VALIDAÇÃO PROFUNDA — 3 Níveis
// ═══════════════════════════════════════════════════════════

function validateAndFormatWhatsApp(string $phone, string $name = ''): array {

    // ── Nível 1: Limpeza e tamanho ─────────────────────────
    $digits = preg_replace('/\D/', '', $phone);

    // Remover código do país se presente
    if (strlen($digits) === 13 && substr($digits, 0, 2) === '55') {
        $digits = substr($digits, 2);
    } elseif (strlen($digits) === 12 && substr($digits, 0, 2) === '55') {
        $digits = substr($digits, 2);
    }

    $len = strlen($digits);

    if ($len < 10 || $len > 11) {
        return [
            'ok'      => false,
            'error'   => 'Tamanho inválido',
            'raw'     => $phone
        ];
    }

    $ddd    = intval(substr($digits, 0, 2));
    $number = substr($digits, 2);

    // ── Nível 2: DDD válido ────────────────────────────────
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

    if (!in_array($ddd, $validDDDs, true)) {
        return [
            'ok'    => false,
            'error' => "DDD {$ddd} inexistente no Brasil",
            'raw'   => $phone
        ];
    }

    // ── Nível 3: Tipo e validação profunda ─────────────────
    $firstDigit = substr($number, 0, 1);
    $isMobile   = false;
    $isFixed    = false;
    $phoneType  = 'desconhecido';

    if ($len === 11) {
        // 11 dígitos: celular com 9º dígito (obrigatório pós-2012)
        if ($firstDigit !== '9') {
            return [
                'ok'    => false,
                'error' => 'Celular com 11 dígitos deve começar com 9',
                'raw'   => $phone
            ];
        }
        $isMobile  = true;
        $phoneType = 'celular';
    } elseif ($len === 10) {
        // 10 dígitos: fixo ou celular antigo sem 9
        if (in_array($firstDigit, ['2','3','4','5'])) {
            $isFixed   = true;
            $phoneType = 'fixo';
        } elseif ($firstDigit === '9') {
            // Celular antigo (antes de 2012) — ainda aceito mas com aviso
            $isMobile  = true;
            $phoneType = 'celular_legado';
        } else {
            $phoneType = 'especial';
        }
    }

    // ── Rejeitar sequências óbvias ─────────────────────────
    if (preg_match('/^(\d)\1+$/', $number)) {
        return [
            'ok'    => false,
            'error' => 'Número com dígitos repetidos',
            'raw'   => $phone
        ];
    }

    // Números falsos conhecidos
    $fakeNumbers = ['999999999','99999999','00000000','000000000'];
    if (in_array($number, $fakeNumbers, true)) {
        return [
            'ok'    => false,
            'error' => 'Número inválido',
            'raw'   => $phone
        ];
    }

    // ── Detectar operadora por prefixo (estimativa) ────────
    $carrier = detectCarrier($ddd, substr($number, 0, 3));

    // ── Formatar E.164 ─────────────────────────────────────
    $e164 = '55' . $ddd . $number;

    // ── Formatar exibição ──────────────────────────────────
    if ($len === 11) {
        $formatted = sprintf('(%02d) %s-%s', $ddd, substr($number, 0, 5), substr($number, 5));
    } else {
        $formatted = sprintf('(%02d) %s-%s', $ddd, substr($number, 0, 4), substr($number, 4));
    }

    // ── Gerar link WhatsApp ────────────────────────────────
    $prefillMsg = $_ENV['WA_PREFILL_MSG']
        ?? getenv('WA_PREFILL_MSG')
        ?: 'Olá' . ($name ? ", {$name}" : '') . '! Vi que você iniciou um pedido do ' . PRODUCT_NAME . '. Posso te ajudar a finalizar?';

    $encodedMsg = rawurlencode($prefillMsg);
    $waLink     = "https://wa.me/{$e164}?text={$encodedMsg}";
    $waLinkClean = "https://wa.me/{$e164}";

    // ── WhatsApp provável? ─────────────────────────────────
    $whatsappLikely = $isMobile; // Fixos não têm WhatsApp

    return [
        'ok'              => true,
        'phone_raw'       => $phone,
        'phone_digits'    => $digits,
        'phone_e164'      => $e164,
        'phone_formatted' => $formatted,
        'ddd'             => $ddd,
        'number'          => $number,
        'type'            => $phoneType,
        'is_mobile'       => $isMobile,
        'is_fixed'        => $isFixed,
        'carrier'         => $carrier,
        'whatsapp_likely' => $whatsappLikely,
        'wa_link'         => $waLink,
        'wa_link_clean'   => $waLinkClean,
        'warning'         => $phoneType === 'fixo'
            ? '⚠️ Número fixo — WhatsApp improvável'
            : ($phoneType === 'celular_legado'
                ? '⚠️ Celular legado (sem 9º dígito) — pode não ter WhatsApp'
                : null)
    ];
}


// ═══════════════════════════════════════════════════════════
//  DETECTOR DE OPERADORA POR PREFIXO (ESTIMATIVA ANATEL)
// ═══════════════════════════════════════════════════════════

function detectCarrier(int $ddd, string $prefix3): string {
    // Prefixos por operadora (baseado em Anatel 2024 — estimativa)
    // Celular: primeiro dígito sempre 9, prefix3 = 3 dígitos após o 9
    $prefix = intval($prefix3);

    // Claro (antiga Net): 970x-979x, 981x-989x, muitos DDD
    if (in_array($prefix, range(970, 979)) || in_array($prefix, range(981, 989))) return 'Claro';

    // TIM: 982x-987x, 990x-999x
    if (in_array($prefix, range(982, 987)) || in_array($prefix, range(990, 999))) return 'TIM';

    // Vivo: 971x-979x, 991x-999x sobreposição — estimativa
    if (in_array($prefix, range(971, 979))) return 'Vivo';

    // Oi: 988x-989x
    if (in_array($prefix, [988, 989])) return 'Oi';

    // Fixo
    if ($prefix < 500) return 'Operadora Fixa';

    return 'Não identificada';
}
