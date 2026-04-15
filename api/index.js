const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PATH_QUERY_KEY = "url";

function json(status, message) {
  return new Response(JSON.stringify({ status, message }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function getForwardedHeader(headers, name, fallback = "") {
  return headers.get(name)?.split(",")[0]?.trim() || fallback;
}

function getRequestOrigin(request) {
  const requestUrl = new URL(request.url);
  const host =
    getForwardedHeader(request.headers, "x-forwarded-host") ||
    request.headers.get("host") ||
    requestUrl.host;
  const protocol =
    getForwardedHeader(
      request.headers,
      "x-forwarded-proto",
      requestUrl.protocol.replace(":", ""),
    ) || "https";

  return { host, protocol };
}

function getProxyBaseUrl(request) {
  const { host, protocol } = getRequestOrigin(request);

  return host ? `${protocol}://${host}` : "";
}

function getProxyPath(url) {
  const rewrittenPath = url.searchParams.get(PATH_QUERY_KEY);

  if (rewrittenPath) {
    return rewrittenPath;
  }

  if (url.pathname.startsWith("/api/")) {
    return url.pathname.slice("/api/".length);
  }

  return "";
}

function buildTargetUrl(url) {
  const encodedPath = getProxyPath(url);

  if (!encodedPath) {
    return null;
  }

  let rawPath;

  try {
    rawPath = decodeURIComponent(encodedPath).replace(
      /^(https?):\/(?!\/)/i,
      "$1://",
    );
  } catch {
    throw Object.assign(new Error("Target URL encoding is invalid."), {
      statusCode: 400,
    });
  }

  let target;

  if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
    try {
      target = new URL(rawPath);
    } catch {
      throw Object.assign(new Error("Target URL is invalid."), {
        statusCode: 400,
      });
    }
  } else {
    const parts = rawPath.split("/");
    const first = (parts[0] || "").replace(/:$/, "").toLowerCase();
    const protocol = first === "http" || first === "https" ? first : "https";
    const hostIndex = protocol === first ? 1 : 0;
    const host = parts[hostIndex] || "";

    if (!host) {
      return null;
    }

    try {
      target = new URL(`${protocol}://${host}`);
      target.pathname = `/${parts.slice(hostIndex + 1).join("/")}`;
    } catch {
      throw Object.assign(new Error("Target URL is invalid."), {
        statusCode: 400,
      });
    }
  }

  for (const [key, value] of url.searchParams.entries()) {
    if (key !== PATH_QUERY_KEY) {
      target.searchParams.append(key, value);
    }
  }

  return target;
}

function buildRequestHeaders(request, targetUrl) {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  headers.set("host", targetUrl.host);
  headers.set("accept-encoding", "identity");

  const forwardedFor = getForwardedHeader(request.headers, "x-forwarded-for");
  const { host: forwardedHost, protocol: forwardedProto } =
    getRequestOrigin(request);

  if (forwardedFor) {
    headers.set("x-forwarded-for", forwardedFor);
  }

  if (forwardedHost) {
    headers.set("x-forwarded-host", forwardedHost);
  }

  headers.set("x-forwarded-proto", forwardedProto);

  return headers;
}

function toProxyUrl(value, request, targetUrl) {
  if (!value) {
    return value;
  }

  const trimmed = value.trim();

  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return value;
  }

  const proxyBaseUrl = getProxyBaseUrl(request);

  if (!proxyBaseUrl) {
    return value;
  }

  try {
    const absolute = trimmed.startsWith("//")
      ? new URL(`${targetUrl.protocol}${trimmed}`)
      : new URL(trimmed, targetUrl);

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return value;
    }

    return new URL(`/${absolute.toString()}`, proxyBaseUrl).toString();
  } catch {
    return value;
  }
}

function rewriteLocationHeader(location, request, targetUrl) {
  return toProxyUrl(location, request, targetUrl);
}

function rewriteSrcset(value, request, targetUrl) {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();

      if (!trimmed) {
        return trimmed;
      }

      const firstSpace = trimmed.search(/\s/);

      if (firstSpace === -1) {
        return toProxyUrl(trimmed, request, targetUrl);
      }

      const urlPart = trimmed.slice(0, firstSpace);
      const descriptor = trimmed.slice(firstSpace);

      return `${toProxyUrl(urlPart, request, targetUrl)}${descriptor}`;
    })
    .join(", ");
}

function rewriteHtml(html, request, targetUrl) {
  return html
    .replace(
      /\b(href|src|action|poster)=("([^"]*)"|'([^']*)')/gi,
      (match, attr, quoted, doubleValue, singleValue) => {
        const original = doubleValue ?? singleValue ?? "";
        const rewritten = toProxyUrl(original, request, targetUrl);
        const quote = quoted[0];
        return `${attr}=${quote}${rewritten}${quote}`;
      },
    )
    .replace(
      /\bsrcset=("([^"]*)"|'([^']*)')/gi,
      (match, quoted, doubleValue, singleValue) => {
        const original = doubleValue ?? singleValue ?? "";
        const rewritten = rewriteSrcset(original, request, targetUrl);
        const quote = quoted[0];
        return `srcset=${quote}${rewritten}${quote}`;
      },
    )
    .replace(
      /\bcontent=("([^"]*)"|'([^']*)')/gi,
      (match, quoted, doubleValue, singleValue) => {
        const original = doubleValue ?? singleValue ?? "";
        const rewritten = original.replace(
          /(\s*;\s*url=)([^;]+)/i,
          (full, prefix, target) =>
            `${prefix}${toProxyUrl(target, request, targetUrl)}`,
        );

        if (rewritten === original) {
          return match;
        }

        const quote = quoted[0];
        return `content=${quote}${rewritten}${quote}`;
      },
    );
}

function buildResponseHeaders(upstream, request, targetUrl) {
  const headers = new Headers({
    "cache-control": "no-store",
  });

  if (typeof upstream.headers.getSetCookie === "function") {
    for (const cookie of upstream.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
  }

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();

    if (lower === "set-cookie" || HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) {
      return;
    }

    if (
      lower === "content-security-policy" ||
      lower === "content-security-policy-report-only"
    ) {
      return;
    }

    if (lower === "location") {
      headers.set(key, rewriteLocationHeader(value, request, targetUrl));
      return;
    }

    headers.set(key, value);
  });

  return headers;
}

async function getErrorMessage(upstream) {
  const fallback =
    upstream.status === 404
      ? "URL not found."
      : upstream.statusText || "Request failed.";

  let body = "";

  try {
    body = (await upstream.text()).trim();
  } catch {
    return fallback;
  }

  if (!body) {
    return fallback;
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const data = JSON.parse(body);

      if (typeof data?.message === "string" && data.message.trim()) {
        return data.message.trim();
      }

      if (typeof data?.error === "string" && data.error.trim()) {
        return data.error.trim();
      }
    } catch {}
  }

  return body;
}

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const targetUrl = buildTargetUrl(url);

    if (!targetUrl) {
      return json(400, "Target URL is required.");
    }

    const init = {
      method: request.method,
      headers: buildRequestHeaders(request, targetUrl),
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    const upstream = await fetch(targetUrl, init);

    if (upstream.status >= 400) {
      return json(upstream.status, await getErrorMessage(upstream));
    }

    const contentType = upstream.headers.get("content-type") || "";
    const headers = buildResponseHeaders(upstream, request, targetUrl);

    if (contentType.includes("text/html")) {
      return new Response(
        rewriteHtml(await upstream.text(), request, targetUrl),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        },
      );
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return json(
      typeof error?.statusCode === "number" ? error.statusCode : 502,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
