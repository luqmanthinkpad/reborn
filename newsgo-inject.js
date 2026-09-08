/* Newsgo shared content injectors. Include this file once per page. */
(function (global) {
  "use strict";

  var DEFAULT_API_ORIGIN = "";
  var DEFAULT_LIMIT = 5;
  var AD_DOMAIN = "anguishgrandpa.com";

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength || 300);
  }

  function safeUrl(value, fallbackOrigin) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      var url = new URL(value, fallbackOrigin || location.origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (url.username || url.password) return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function apiUrl(apiOrigin, path) {
    return apiOrigin.replace(/\/$/, "") + path;
  }

  function requestJson(apiOrigin, path) {
    return fetch(apiUrl(apiOrigin, path), {
      credentials: "omit",
      headers: { Accept: "application/json" },
    }).then(function (response) {
      if (!response.ok) throw new Error("Newsgo API returned HTTP " + response.status);
      return response.json();
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function element(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function renderItems(container, items, title, emptyMessage) {
    clear(container);
    if (!items.length) {
      container.appendChild(element("p", "newsgo-inject__empty", emptyMessage));
      return;
    }

    var heading = element("h2", "newsgo-inject__heading", title);
    var list = element("ul", "newsgo-inject__list");
    items.forEach(function (item) {
      var url = safeUrl(item.url, location.origin);
      var label = cleanText(item.keyword || item.title || item.url, 180);
      if (!url || !label) return;
      var listItem = element("li", "newsgo-inject__item");
      var link = element("a", "newsgo-inject__link", label);
      link.href = url;
      link.rel = "noopener noreferrer";
      listItem.appendChild(link);
      list.appendChild(listItem);
    });
    container.append(heading, list);
  }

  function injectAds(root) {
    var nodes = root.querySelectorAll("[data-newsgo-ad]");
    nodes.forEach(function (node) {
      var label = cleanText(node.getAttribute("data-newsgo-ad-label") || "Advertisement", 80);
      var target = safeUrl(node.getAttribute("data-newsgo-ad-url"), location.origin);
      var text = cleanText(node.getAttribute("data-newsgo-ad-text"), 180);
      clear(node);
      node.setAttribute("aria-label", label);
      node.appendChild(element("span", "newsgo-inject__ad-label", label));
      if (target && text) {
        var link = element("a", "newsgo-inject__ad-link", text);
        link.href = target;
        link.rel = "sponsored noopener noreferrer";
        node.appendChild(link);
      }
    });
    return Promise.resolve(nodes.length);
  }

  function injectIframeAd(container, key, width, height) {
    if (!container) return;
    clear(container);
    var iframe = document.createElement("iframe");
    iframe.width = width;
    iframe.height = height;
    iframe.frameBorder = "0";
    iframe.scrolling = "no";
    iframe.style.cssText = "display:block;margin:0 auto;overflow:hidden;border:none;max-width:100%;";
    container.appendChild(iframe);
    var iframeDoc = iframe.contentWindow ? iframe.contentWindow.document : iframe.contentDocument;
    if (iframeDoc) {
      iframeDoc.open();
      iframeDoc.write("<!DOCTYPE html><html><head><style>body{margin:0;padding:0;display:flex;justify-content:center;align-items:center;background:transparent;overflow:hidden;width:" + width + "px;height:" + height + "px;}</style></head><body><script type=\"text/javascript\">window.atOptions={\"key\":\"" + key + "\",\"format\":\"iframe\",\"height\":" + height + ",\"width\":" + width + ",\"params\":{}};</script><script type=\"text/javascript\" src=\"https://" + AD_DOMAIN + "/" + key + "/invoke.js\"></script></body></html>");
      iframeDoc.close();
    }
  }

  function renderAdSlots(root, ads) {
    if (!ads || !Array.isArray(ads) || ads.length === 0) {
      root.querySelectorAll("[data-newsgo-ad-slot]").forEach(function (node) {
        node.setAttribute("data-newsgo-ad-empty", "true");
        node.style.display = "none !important";
      });
      return;
    }
    root.querySelectorAll("[data-newsgo-ad-slot]").forEach(function (node) {
      var placement = node.getAttribute("data-newsgo-ad-slot") || "mini";
      var ad = findAdForPlacement(ads, placement);
      if (!ad) {
        node.setAttribute("data-newsgo-ad-empty", "true");
        node.style.display = "none !important";
        return;
      }
      node.removeAttribute("data-newsgo-ad-empty");
      node.style.display = "block";
      if (ad.type === "script" && ad.key) {
        var width = Number(ad.width) || 320;
        var height = Number(ad.height) || 50;
        clear(node);
        injectIframeAd(node, ad.key, width, height);
        node.setAttribute("data-newsgo-ad-loaded", "true");
      }
    });
  }

  function init(options) {
    options = options || {};
    var root = options.root || document;
    var apiOrigin = options.apiOrigin || root.querySelector("[data-newsgo-api-origin]")?.getAttribute("data-newsgo-api-origin") || DEFAULT_API_ORIGIN;
    var settings = { apiOrigin: apiOrigin, limit: options.limit, endpoint: options.endpoint, database: options.database, slug: options.slug, onError: options.onError };
    var slots = root.querySelectorAll("[data-newsgo-ad-slot]");
    var hasRemote = slots.length > 0;
    var remoteTask = hasRemote
      ? requestJson(apiOrigin, (options.endpoint || "/v1/advertisert") + "?limit=" + (Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), 20)) + (options.database ? "&database=" + encodeURIComponent(options.database) : "") + (options.slug ? "&slug=" + encodeURIComponent(options.slug) : ""))
          .then(function (payload) {
            renderAdSlots(root, Array.isArray(payload.ads) ? payload.ads : []);
            return payload;
          })
          .catch(function (error) { if (settings.onError) settings.onError(error); })
      : Promise.resolve(null);
    return Promise.all([
      injectAds(root),
      remoteTask,
    ]);
  }

  global.NewsgoInject = {
    init: init,
    injectAds: injectAds,
  };

  function autoInit() {
    var root = document.querySelector("[data-newsgo-inject-root]") || document;
    if (!root.querySelector("[data-newsgo-ad-slot], [data-newsgo-ad]")) return;
    var configuredOrigin = global.NEWSGO_API_BASE || (global.NEWSGO_CONFIG && global.NEWSGO_CONFIG.apiBase) || "";
    var apiOrigin = root.getAttribute("data-newsgo-api-origin") || configuredOrigin;
    global.NewsgoInject.init({ apiOrigin: apiOrigin, root: root, limit: root.getAttribute("data-newsgo-limit") || DEFAULT_LIMIT });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoInit);
  else autoInit();
})(window);
