<?php
/**
 * ============================================================
 *  SESSION MANAGER — Gerenciador de Sessão Criptografada
 *  Gera token de sessão e chave compartilhada
 * ============================================================
 */

require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
setSecurityHeaders();

session_start();

// Gerar sessão
$sessionId = bin2hex(random_bytes(16));
$sessionKey = base64_encode(random_bytes(32)); // AES-256 key

$_SESSION['sid'] = $sessionId;
$_SESSION['key'] = $sessionKey;
$_SESSION['created'] = time();
$_SESSION['ip'] = $_SERVER['REMOTE_ADDR'] ?? 'unknown';

echo json_encode([
    'status' => 'ok',
    'sid' => $sessionId,
    'ts' => time()
]);
