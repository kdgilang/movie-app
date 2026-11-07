/**
 * Minimal webOS service bridge (PalmServiceBridge) for packaged TV apps.
 */
(function (window) {
  var webOS = window.webOS || {};
  webOS.service = {
    request: function (uri, options) {
      options = options || {};
      var method = options.method || "";
      var url = uri || "";
      if (url.indexOf("luna://") !== 0 && url.indexOf("palm://") !== 0) {
        url = "luna://" + url.replace(/^\/+/, "");
      }
      if (url.charAt(url.length - 1) !== "/") url += "/";
      url += method;
      var params = JSON.stringify(options.parameters || {});
      if (window.PalmServiceBridge) {
        var bridge = new window.PalmServiceBridge();
        bridge.onservicecallback = function (msg) {
          var data;
          try {
            data = JSON.parse(msg);
          } catch (e) {
            data = { returnValue: false, errorText: String(msg) };
          }
          if (data.errorCode || data.returnValue === false) {
            if (options.onFailure) options.onFailure(data);
          } else if (options.onSuccess) {
            options.onSuccess(data);
          }
        };
        try {
          bridge.call(url, params);
        } catch (e) {
          if (options.onFailure) {
            options.onFailure({ errorText: String(e && e.message ? e.message : e) });
          }
        }
        return {
          cancel: function () {
            try {
              bridge.cancel();
            } catch (e2) {}
          },
        };
      }
      if (options.onFailure) {
        options.onFailure({ errorText: "PalmServiceBridge unavailable" });
      }
      return { cancel: function () {} };
    },
  };
  window.webOS = webOS;
})(window);
