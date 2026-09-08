const SITE_NAME = "News";
const DEFAULT_DESCRIPTION = "Read a summary of the latest contents";
const DATABASE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const ARTICLE_SLUG_PATTERN = /^(?=.{1,120}$)(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_LIMIT = 12;
const MAX_BODY_CHARACTERS = 500_000;
const MAX_CACHE_ENTRIES = 50;
const MAX_CACHE_BYTES = 4_000_000;
const MAX_CACHE_ENTRY_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;

const appElement = document.querySelector("#app");
const mainElement = document.querySelector("#main-content");
const databaseSelect = document.querySelector("#database-select");
const routeStatus = document.querySelector("#route-status");
const copyright = document.querySelector("#copyright");

if (
  !(appElement instanceof HTMLElement) ||
  !(mainElement instanceof HTMLElement) ||
  !(databaseSelect instanceof HTMLSelectElement) ||
  !(routeStatus instanceof HTMLElement)
) {
  throw new Error("Newsgo could not find its required page elements");
}

if (copyright instanceof HTMLElement) {
  copyright.textContent = `\u00a9 ${new Date().getFullYear()} Newsgo`;
}

class ApiError extends Error {
  constructor(status, code, message, requestId) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

class RevalidationCache {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Refresh insertion order so frequently visited articles remain available.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key, entry) {
    const previous = this.entries.get(key);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(key);

    if (entry.bytes > this.maxBytes) return;
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;

    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(key);
  }
}

const responseCache = new RevalidationCache(MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
const apiBase = new URL("/", window.location.origin);
const siteBase = resolveSiteBase();
let activeController;
let renderGeneration = 0;
let hasRendered = false;
let defaultDatabaseName;

function resolveSiteBase() {
  const configured = document
    .querySelector('meta[name="newsgo-site-url"]')
    ?.getAttribute("content")
    ?.trim();
  try {
    const candidate = new URL(configured || window.location.origin);
    if (
      (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
      candidate.username ||
      candidate.password
    ) {
      throw new TypeError("Unsupported public site protocol");
    }
    candidate.hash = "";
    candidate.search = "";
    candidate.pathname = "/";
    return candidate;
  } catch {
    return new URL("/", window.location.origin);
  }
}

function apiUrl(path) {
  return new URL(path.replace(/^\/+/, ""), apiBase);
}

async function responseTextWithinLimit(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try {
      await response.body?.cancel("declared response exceeds browser safety limit");
    } catch {
      // Preserve the stable application error even if the stream is already closed.
    }
    throw new ApiError(502, "response_too_large", "The news service response is too large..");
  }

  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("response exceeds browser safety limit");
        throw new ApiError(502, "response_too_large", "The news service response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), bytes: totalBytes };
}

async function apiGet(path, signal, options = {}) {
  const url = apiUrl(path);
  const fresh = options.fresh === true;
  const cached = fresh ? undefined : responseCache.get(url.href);
  const headers = new Headers({ Accept: "application/json" });
  if (cached?.etag) headers.set("If-None-Match", cached.etag);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal,
      cache: "no-store",
      // The public edge gateway injects its own origin credential. Browser
      // cookies or HTTP credentials would make this response private and
      // intentionally bypass the shared edge cache.
      credentials: "omit",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Unable to connect to the content service.");
  }

  if (response.status === 304 && cached) return cached.payload;

  let payload;
  let responseBytes = 0;
  try {
    const decoded = await responseTextWithinLimit(response, MAX_RESPONSE_BYTES);
    responseBytes = decoded.bytes;
    payload = JSON.parse(decoded.text);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof ApiError) throw error;
    if (!response.ok) {
      throw new ApiError(response.status, "http_error", "The news service sent an invalid response.");
    }
    throw new ApiError(502, "invalid_response", "The data format from the news service is invalid.");
  }

  if (!response.ok) {
    const apiMessage =
      payload && typeof payload === "object" && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : "The news request could not be processed.";
    const apiCode =
      payload && typeof payload === "object" && payload.error && typeof payload.error.code === "string"
        ? payload.error.code
        : "http_error";
    const requestId =
      response.headers.get("x-request-id") ||
      (payload && typeof payload === "object" && typeof payload.requestId === "string"
        ? payload.requestId
        : undefined);
    throw new ApiError(response.status, apiCode, apiMessage, requestId);
  }

  const cacheControl = response.headers.get("cache-control")?.toLowerCase() || "";
  const etag = response.headers.get("etag");
  if (
    !fresh &&
    etag &&
    responseBytes <= MAX_CACHE_ENTRY_BYTES &&
    !cacheControl.includes("no-store") &&
    !cacheControl.includes("private")
  ) {
    responseCache.set(url.href, { bytes: responseBytes, etag, payload });
  } else {
    responseCache.delete(url.href);
  }

  return payload;
}

function element(tagName, options = {}, ...children) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);

  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }

  for (const child of children.flat()) {
    if (child instanceof Node) node.append(child);
    else if (child !== undefined && child !== null) node.append(document.createTextNode(String(child)));
  }
  return node;
}

