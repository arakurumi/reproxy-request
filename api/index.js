const REQUEST_HOP_HEADERS = new Set([
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

const RESPONSE_HOP_HEADERS = new Set([
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

const PROXY_PARAM = "url";
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function json(status, message) {
  return new Response(JSON.stringify({ status, message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function firstHeader(headers, name, fallback = "") {
  return headers.get(name)?.split(",")[0]?.trim() || fallback;
}

function getProxyOrigin(request) {
  const requestUrl = new URL(request.url);
  const host = firstHeader(
    request.headers,
    "x-forwarded-host",
    request.headers.get("host") || requestUrl.host,
  );
  const protocol =
    firstHeader(
      request.headers,
      "x-forwarded-proto",
      requestUrl.protocol.slice(0, -1),
    ) || "https";

  return host ? `${protocol}://${host}` : "";
}

function buildTargetUrl(requestUrl) {
  const source =
    requestUrl.searchParams.get(PROXY_PARAM) ||
    (requestUrl.pathname.startsWith("/api/")
      ? requestUrl.pathname.slice("/api/".length)
      : "");

  if (!source) {
    return null;
  }

  let rawPath;

  try {
    rawPath = decodeURIComponent(source).replace(
      /^(https?):\/(?!\/)/i,
      "$1://",
    );
  } catch {
    throw httpError(400, "Target URL encoding is invalid.");
  }

  let target;

  try {
    if (/^https?:\/\//i.test(rawPath)) {
      target = new URL(rawPath);
    } else {
      const parts = rawPath.split("/");
      const first = (parts[0] || "").replace(/:$/, "").toLowerCase();
      const protocol = first === "http" || first === "https" ? first : "https";
      const offset = protocol === first ? 1 : 0;
      const host = parts[offset] || "";

      if (!host) {
        return null;
      }

      target = new URL(`${protocol}://${host}`);
      target.pathname = `/${parts.slice(offset + 1).join("/")}`;
    }
  } catch {
    throw httpError(400, "Target URL is invalid.");
  }

  requestUrl.searchParams.forEach((value, key) => {
    if (key !== PROXY_PARAM) {
      target.searchParams.append(key, value);
    }
  });

  return target;
}

function buildRequestHeaders(request, targetUrl, proxyOrigin) {
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    if (!REQUEST_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const proxyUrl = new URL(proxyOrigin || request.url);
  const forwardedFor = firstHeader(request.headers, "x-forwarded-for");

  headers.set("host", targetUrl.host);
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", proxyUrl.host);
  headers.set("x-forwarded-proto", proxyUrl.protocol.slice(0, -1));

  if (forwardedFor) {
    headers.set("x-forwarded-for", forwardedFor);
  }

  return headers;
}

function toProxyUrl(value, proxyOrigin, targetUrl) {
  const trimmed = value?.trim();

  if (
    !proxyOrigin ||
    !trimmed ||
    /^(#|data:|javascript:|mailto:|tel:)/i.test(trimmed)
  ) {
    return value;
  }

  try {
    const absolute = trimmed.startsWith("//")
      ? new URL(`${targetUrl.protocol}${trimmed}`)
      : new URL(trimmed, targetUrl);

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return value;
    }

    return new URL(`/${absolute.toString()}`, proxyOrigin).toString();
  } catch {
    return value;
  }
}

function rewriteHtml(html, proxyOrigin, targetUrl) {
  const rewrite = (value) => toProxyUrl(value, proxyOrigin, targetUrl);

  return html
    .replace(
      /\b(href|src|action|poster)=("([^"]*)"|'([^']*)')/gi,
      (_, attr, quoted, doubleValue, singleValue) => {
        const quote = quoted[0];
        const value = doubleValue ?? singleValue ?? "";
        return `${attr}=${quote}${rewrite(value)}${quote}`;
      },
    )
    .replace(
      /\bsrcset=("([^"]*)"|'([^']*)')/gi,
      (_, quoted, doubleValue, singleValue) => {
        const quote = quoted[0];
        const value = doubleValue ?? singleValue ?? "";
        const rewritten = value
          .split(",")
          .map((item) => {
            const candidate = item.trim();

            if (!candidate) {
              return candidate;
            }

            const separator = candidate.search(/\s/);

            if (separator === -1) {
              return rewrite(candidate);
            }

            return `${rewrite(candidate.slice(0, separator))}${candidate.slice(separator)}`;
          })
          .join(", ");

        return `srcset=${quote}${rewritten}${quote}`;
      },
    )
    .replace(
      /\bcontent=("([^"]*)"|'([^']*)')/gi,
      (match, quoted, doubleValue, singleValue) => {
        const quote = quoted[0];
        const value = doubleValue ?? singleValue ?? "";
        const rewritten = value.replace(
          /(\s*;\s*url=)([^;]+)/i,
          (_, prefix, target) => `${prefix}${rewrite(target)}`,
        );

        return rewritten === value
          ? match
          : `content=${quote}${rewritten}${quote}`;
      },
    );
}

function buildResponseHeaders(upstream, proxyOrigin, targetUrl) {
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

    if (
      lower === "set-cookie" ||
      lower === "content-security-policy" ||
      lower === "content-security-policy-report-only" ||
      RESPONSE_HOP_HEADERS.has(lower)
    ) {
      return;
    }

    headers.set(
      key,
      lower === "location" ? toProxyUrl(value, proxyOrigin, targetUrl) : value,
    );
  });

  return headers;
}

async function getErrorMessage(upstream) {
  const fallback =
    upstream.status === 404
      ? "URL not found."
      : upstream.statusText || "Request failed.";

  try {
    const body = (await upstream.text()).trim();

    if (!body) {
      return fallback;
    }

    if (
      (upstream.headers.get("content-type") || "").includes("application/json")
    ) {
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
  } catch {
    return fallback;
  }
}

async function handleRequest(request) {
  try {
    const requestUrl = new URL(request.url);
    const proxyOrigin = getProxyOrigin(request);
    const targetUrl = buildTargetUrl(requestUrl);

    if (!targetUrl) {
      return json(400, "Target URL is required.");
    }

    const init = {
      method: request.method,
      headers: buildRequestHeaders(request, targetUrl, proxyOrigin),
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

    const headers = buildResponseHeaders(upstream, proxyOrigin, targetUrl);
    const responseInit = {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    };

    if (request.method === "HEAD") {
      return new Response(null, responseInit);
    }

    if ((upstream.headers.get("content-type") || "").includes("text/html")) {
      return new Response(
        rewriteHtml(await upstream.text(), proxyOrigin, targetUrl),
        responseInit,
      );
    }

    return new Response(upstream.body, responseInit);
  } catch (error) {
    return json(
      typeof error?.statusCode === "number" ? error.statusCode : 502,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export default {
  fetch: handleRequest,
};
