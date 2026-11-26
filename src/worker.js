import { scrypt, pbkdf2, timingSafeEqual as cryptoEqual } from "node:crypto";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SESSION_COOKIE = "yaris211_session";
const SESSION_DAYS = 30;
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await routeApi(request, env, url);
      const response = await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
      return json({ success: false, error: "Ocurrió un error inesperado. Inténtalo nuevamente." }, 500);
    }
  }
};

async function routeApi(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders() });
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) {
    return json({ success: false, error: "Solicitud no permitida." }, 403);
  }

  if (url.pathname === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (url.pathname === "/api/auth/me" && request.method === "GET") return me(request, env);
  if (url.pathname === "/api/reviews" && request.method === "GET") return listReviews(request, env);
  if (url.pathname === "/api/reviews" && request.method === "POST") return createReview(request, env);
  if (url.pathname === "/api/reviews/mine" && request.method === "PUT") return updateReview(request, env);
  return json({ success: false, error: "Ruta no encontrada." }, 404);
}

// Reserve attempt slots atomically before expensive password work.
async function authLimit(request, env, phone, action) {
  if (!env.SESSION_SECRET) return json({ success: false, error: "El acceso no está disponible temporalmente." }, 503);
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const keys = await Promise.all([
    hmacHex(env.SESSION_SECRET, action + ":ip:" + ip),
    hmacHex(env.SESSION_SECRET, action + ":phone:" + phone)
  ]);
  const rows = await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_attempts WHERE expires_at <= ?").bind(now),
    ...keys.map(key => env.DB.prepare(
      "INSERT INTO auth_attempts (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts, expires_at"
    ).bind(key, now + 900))
  ]);
  const blocked = rows.slice(1).some((r, i) => r.results[0].attempts > (i === 0 ? 30 : 5));
  if (blocked) return json({ success: false, error: "Demasiados intentos. Espera 15 minutos antes de volver a intentar." }, 429, { "Retry-After": "900" });
  return null;
}

async function register(request, env) {
  const body = await readJson(request);
  if (!body || !validName(body.firstName) || !validName(body.lastName)) return json({ success: false, error: "Ingresa nombres y apellidos (máximo 80 caracteres por campo)." }, 400);
  if (!validatePhone(body.phone)) return json({ success: false, error: "El celular debe tener 9 dígitos y comenzar con 9." }, 400);
  const error = validatePassword(body.password);
  if (error) return json({ success: false, error }, 400);
  const limited = await authLimit(request, env, body.phone, "register");
  if (limited) return limited;
  if (await env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(body.phone).first()) return json({ success: false, error: "Este celular ya está registrado. Inicia sesión." }, 409);
  const id = crypto.randomUUID();
  const firstName = cleanName(body.firstName);
  const lastName = cleanName(body.lastName);
  const name = firstName + " " + lastName;
  const passwordHash = await hashPassword(body.password);
  try {
    // Legacy NOT NULL columns are retained for compatibility, never populated with personal identity data.
    await env.DB.prepare("INSERT INTO users (id, dni_hash, dni_last4, name, email, password_hash, first_name, last_name, phone) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)")
      .bind(id, "unused:" + id, name, id + "@phone.invalid", passwordHash, firstName, lastName, body.phone).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ success: false, error: "Este celular ya está registrado. Inicia sesión." }, 409);
    throw error;
  }
  return createSessionResponse(request, env, { id, name, phone: body.phone }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  if (!validatePhone(body?.phone) || validatePassword(body?.password)) return json({ success: false, error: "Ingresa un celular válido y una contraseña de 8 a 128 caracteres." }, 400);
  const limited = await authLimit(request, env, body.phone, "login");
  if (limited) return limited;
  const user = await env.DB.prepare("SELECT id, name, phone, password_hash FROM users WHERE phone = ?").bind(body.phone).first();
  // Unknown accounts perform the same expensive hash work.
  const valid = user ? await verifyPassword(body.password, user.password_hash) : (await hashPassword(body.password), false);
  if (!valid) return json({ success: false, error: "Celular o contraseña incorrectos." }, 401);
  return createSessionResponse(request, env, user);
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return json({ success: true }, 200, { "set-cookie": clearSessionCookie(request) });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  return json({ success: true, user: user ? publicUser(user) : null });
}

async function listReviews(request, env) {
  const user = await currentUser(request, env);
  const reviewColumns = await reviewTableColumns(env);
  const supportsAuthorName = reviewColumns.has("author_name");
  const [itemsResult, summary] = await env.DB.batch([
    env.DB.prepare(
      supportsAuthorName
        ? "SELECT u.phone, u.name, r.author_name, r.rating, r.comment, r.created_at, r.updated_at, CASE WHEN r.user_id = ? THEN 1 ELSE 0 END AS mine FROM reviews r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.updated_at DESC LIMIT 100"
        : "SELECT u.phone, u.name, r.rating, r.comment, r.created_at, r.updated_at, CASE WHEN r.user_id = ? THEN 1 ELSE 0 END AS mine FROM reviews r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.updated_at DESC LIMIT 100"
    ).bind(user?.id || ""),
    env.DB.prepare("SELECT ROUND(COALESCE(AVG(rating), 0), 1) AS average, COUNT(*) AS total FROM reviews")
  ]);
  const reviews = (itemsResult.results || []).map(row => ({
    name: row.phone ? cleanName(row.name) : publicName(supportsAuthorName ? (row.author_name || "Anónimo") : (row.name || "Anónimo")),
    rating: row.rating,
    text: row.comment,
    date: row.updated_at,
    mine: Boolean(row.mine)
  }));
  const total = Number(summary.results?.[0]?.total || 0);
  const average = total ? Number(summary.results?.[0]?.average || 0) : 5;
  return json({ success: true, reviews, average, total, myReview: reviews.find(review => review.mine) || null });
}