function safeString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isValidDatabaseName(value) {
  return typeof value === "string" && DATABASE_NAME_PATTERN.test(value);
}

function isValidArticleSlug(value) {
  return typeof value === "string" && ARTICLE_SLUG_PATTERN.test(value);
}

function parseRoute() {
  const url = new URL(window.location.href);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/") {
    const database = url.searchParams.get("db");
    return {
      kind: "home",
      database: database && isValidDatabaseName(database) ? database : undefined,
      invalidDatabase: Boolean(database && !isValidDatabaseName(database)),
    };
  }

  const match = pathname.match(/^\/([^/]+)\/([^/]+)$/);
  if (match) {
    let database;
    let slug;
    try {
      database = decodeURIComponent(match[1]);
      slug = decodeURIComponent(match[2]);
    } catch {
      return { kind: "not-found" };
    }
    if (!isValidDatabaseName(database) || !isValidArticleSlug(slug)) {
      return { kind: "not-found" };
    }
    return { kind: "article", database, slug };
  }

  return { kind: "not-found" };
}

function homePath(database) {
  if (!database) return "/";
  const params = new URLSearchParams({ db: database });
  return `/?${params.toString()}`;
}

function articlePath(database, slug) {
  return `/${encodeURIComponent(database)}/${encodeURIComponent(slug)}`;
}

function navigate(path, options = {}) {
  const target = new URL(path, window.location.href);
  if (target.origin !== window.location.origin) return;
  if (options.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  void renderRoute({ focus: options.focus !== false });
}

function announce(message) {
  routeStatus.textContent = "";
  window.requestAnimationFrame(() => {
    routeStatus.textContent = message;
  });
}

function setBusy(isBusy) {
  appElement.setAttribute("aria-busy", String(isBusy));
}

function showLoading(message = "Waiting Content\u2026") {
  const spinner = element("span", { className: "spinner", attributes: { "aria-hidden": "true" } });
  const card = element(
    "section",
    { className: "loading-card", attributes: { "aria-label": "Loading content" } },
    spinner,
    element("p", { text: message }),
  );
  appElement.replaceChildren(card);
}

function setSelectorLoading(selectedDatabase) {
  const option = element("option", {
    text: selectedDatabase || "Loading content\u2026",
    attributes: { value: selectedDatabase || "" },
  });
  databaseSelect.replaceChildren(option);
  databaseSelect.disabled = true;
}

function normalizeDatabases(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new ApiError(502, "invalid_response", "The content source list is invalid.");
  }

  const seen = new Set();
  const databases = [];
  for (const item of payload.data) {
    const name = typeof item === "string" ? item : item && typeof item === "object" ? item.name : undefined;
    if (!isValidDatabaseName(name) || seen.has(name)) continue;
    seen.add(name);
    databases.push({
      name,
      articleCount:
        item && typeof item === "object" && Number.isSafeInteger(item.articleCount)
          ? item.articleCount
          : undefined,
    });
  }
  return databases;
}

async function loadDatabases(signal) {
  return normalizeDatabases(await apiGet("v1/databases", signal));
}

