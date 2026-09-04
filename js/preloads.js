
    (function() {
      var baseURL = "https://cdn.shopify.com/shopifycloud/checkout-web/assets/";
      var scripts = ["https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/polyfills.tJpytseg.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/app.DksX3NGu.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/VaultedContact.Di-ElD1E.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/DeliveryMethodSelectorSection.B79tNrhd.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/useAmazonContact.BvVcEF4Z.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/useUnauthenticatedErrorModal.CNjBXSjF.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/VaultedDeliveryAddress.BDcf2gsO.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/Rollup.BXF75U0Z.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/MarketsProDisclaimer.Bj4R7V9t.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/ShopPayLogo.CB3gFpbT.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/index.nFRN4WWH.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/PickupPointCarrierLogo.l0Zo3Q8N.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/hooks.QgkV4jcU.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/LocalizationExtensionField.L3aCRZXC.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/useShowShopPayOptin.OWioM5fD.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/useShopPayRequiresVerification.BChC9i56.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/Section.BQqTBslg.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/useGooglePaySdk.BWKP2KsB.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/PayButtonSection.CQvlR6zD.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/RageClickCapture.CeVwNuzi.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/LegacyVaultedShippingMethods.BwlYIsGE.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/index.CuAxx3-r.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/DutyOptions.DUlMH5LP.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/SubscriptionPriceBreakdown.DFz7Dbm8.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/StockProblemsLineItemList.nDjRQ7nb.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/component-ShopPayVerificationSwitch.CAGxR_yB.js","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/index.s1-1cBA4.js"];
      var styles = ["https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/app.Li7g7W1D.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/VaultedContact.BsDM6oHQ.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/DeliveryMethodSelectorSection.DNerkzQV.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/useAmazonContact.D-Ox6Dnf.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/Rollup.o9Mx-fKL.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/ShopPayLogo.D_HPU8Dh.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/PickupPointCarrierLogo.C0wRU6wV.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/LocalizationExtensionField.BO3829nT.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/Section.BzDw6wmZ.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/PayButtonSection.DF7trkKf.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/RageClickCapture.DnkQ4tsk.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/DutyOptions.Bd1Z60K2.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/SubscriptionPriceBreakdown.Bqs0s4oM.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/StockProblemsLineItemList.CxdIQKjw.css","https://cdn.shopify.com/shopifycloud/checkout-web/assets/c1.en/assets/ShopPayVerificationSwitch.DVQdwG9J.css"];
      var fontPreconnectUrls = [];
      var fontPrefetchUrls = [];
      var imgPrefetchUrls = [];

      function preconnect(url, callback) {
        var link = document.createElement('link');
        link.rel = 'dns-prefetch preconnect';
        link.href = url;
        link.crossOrigin = '';
        link.onload = link.onerror = callback;
        document.head.appendChild(link);
      }

      function preconnectAssets() {
        var resources = [baseURL].concat(fontPreconnectUrls);
        var index = 0;
        (function next() {
          var res = resources[index++];
          if (res) preconnect(res, next);
        })();
      }

      function prefetch(url, as, callback) {
        var link = document.createElement('link');
        if (link.relList.supports('prefetch')) {
          link.rel = 'prefetch';
          link.fetchPriority = 'low';
          link.as = as;
          if (as === 'font') link.type = 'font/woff2';
          link.href = url;
          link.crossOrigin = '';
          link.onload = link.onerror = callback;
          document.head.appendChild(link);
        } else {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.onloadend = callback;
          xhr.send();
        }
      }

      function prefetchAssets() {
        var resources = [].concat(
          scripts.map(function(url) { return [url, 'script']; }),
          styles.map(function(url) { return [url, 'style']; }),
          fontPrefetchUrls.map(function(url) { return [url, 'font']; }),
          imgPrefetchUrls.map(function(url) { return [url, 'image']; })
        );
        var index = 0;
        function run() {
          var res = resources[index++];
          if (res) prefetch(res[0], res[1], next);
        }
        var next = (self.requestIdleCallback || setTimeout).bind(self, run);
        next();
      }

      function onLoaded() {
        try {
          if (parseFloat(navigator.connection.effectiveType) > 2 && !navigator.connection.saveData) {
            preconnectAssets();
            prefetchAssets();
          }
        } catch (e) {}
      }

      if (document.readyState === 'complete') {
        onLoaded();
      } else {
        addEventListener('load', onLoaded);
      }
    })();
  