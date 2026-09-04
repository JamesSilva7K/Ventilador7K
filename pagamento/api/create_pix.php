<?php
/**
 * ============================================================
 *  CREATE PIX — Integre com a API de Pagamento (UniaoPay / Mercado Pago)
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET');
setSecurityHeaders();

// Dados do produto
$price = PRODUCT_PRICE;
$productName = PRODUCT_NAME;

// Tentar enviar requisição para a API de pagamento
$apiUrl = PAYMENT_API_URL;
$apiKey = PAYMENT_API_KEY;

// Payload para a API de pagamento
$postData = [
    'amount' => $price,
    'currency' => 'BRL',
    'payment_method' => 'pix',
    'description' => $productName,
    'api_key' => $apiKey
];

$ch = curl_init($apiUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($postData),
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: application/json',
        'Authorization: Bearer ' . $apiKey
    ],
    CURLOPT_TIMEOUT => 8,
    CURLOPT_SSL_VERIFYPEER => false
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$resData = json_decode($response, true);

// Se a API de pagamento retornar o PIX dinâmico
if ($httpCode >= 200 && $httpCode < 300 && (!empty($resData['qr_code']) || !empty($resData['pix_code']) || !empty($resData['point_of_interaction']))) {
    $pixCode = $resData['qr_code'] ?? $resData['pix_code'] ?? $resData['point_of_interaction']['transaction_data']['qr_code'] ?? null;
    $qrBase64 = $resData['qr_code_base64'] ?? $resData['point_of_interaction']['transaction_data']['qr_code_base64'] ?? null;

    if ($pixCode) {
        echo json_encode([
            'status' => 'success',
            'source' => 'payment_api',
            'pix_copia_cola' => $pixCode,
            'qr_code_base64' => $qrBase64,
            'transaction_id' => $resData['id'] ?? $resData['transaction_id'] ?? null
        ]);
        exit;
    }
}

// Fallback: Gerar BRCode EMV padrão para a CHAVE_PIX configurada em config.php
$brCode = generatePixBRCode(PIX_KEY, PIX_RECEIVER_NAME, 'SAO PAULO', $price);

echo json_encode([
    'status' => 'success',
    'source' => 'emv_brcode',
    'pix_copia_cola' => $brCode,
    'qr_code_base64' => null,
    'transaction_id' => 'TXN-' . time()
]);