async function createReview(request, env) {
  const body = await readJson(request);
  const error = validateReview(body?.rating, body?.text);
  if (error) return json({ success: false, error }, 400);

  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const reviewText = body.text.trim();
  const reviewName = cleanName(user.name);
  const reviewColumns = await reviewTableColumns(env);
  const supportsAuthorName = reviewColumns.has("author_name");

  const reviewUser = user;

  try {
    if (supportsAuthorName) {
      await env.DB.prepare(
        `INSERT INTO reviews (id, user_id, rating, comment, author_name, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, author_name = excluded.author_name, updated_at = datetime('now')`
      ).bind(crypto.randomUUID(), reviewUser.id, body.rating, reviewText, reviewName).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO reviews (id, user_id, rating, comment, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = datetime('now')`
      ).bind(crypto.randomUUID(), reviewUser.id, body.rating, reviewText).run();
    }
  } catch (dbError) {
    console.error("Database error creating/updating review:", dbError);
    return json({ success: false, error: "No se pudo guardar la reseña. Inténtalo nuevamente." }, 500);
  }


  return json({ success: true }, 200);
}

async function updateReview(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const error = validateReview(body?.rating, body?.text);
  if (error) return json({ success: false, error }, 400);

  const reviewColumns = await reviewTableColumns(env);
  const supportsAuthorName = reviewColumns.has("author_name");
  const reviewName = cleanName(user.name);

  let result;
  if (supportsAuthorName) {
    result = await env.DB.prepare("UPDATE reviews SET rating = ?, comment = ?, author_name = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(body.rating, body.text.trim(), reviewName, user.id).run();
  } else {
    result = await env.DB.prepare("UPDATE reviews SET rating = ?, comment = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(body.rating, body.text.trim(), user.id).run();
  }
  if (!result.meta?.changes) return json({ success: false, error: "Aún no tienes una reseña para actualizar." }, 404);
  return json({ success: true });
}

async function createSessionResponse(request, env, user, status = 200) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(readCookie(request, SESSION_COOKIE) || "")),
    env.DB.prepare("DELETE FROM sessions WHERE julianday(expires_at) <= julianday('now')"),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), user.id, expires.toISOString())
  ]);
  return json({ success: true, user: publicUser(user) }, status, { "set-cookie": sessionCookie(request, token, expires) });
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare("SELECT u.id, u.name, u.phone FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND julianday(s.expires_at) > julianday('now')")
    .bind(await sha256Hex(token)).first();
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return (user?.phone ? user : null) || json({ success: false, error: "Inicia sesión para publicar una reseña." }, 401);
}

async function reviewTableColumns(env) {
  const result = await env.DB.prepare("PRAGMA table_info(reviews)").all();
  return new Set((result.results || []).map(row => row.name));
}

export function resolveAverage(averageValue, total) {
  return Number(total) > 0 ? Number(averageValue || 0) : 5;
}
export function validatePhone(value) { return typeof value === "string" && /^9[0-9]{8}$/.test(value); }
export function validName(value) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80; }
export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (password.length > 128) return "La contraseña es demasiado larga.";
  return null;
}
export function validateReview(rating, text) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "Selecciona una calificación de 1 a 5 estrellas.";
  if (typeof text !== "string" || !text.trim()) return "Escribe un comentario sobre tu experiencia.";
  if (text.trim().length > 280) return "El comentario no puede superar los 280 caracteres.";
  return null;
}
function deriveScrypt(password, salt) {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveScrypt(password, salt);
  return "scrypt$32768$8$3$" + base64url(salt) + "$" + base64url(key);
}
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    let actual, expected;
    if (parts[0] === "scrypt" && parts[1] === "32768" && parts[2] === "8" && parts[3] === "3" && parts.length === 6) {
      actual = await deriveScrypt(password, fromBase64url(parts[4]));
      expected = fromBase64url(parts[5]);
    } else if (parts[0] === "pbkdf2_sha256" && parts[1] === "210000" && parts.length === 4) {
      // Read-only compatibility for historical password hashes.
      actual = await new Promise((resolve, reject) => pbkdf2(password, fromBase64url(parts[2]), 210000, 32, "sha256", (error, key) => error ? reject(error) : resolve(key)));
      expected = fromBase64url(parts[3]);
    } else return false;
    return actual.length === expected.length && cryptoEqual(actual, expected);
  } catch { return false; }
}

async function hmacBase64url(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
async function hmacHex(secret, value) { return bytesToHex(fromBase64url(await hmacBase64url(secret, value))); }
async function sha256Hex(value) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
function base64url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromBase64url(value) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); return Uint8Array.from(atob(padded), char => char.charCodeAt(0)); }
function bytesToHex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function cleanName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 160); }
function publicUser(user) { return { name: user.name, phone: user.phone || null }; }
function publicName(name) { const parts = cleanName(name).split(" "); return parts.length > 1 ? `${parts[0]} ${parts[1].charAt(0)}.` : parts[0]; }
function sameOrigin(request) { const origin = request.headers.get("Origin"); return !origin || origin === new URL(request.url).origin; }
function readCookie(request, name) { const match = request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return match ? decodeURIComponent(match[1]) : null; }
function sessionCookie(request, token, expires) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires.toUTCString()}`; }
function clearSessionCookie(request) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`; }
async function readJson(request) { try { if (Number(request.headers.get("content-length") || 0) > 8192) return null; return await request.json(); } catch { return null; } }
function securityHeaders() { return { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()" }; }
function withSecurityHeaders(response) { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
function json(data, status = 200, extraHeaders = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...securityHeaders(), ...extraHeaders } }); }