function populateDatabaseSelect(databases, selectedDatabase) {
  if (databases.length === 0) {
    databaseSelect.replaceChildren(element("option", { text: "There are no sources yet.", attributes: { value: "" } }));
    databaseSelect.disabled = true;
    return;
  }

  databaseSelect.replaceChildren(
    ...databases.map((database) => {
      const count =
        database.articleCount === undefined
          ? ""
          : ` (${new Intl.NumberFormat("en-US").format(database.articleCount)})`;
      return element("option", {
        text: `${database.name}${count}`,
        attributes: { value: database.name },
      });
    }),
  );
  if (selectedDatabase && databases.some((database) => database.name === selectedDatabase)) {
    databaseSelect.value = selectedDatabase;
  }
  databaseSelect.disabled = false;
}

function articleImage(article, bodyContents = "") {
  for (const candidate of [
    article.image_url,
    article.imageUrl,
    article.featured_image,
    article.featuredImage,
    article.thumbnail,
    article.image,
  ]) {
    if (typeof candidate !== "string") continue;
    const safe = safeImageUrl(candidate);
    if (safe) return safe;
  }
  return bodyContents ? extractArticleContent(bodyContents).image : undefined;
}

function normalizeArticles(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new ApiError(502, "invalid_response", "Invalid content list.");
  }

  return payload.data
    .map((article) => {
      if (!article || typeof article !== "object") return undefined;
      const id =
        typeof article.id === "number" && Number.isSafeInteger(article.id) && article.id > 0
          ? article.id
          : undefined;
      const slug = isValidArticleSlug(article.slug) ? article.slug : undefined;
      if (id === undefined || slug === undefined) return undefined;
      const bodyContents = typeof article.body_contents === "string" ? article.body_contents : "";
      return {
        id,
        slug,
        title: safeString(article.title, 400) || "Untitled news item",
        keyword: safeString(article.keyword, 160),
        datePublished: article.date_published,
        image: articleImage(article, bodyContents),
      };
    })
    .filter(Boolean);
}

function normalizeArticle(payload, expectedSlug) {
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object") {
    throw new ApiError(502, "invalid_response", "Content details are invalid.");
  }

  const article = payload.data;
  const id =
    typeof article.id === "number" && Number.isSafeInteger(article.id) && article.id > 0
      ? article.id
      : undefined;
  const slug = isValidArticleSlug(article.slug) ? article.slug : undefined;
  if (id === undefined || slug === undefined || slug !== expectedSlug) {
    throw new ApiError(502, "invalid_response", "The content identity does not match.");
  }

  const bodyContents = typeof article.body_contents === "string" ? article.body_contents : "";

  return {
    id,
    slug,
    title: safeString(article.title, 500) || "Untitled news item",
    keyword: safeString(article.keyword, 200),
    datePublished: article.date_published,
    bodyContents,
    image: articleImage(article, bodyContents),
    backlinks: Array.isArray(payload.backlinks) ? payload.backlinks : [],
  };
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return undefined;
  let candidate = value;
  if (typeof candidate === "string" && /^\d{10,13}$/.test(candidate.trim())) {
    candidate = Number(candidate.trim());
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    candidate = candidate < 10_000_000_000 ? candidate * 1000 : candidate;
  }

  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function dateView(value) {
  const date = normalizeDate(value);
  if (!date) return { label: "Date not available" };
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date),
  };
}

function unwrapJsonContent(rawValue) {
  let value = rawValue;
  if (typeof value === "string" && value.length <= MAX_BODY_CHARACTERS) {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = rawValue;
      }
    }
  }

  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join("\n\n");
  }
  if (value && typeof value === "object") {
    for (const key of ["body_contents", "content", "sentences", "text"]) {
      if (typeof value[key] === "string") return value[key];
      if (Array.isArray(value[key])) {
        return value[key].filter((entry) => typeof entry === "string").join("\n\n");
      }
    }
  }
  return typeof value === "string" ? value : "";
}

function safeImageUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function extractArticleContent(rawValue) {
  const unwrapped = unwrapJsonContent(rawValue);
  const truncated = unwrapped.length > MAX_BODY_CHARACTERS;
  const source = unwrapped.slice(0, MAX_BODY_CHARACTERS);
  let image;
  let text = source;

  if (/<[a-z][\s\S]*>/i.test(source)) {
    const parsed = new DOMParser().parseFromString(source, "text/html");
    parsed.querySelectorAll("script,style,template,noscript,iframe,object,embed").forEach((node) => node.remove());
    image = safeImageUrl(parsed.querySelector("img[src]")?.getAttribute("src"));
    parsed.querySelectorAll("br").forEach((node) => node.replaceWith(parsed.createTextNode("\n")));

    const blocks = [...parsed.body.querySelectorAll("p,li,blockquote,h1,h2,h3,h4")]
      .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
      .filter(Boolean);
    text = blocks.length > 0 ? blocks.join("\n\n") : parsed.body.textContent || "";
  }

  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5_000);

  return { paragraphs, plainText: paragraphs.join(" "), image, truncated };
}

