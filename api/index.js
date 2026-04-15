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
  const forwardedHost =
    getForwardedHeader(request.headers, "x-forwarded-host") ||
    request.headers.get("host") ||
    "";
  const forwardedProto = getForwardedHeader(
    request.headers,
    "x-forwarded-proto",
    "https",
  );

  if (forwardedFor) {
    headers.set("x-forwarded-for", forwardedFor);
  }

  if (forwardedHost) {
    headers.set("x-forwarded-host", forwardedHost);
  }

  headers.set("x-forwarded-proto", forwardedProto);

  return headers;
}

function rewriteLocationHeader(location, request, targetUrl) {
  const host =
    getForwardedHeader(request.headers, "x-forwarded-host") ||
    request.headers.get("host") ||
    "";
  const protocol = getForwardedHeader(
    request.headers,
    "x-forwarded-proto",
    "https",
  );

  if (!host) {
    return location;
  }

  try {
    const resolved = new URL(location, targetUrl);

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return location;
    }

    return new URL(
      `/${resolved.toString()}`,
      `${protocol}://${host}`,
    ).toString();
  } catch {
    return location;
  }
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

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream, request, targetUrl),
    });
  } catch (error) {
    return json(
      typeof error?.statusCode === "number" ? error.statusCode : 502,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