function descriptionFrom(text, fallback) {
  const normalized = safeString(text, 1_000) || safeString(fallback, 1_000) || DEFAULT_DESCRIPTION;
  if (normalized.length <= 155) return normalized;
  const shortened = normalized.slice(0, 152);
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, wordBoundary > 100 ? wordBoundary : 152).trim()}\u2026`;
}

function absoluteSiteUrl(path) {
  return new URL(path, siteBase).href;
}

function setMeta(selector, attribute, value) {
  let node = document.head.querySelector(selector);
  if (!(node instanceof HTMLMetaElement)) {
    node = document.createElement("meta");
    const selectorMatch = selector.match(/^meta\[(name|property)="([^"]+)"\]$/);
    if (selectorMatch) node.setAttribute(selectorMatch[1], selectorMatch[2]);
    document.head.append(node);
  }
  node.setAttribute(attribute, value);
}

function updateSeo({
  title,
  description,
  canonical,
  type = "website",
  image,
  robots = "index,follow,max-image-preview:large",
  publishedAt,
  jsonLd,
}) {
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
  const fallbackImage = absoluteSiteUrl("/favicon.ico");
  const socialImage = image || fallbackImage;

  document.title = fullTitle;
  setMeta('meta[name="description"]', "content", description);
  setMeta('meta[name="robots"]', "content", robots);
  setMeta('meta[property="og:type"]', "content", type);
  setMeta('meta[property="og:site_name"]', "content", SITE_NAME);
  setMeta('meta[property="og:locale"]', "content", "id_ID");
  setMeta('meta[property="og:title"]', "content", fullTitle);
  setMeta('meta[property="og:description"]', "content", description);
  setMeta('meta[property="og:url"]', "content", canonical);
  setMeta('meta[property="og:image"]', "content", socialImage);
  setMeta('meta[name="twitter:card"]', "content", image ? "summary_large_image" : "summary");
  setMeta('meta[name="twitter:title"]', "content", fullTitle);
  setMeta('meta[name="twitter:description"]', "content", description);
  setMeta('meta[name="twitter:image"]', "content", socialImage);

  const publishedMeta = document.head.querySelector('meta[property="article:published_time"]');
  const modifiedMeta = document.head.querySelector('meta[property="article:modified_time"]');
  if (type === "article" && publishedAt) {
    setMeta('meta[property="article:published_time"]', "content", publishedAt);
    setMeta('meta[property="article:modified_time"]', "content", publishedAt);
  } else {
    publishedMeta?.remove();
    modifiedMeta?.remove();
  }

  let canonicalLink = document.head.querySelector('link[rel="canonical"]');
  if (!(canonicalLink instanceof HTMLLinkElement)) {
    canonicalLink = document.createElement("link");
    canonicalLink.rel = "canonical";
    document.head.append(canonicalLink);
  }
  canonicalLink.href = canonical;

  let jsonLdElement = document.querySelector("#newsgo-jsonld");
  if (!(jsonLdElement instanceof HTMLScriptElement)) {
    jsonLdElement = document.createElement("script");
    jsonLdElement.id = "newsgo-jsonld";
    jsonLdElement.type = "application/ld+json";
    document.head.append(jsonLdElement);
  }
  jsonLdElement.textContent = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
}

function updateHomeSeo(
  database,
  articles = [],
  defaultDatabase = defaultDatabaseName,
  robots = "index,follow,max-image-preview:large",
) {
  const canonicalDatabase = database && database !== defaultDatabase ? database : undefined;
  const canonical = absoluteSiteUrl(homePath(canonicalDatabase));
  const title = database ? `News ${database}` : "Latest News";
  const description = database
    ? `Collection of the latest content from the source ${database} di Newsgo.`
    : DEFAULT_DESCRIPTION;
  updateSeo({
    title,
    description,
    canonical,
    robots,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: SITE_NAME, url: absoluteSiteUrl("/"), inLanguage: "en-US" },
        {
          "@type": "CollectionPage",
          name: title,
          description,
          url: canonical,
          inLanguage: "en-US",
          mainEntity: {
            "@type": "ItemList",
            itemListElement: articles.map((article, index) => ({
              "@type": "ListItem",
              position: index + 1,
              url: absoluteSiteUrl(articlePath(database, article.slug)),
              name: article.title,
            })),
          },
        },
      ],
    },
  });
}

function updateArticleSeo(database, article, content) {
  const canonical = absoluteSiteUrl(articlePath(database, article.slug));
  const description = descriptionFrom(content.plainText, `${article.title}. ${article.keyword}`);
  const date = normalizeDate(article.datePublished);
  const image = content.image || article.image;
  const publishedAt = date?.toISOString();
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: article.title,
        description,
        inLanguage: "en-US",
        mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
        url: canonical,
        publisher: { "@type": "Organization", name: SITE_NAME, url: absoluteSiteUrl("/") },
        ...(article.keyword ? { articleSection: article.keyword, keywords: article.keyword } : {}),
        ...(publishedAt ? { datePublished: publishedAt, dateModified: publishedAt } : {}),
        ...(image ? { image: [image] } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Beranda",
            item: absoluteSiteUrl(
              homePath(database === defaultDatabaseName ? undefined : database),
            ),
          },
          { "@type": "ListItem", position: 2, name: article.title, item: canonical },
        ],
      },
    ],
  };
  updateSeo({
    title: article.title,
    description,
    canonical,
    type: "article",
    image,
    publishedAt,
    jsonLd: structuredData,
  });
}

function updateNotFoundSeo(title) {
  const canonical = absoluteSiteUrl(window.location.pathname);
  updateSeo({
    title,
    description: "The page you are looking for was not found on Newsgo.",
    canonical,
    robots: "noindex,follow",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title,
      url: canonical,
    },
  });
}

function createTime(value) {
  const view = dateView(value);
  return element("time", {
    text: view.label,
    attributes: view.dateTime ? { datetime: view.dateTime } : {},
  });
}

function renderEmptyDatabases() {
  updateHomeSeo(undefined, [], defaultDatabaseName, "noindex,follow");
  const card = element(
    "section",
    { className: "state-card" },
    element("p", { className: "eyebrow", text: "Source not yet available." }),
    element("h1", { text: "No content yet" }),
    element("p", { text: "The content database is being prepared. Please try again in a few moments." }),
    element(
      "div",
      { className: "state-actions" },
      element("button", { className: "button", text: "Try again", attributes: { type: "button" } }),
    ),
  );
  card.querySelector("button")?.addEventListener("click", () => void renderRoute());
  appElement.replaceChildren(card);
  announce("No content sources are available yet.");
}

function renderNotFound(title, message) {
  updateNotFoundSeo(title);
  const homeLink = element("a", {
    className: "button",
    text: "Return to the homepage",
    attributes: { href: "/", "data-route": "" },
  });
  const card = element(
    "section",
    { className: "state-card" },
    element("p", { className: "eyebrow", text: "404 \u00b7 Not Found" }),
    element("h1", { text: title }),
    element("p", { text: message }),
    element("div", { className: "state-actions" }, homeLink),
  );
  appElement.replaceChildren(card);
  announce(`${title}. ${message}`);
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Public access to the news service is not yet configured. Please contact the site administrator.";
    }
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
    if (error.status === 503) return "The news service is preparing the database. Please try again in a short while.";
    if (error.status === 0) return error.message;
  }
  return "Content could not be loaded. Please check your connection and try again.";
}

function renderError(error) {
  const message = friendlyError(error);
  updateNotFoundSeo("Content not available");
  const retry = element("button", {
    className: "button",
    text: "Try again",
    attributes: { type: "button" },
  });
  retry.addEventListener("click", () => void renderRoute());
  const requestNote =
    error instanceof ApiError && error.requestId
      ? element("p", { text: `Request Reference: ${safeString(error.requestId, 100)}` })
      : undefined;
  const card = element(
    "section",
    { className: "state-card" },
    element("p", { className: "eyebrow", text: "An issue occurred." }),
    element("h1", { text: "Content not available" }),
    element("p", { text: message }),
    requestNote,
    element("div", { className: "state-actions" }, retry),
  );
  appElement.replaceChildren(card);
  announce(`An issue occurred. ${message}`);
}

function createArticlePicture(database, article, priority = false) {
  const detailHref = articlePath(database, article.slug);
  if (!article.image) {
    return element(
      "div",
      { className: "post-thumbnail post-thumbnail-placeholder", attributes: { "aria-hidden": "true" } },
      element("span", { text: SITE_NAME.slice(0, 1) }),
    );
  }

  return element(
    "figure",
    { className: "post-thumbnail" },
    element(
      "a",
      {
        attributes: {
          href: detailHref,
          "data-route": "",
          "aria-label": `Baca ${article.title}`,
        },
      },
      element("img", {
        attributes: {
          src: article.image,
          alt: article.title,
          width: "1200",
          height: "720",
          decoding: "async",
          loading: priority ? "eager" : "lazy",
          ...(priority ? { fetchpriority: "high" } : {}),
        },
      }),
    ),
  );
}

function createArticleCard(database, article, priority = false) {
  const detailHref = articlePath(database, article.slug);
  const headingLink = element("a", {
    text: article.title,
    attributes: { href: detailHref, "data-route": "" },
  });
  const card = element(
    "article",
    { className: "post-card" },
    element(
      "div",
      { className: "post-card-copy" },
      element("span", {
        className: "category-label",
        text: article.keyword || "News",
      }),
      element("h2", { className: "post-card-title" }, headingLink),
      element("div", { className: "post-meta" }, createTime(article.datePublished)),
    ),
    createArticlePicture(database, article, priority),
  );
  return element("li", {}, card);
}

function createSidebar(database, articles) {
  const links = articles.slice(0, 5).map((article) =>
    element(
      "li",
      { className: "widget-item" },
      element("a", {
        text: article.title,
        attributes: { href: articlePath(database, article.slug), "data-route": "" },
      }),
      createTime(article.datePublished),
    ),
  );

  return element(
    "aside",
    { className: "sidebar", attributes: { "aria-label": "New post" } },
    element(
      "section",
      { className: "widget" },
      element("h2", { className: "widget-title", text: "New post" }),
      element("ol", { className: "widget-list" }, links),
    ),
  );
}

async function loadHomeArticles(database, signal) {
  const base = `v1/databases/${encodeURIComponent(database)}/articles`;
  return apiGet(`${base}/random?limit=${ARTICLE_LIMIT}`, signal, { fresh: true });
}

async function renderHome(route, signal) {
  document.body.dataset.view = "home";
  const databases = await loadDatabases(signal);
  if (databases.length === 0) {
    populateDatabaseSelect([], undefined);
    renderEmptyDatabases();
    return;
  }

  defaultDatabaseName = databases[0].name;

  if (route.invalidDatabase || (route.database && !databases.some((item) => item.name === route.database))) {
    populateDatabaseSelect(databases, databases[0].name);
    renderNotFound("Source not found", "The news source at the specified address is not available.");
    return;
  }

  const database = route.database || databases[0].name;
  populateDatabaseSelect(databases, database);
  updateHomeSeo(database, [], defaultDatabaseName);

  const payload = await loadHomeArticles(database, signal);
  const articles = normalizeArticles(payload);
  updateHomeSeo(database, articles, defaultDatabaseName);

  const refresh = element("button", {
    className: "button secondary",
    text: "Reload news",
    attributes: { type: "button" },
  });
  refresh.addEventListener("click", () => void renderRoute({ focus: false }));

  const hero = element(
    "section",
    { className: "hero", attributes: { "aria-labelledby": "home-title" } },
    element(
      "div",
      {},
      element("p", { className: "eyebrow", text: `Source \u00b7 ${database}` }),
      element("h1", { text: "Latest news, delivered clearly", attributes: { id: "home-title" } }),
      element("p", {
        className: "hero-copy",
        text: "Read the latest news from your preferred source.",
      }),
    ),
    refresh,
  );

  if (articles.length === 0) {
    updateHomeSeo(database, [], defaultDatabaseName, "noindex,follow");
    appElement.replaceChildren(
      hero,
      element(
        "section",
        { className: "state-card" },
        element("h2", { text: "No articles available" }),
        element("p", { text: "This source does not have any articles to display." }),
      ),
    );
    announce(`No articles available for source ${database}.`);
    return;
  }

  const articleList = element(
    "ul",
    { className: "post-list", attributes: { "aria-label": `News from ${database}` } },
    articles.map((article, index) => createArticleCard(database, article, index === 0)),
  );
  const layout = element(
    "div",
    { className: "site-layout" },
    element(
      "section",
      { className: "content-area", attributes: { "aria-label": "News list" } },
      articleList,
    ),
    createSidebar(database, articles),
  );
  appElement.replaceChildren(hero, layout);
  announce(`${articles.length} news articles from source ${database} have been loaded.`);
}

function renderArticleBody(content) {
  const body = element("div", { className: "entry-content article-body" });
  if (content.paragraphs.length === 0) {
    body.append(element("p", { className: "article-notice", text: "The article content is not yet available." }));
    return body;
  }

  for (const paragraph of content.paragraphs) {
    body.append(element("p", { text: paragraph }));
  }
  if (content.truncated) {
    body.append(
      element("p", {
        className: "article-notice",
        text: "Article is very long so some content is not displayed.",
      }),
    );
  }
  return body;
}

function createFeaturedImage(article, content) {
  const source = content.image || article.image;
  if (!source) return undefined;
  return element(
    "figure",
    { className: "featured-image" },
    element("img", {
      attributes: {
        src: source,
        alt: article.title,
        width: "1200",
        height: "720",
        decoding: "async",
        loading: "eager",
        fetchpriority: "high",
      },
    }),
  );
}

async function renderArticle(route, signal) {
  document.body.dataset.view = "article";
  setSelectorLoading(route.database);
  const selectorTask = loadDatabases(signal)
    .then((databases) => {
      defaultDatabaseName = databases[0]?.name;
      populateDatabaseSelect(databases, route.database);
    })
    .catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setSelectorLoading(route.database);
      }
    });

  let article;
  let sidebarArticles = [];
  try {
    const [articlePayload, sidebarPayload] = await Promise.all([
      apiGet(
        `v1/databases/${encodeURIComponent(route.database)}/articles/by-slug/${encodeURIComponent(route.slug)}`,
        signal,
      ),
      apiGet(`v1/databases/${encodeURIComponent(route.database)}/articles/random?limit=5`, signal, { fresh: true }),
    ]);
    article = normalizeArticle(articlePayload, route.slug);
    sidebarArticles = normalizeArticles(sidebarPayload)
      .filter((item) => item.slug !== article.slug)
      .slice(0, 5);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === "database_not_found")) {
      renderNotFound("Article not found", "This article may have been moved or is no longer available.");
      await selectorTask;
      return;
    }
    throw error;
  }

  await selectorTask;
  const content = extractArticleContent(article.bodyContents);
  updateArticleSeo(route.database, article, content);
  const metaChildren = [createTime(article.datePublished)];
  if (article.keyword) metaChildren.unshift(element("span", { className: "tag", text: article.keyword }));
  const header = element(
    "header",
    { className: "entry-header article-header" },
    element("p", { className: "eyebrow", text: `News \u00b7 ${route.database}` }),
    element("h1", { className: "entry-title", text: article.title }),
    element("div", { className: "article-meta" }, metaChildren),
  );
  const articleBody = element(
    "div",
    { className: "inside-article" },
    header,
    createFeaturedImage(article, content),
    renderArticleBody(content),
  );
  const articleAd = element("div", { attributes: { "data-newsgo-ad-slot": "content-bottom" } });
  articleBody.append(articleAd);
  const articleElement = element(
    "article",
    { className: "article-shell single-post" },
    articleBody,
  );

  const sidebarItems = sidebarArticles.length
    ? sidebarArticles.map((item) =>
        element(
          "li",
          { className: "widget-item" },
          element("a", {
            text: item.title,
            attributes: { href: articlePath(route.database, item.slug), "data-route": "" },
          }),
          createTime(item.datePublished),
        ),
      )
    : [
        element(
          "li",
          { className: "widget-item" },
          element("a", {
            text: "More updates coming soon",
            attributes: { href: homePath(route.database === defaultDatabaseName ? undefined : route.database), "data-route": "" },
          }),
        ),
      ];

  const sidebar = element(
    "aside",
    { className: "sidebar article-sidebar" },
    element(
      "div",
      { className: "widget article-widget", attributes: { "aria-label": "Trends post" } },
      element("div", { attributes: { "data-newsgo-ad-slot": "popup" } }),
      element("div", { attributes: { "data-newsgo-ad-slot": "sidebar" } }),
      element("h2", { className: "widget-title", text: "Trends post" }),
      element("ul", { className: "widget-list" }, ...sidebarItems),
    ),
  );

  const articleLayout = element(
    "div",
    { className: "site-layout article-layout" },
    element("section", { className: "content-area" }, articleElement),
    sidebar,
  );
  appElement.replaceChildren(articleLayout);

  const shuffledBacklinks = [...article.backlinks].filter((item) => item && item.url && item.keyword);
  for (let index = shuffledBacklinks.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledBacklinks[index], shuffledBacklinks[swapIndex]] = [shuffledBacklinks[swapIndex], shuffledBacklinks[index]];
  }

  const backlinkItems = [];
  const seenDomains = new Set();
  const seenKeywords = new Set();
  for (const item of shuffledBacklinks) {
    try {
      const domain = new URL(item.url).hostname.replace(/^www\./i, "");
      const keyword = String(item.keyword || "").trim().toLowerCase();
      if (seenDomains.has(domain)) continue;
      if (seenKeywords.has(keyword)) continue;
      seenDomains.add(domain);
      seenKeywords.add(keyword);
      backlinkItems.push(item);
      if (backlinkItems.length >= 5) break;
    } catch {
      const keyword = String(item.keyword || "").trim().toLowerCase();
      if (seenKeywords.has(keyword)) continue;
      seenKeywords.add(keyword);
      backlinkItems.push(item);
      if (backlinkItems.length >= 5) break;
    }
  }

  if (backlinkItems.length) {
    const section = element("aside", { className: "injected-related" }, element("h2", { text: "Related links" }));
    section.append(...backlinkItems.map((item) => element("a", { text: item.keyword, attributes: { href: item.url, rel: "noopener noreferrer" } })));
    articleBody.append(section);
  }

  const apiOrigin = mainElement.getAttribute("data-newsgo-api-origin") || "https://powerhouse.my.id";
  if (window.NewsgoInject && typeof window.NewsgoInject.init === "function") {
    window.NewsgoInject.init({ root: document, apiOrigin, limit: 5, database: route.database, slug: route.slug });
    setTimeout(function () {
      window.NewsgoInject.init({ root: document, apiOrigin, limit: 5, database: route.database, slug: route.slug });
    }, 120);
  }

  announce(`Article ${article.title} has been loaded.`);
}

async function renderRoute(options = {}) {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const generation = ++renderGeneration;
  const route = parseRoute();

  setBusy(true);
  showLoading(route.kind === "article" ? "Loading article\u2026" : "Loading news\u2026");

  try {
    if (route.kind === "not-found") {
      setSelectorLoading();
      renderNotFound("Page not found", "Please check the URL and try again.");
    } else if (route.kind === "article") {
      await renderArticle(route, controller.signal);
    } else {
      setSelectorLoading(route.database);
      await renderHome(route, controller.signal);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    renderError(error);
  } finally {
    if (generation === renderGeneration) {
      setBusy(false);
      if (hasRendered && options.focus !== false) mainElement.focus({ preventScroll: true });
      hasRendered = true;
    }
  }
}

document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = event.target instanceof Element ? event.target.closest("a[data-route]") : null;
  if (!(target instanceof HTMLAnchorElement) || target.target || target.hasAttribute("download")) return;
  const url = new URL(target.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(`${url.pathname}${url.search}${url.hash}`);
});

databaseSelect.addEventListener("change", () => {
  const database = databaseSelect.value;
  if (isValidDatabaseName(database)) {
    navigate(homePath(database === defaultDatabaseName ? undefined : database));
  }
});

window.addEventListener("popstate", () => void renderRoute({ focus: true }));
void renderRoute({ focus: false });
