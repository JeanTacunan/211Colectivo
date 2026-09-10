const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SESSION_COOKIE = "yaris211_session";
const SESSION_DAYS = 30;
const PROOF_MINUTES = 10;
const PBKDF2_ITERATIONS = 210000;
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

  if (url.pathname === "/api/dni/validate" && request.method === "POST") return validateDniEndpoint(request, env);
  if (url.pathname === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (url.pathname === "/api/auth/me" && request.method === "GET") return me(request, env);
  if (url.pathname === "/api/reviews" && request.method === "GET") return listReviews(request, env);
  if (url.pathname === "/api/reviews" && request.method === "POST") return createReview(request, env);
  if (url.pathname === "/api/reviews/mine" && request.method === "PUT") return updateReview(request, env);
  return json({ success: false, error: "Ruta no encontrada." }, 404);
}

async function validateDniEndpoint(request, env) {
  const body = await readJson(request);
  if (!body || !validateDni(body.dni)) return json({ success: false, error: "El DNI debe contener exactamente 8 dígitos." }, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.DNI_RATE_LIMITER && !(await env.DNI_RATE_LIMITER.limit({ key: ip })).success) {
    return json({ success: false, error: "Has realizado varios intentos. Espera un minuto y vuelve a intentar." }, 429);
  }
  if (!env.DNI_API_TOKEN || !env.DNI_HASH_SECRET || !env.SESSION_SECRET) return serviceUnavailable();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  let response;
  try {
    response = await fetch(`https://api.decolecta.com/v1/reniec/dni?numero=${encodeURIComponent(body.dni)}`, {
      headers: { Authorization: `Bearer ${env.DNI_API_TOKEN}`, Accept: "application/json" },
      signal: controller.signal
    });
  } catch {
    return serviceUnavailable();
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 404 || response.status === 400 || response.status === 422) {
    return json({ success: false, error: "No encontramos una persona asociada a ese DNI." }, 404);
  }
  if (response.status === 429) return json({ success: false, error: "El servicio de validación está ocupado. Inténtalo en unos minutos." }, 429);
  if (!response.ok) {
    console.error("Decolecta DNI error status:", response.status);
    return json({
      success: false,
      error: `Error del proveedor DNI (${response.status})`
    }, 502);
  }

  const providerData = await response.json().catch(() => null);
  const person = normalizeDniPerson(providerData);
  if (!person.nombreCompleto) return json({ success: false, error: "No pudimos obtener el nombre asociado a ese DNI." }, 502);
  const dniHash = await hmacHex(env.DNI_HASH_SECRET, body.dni);
  const proof = await signProof({ dniHash, dniLast4: body.dni.slice(-4), name: person.nombreCompleto, exp: Date.now() + PROOF_MINUTES * 60000 }, env.SESSION_SECRET);
  return json({ success: true, person, proof });
}

async function register(request, env) {
  const body = await readJson(request);
  if (!env.SESSION_SECRET || !env.DNI_HASH_SECRET) return json({ success: false, error: "El registro no está disponible temporalmente." }, 503);

  const email = normalizeEmail(body?.email);
  if (!body || !email || !validateEmail(email)) return json({ success: false, error: "Ingresa un correo electrónico válido." }, 400);

  const passwordError = validatePassword(body.password, body.passwordConfirm);
  if (passwordError) return json({ success: false, error: passwordError }, 400);

  const proof = typeof body?.proof === "string" ? await verifyProof(body.proof, env.SESSION_SECRET) : null;
  let dniHash;
  let dniLast4;
  let name;

  if (proof) {
    dniHash = proof.dniHash;
    dniLast4 = proof.dniLast4;
    name = cleanName(proof.name);
  } else {
    if (!validateDni(body?.dni)) return json({ success: false, error: "El DNI debe contener exactamente 8 dígitos." }, 400);
    const dni = String(body.dni).trim();
    name = cleanName(body?.name);
    if (!name) return json({ success: false, error: "Ingresa tu nombre completo." }, 400);
    dniHash = await hmacHex(env.DNI_HASH_SECRET, dni);
    dniLast4 = dni.slice(-4);
  }

  const existing = await env.DB.prepare("SELECT dni_hash, email FROM users WHERE dni_hash = ? OR email = ?").bind(dniHash, email).first();
  if (existing?.dni_hash === dniHash) return json({ success: false, error: "Ese DNI ya está registrado." }, 409);
  if (existing) return json({ success: false, error: "Ese correo ya está registrado." }, 409);

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);
  try {
    await env.DB.prepare("INSERT INTO users (id, dni_hash, dni_last4, name, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, dniHash, dniLast4, name, email, passwordHash).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ success: false, error: "El DNI o correo ya se encuentra registrado." }, 409);
    throw error;
  }
  return createSessionResponse(request, env, { id: userId, name, email }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email || typeof body?.password !== "string") return json({ success: false, error: "Ingresa tu correo y contraseña." }, 400);
  const user = await env.DB.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE").bind(email).first();
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return json({ success: false, error: "Correo o contraseña incorrectos." }, 401);
  }
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
  const [itemsResult, summary] = await env.DB.batch([
    env.DB.prepare("SELECT r.author_name, r.rating, r.comment, r.created_at, r.updated_at, CASE WHEN r.user_id = ? THEN 1 ELSE 0 END AS mine FROM reviews r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.updated_at DESC LIMIT 100").bind(user?.id || ""),
    env.DB.prepare("SELECT ROUND(COALESCE(AVG(rating), 0), 1) AS average, COUNT(*) AS total FROM reviews")
  ]);
  const reviews = (itemsResult.results || []).map(row => ({ name: publicName(row.author_name || "Anónimo"), rating: row.rating, text: row.comment, date: row.updated_at, mine: Boolean(row.mine) }));
  return json({ success: true, reviews, average: Number(summary.results?.[0]?.average || 0), total: Number(summary.results?.[0]?.total || 0), myReview: reviews.find(review => review.mine) || null });
}

async function createReview(request, env) {
  const body = await readJson(request);
  const error = validateReview(body?.rating, body?.text);
  if (error) return json({ success: false, error }, 400);

  const user = await currentUser(request, env);
  const reviewText = body.text.trim();
  const reviewName = cleanName(body?.name || user?.name || "Anónimo");

  try {
    await env.DB.prepare("INSERT INTO reviews (id, user_id, rating, comment, author_name) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), user?.id || null, body.rating, reviewText, reviewName).run();
  } catch (dbError) {
    if (String(dbError).includes("UNIQUE")) return json({ success: false, error: "Ya tienes una reseña. Puedes actualizarla." }, 409);
    throw dbError;
  }

  return json({ success: true }, 201);
}

async function updateReview(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const error = validateReview(body?.rating, body?.text);
  if (error) return json({ success: false, error }, 400);
  const result = await env.DB.prepare("UPDATE reviews SET rating = ?, comment = ?, updated_at = datetime('now') WHERE user_id = ?").bind(body.rating, body.text.trim(), user.id).run();
  if (!result.meta?.changes) return json({ success: false, error: "Aún no tienes una reseña para actualizar." }, 404);
  return json({ success: true });
}

async function createSessionResponse(request, env, user, status = 200) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), user.id, expires.toISOString())
  ]);
  return json({ success: true, user: publicUser(user) }, status, { "set-cookie": sessionCookie(request, token, expires) });
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare("SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')")
    .bind(await sha256Hex(token)).first();
}

async function requireUser(request, env) {
  return (await currentUser(request, env)) || json({ success: false, error: "Inicia sesión para publicar una reseña." }, 401);
}

export function validateDni(value) { return typeof value === "string" && /^[0-9]{8}$/.test(value); }
export function validateEmail(value) { return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
export function validatePassword(password, confirmation) {
  if (typeof password !== "string" || password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (password.length > 128) return "La contraseña es demasiado larga.";
  if (password !== confirmation) return "Las contraseñas no coinciden.";
  return null;
}
export function validateReview(rating, text) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "Selecciona una calificación de 1 a 5 estrellas.";
  if (typeof text !== "string" || !text.trim()) return "Escribe un comentario sobre tu experiencia.";
  if (text.trim().length > 280) return "El comentario no puede superar los 280 caracteres.";
  return null;
}
export function normalizeDniPerson(data = {}) {
  const wantedKeys = new Set([
    "nombres", "nombre", "names", "name",
    "first_name", "firstName",
    "apellido_paterno", "apellidoPaterno", "first_last_name", "firstLastName",
    "apellido", "surname", "lastName", "paterno",
    "apellido_materno", "apellidoMaterno", "second_last_name", "secondLastName",
    "maternalSurname", "maternal_surname", "materno", "secondSurname",
    "nombre_completo", "nombreCompleto", "full_name", "fullName"
  ]);

  const candidates = [
    data,
    data?.data,
    data?.result,
    data?.person,
    data?.persona,
    data?.response,
    data?.details,
    data?.payload,
    data?.document
  ].filter(Boolean);

  const root = candidates.find(candidate => candidate && Object.keys(candidate).some(key => wantedKeys.has(key))) ||
    candidates.find(candidate => candidate && Object.keys(candidate).length > 0) || {};

  const nombres = cleanName(
    root.nombres ||
    root.first_name || root.firstName || root.name || root.names || root.nombre || root.nombresPerson || ""
  );

  const apellidoPaterno = cleanName(
    root.apellido_paterno || root.apellidoPaterno || root.first_last_name || root.firstLastName ||
    root.apellido || root.surname || root.lastName || root.paterno || root.last_name || ""
  );

  const apellidoMaterno = cleanName(
    root.apellido_materno || root.apellidoMaterno || root.second_last_name || root.secondLastName ||
    root.maternalSurname || root.maternal_surname || root.materno || root.secondSurname || ""
  );

  const nombreCompleto = cleanName(
    root.nombre_completo || root.nombreCompleto || root.full_name || root.fullName ||
    [nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join(" ") || ""
  );

  return { nombres, apellidoPaterno, apellidoMaterno, nombreCompleto };
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, iterations, salt, expected] = String(stored).split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterations || !salt || !expected) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64url(salt), iterations: Number(iterations) }, key, 256);
  return timingSafeEqual(new Uint8Array(bits), fromBase64url(expected));
}

async function signProof(payload, secret) {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmacBase64url(secret, encoded)}`;
}

async function verifyProof(value, secret) {
  if (typeof value !== "string" || !secret) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !timingSafeEqual(fromBase64url(signature), fromBase64url(await hmacBase64url(secret, payload)))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return parsed.exp > Date.now() && parsed.dniHash && parsed.name ? parsed : null;
  } catch { return null; }
}

async function hmacBase64url(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
async function hmacHex(secret, value) { return bytesToHex(fromBase64url(await hmacBase64url(secret, value))); }
async function sha256Hex(value) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]; return result === 0; }
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
function base64url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromBase64url(value) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); return Uint8Array.from(atob(padded), char => char.charCodeAt(0)); }
function bytesToHex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function cleanName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 160); }
function normalizeEmail(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function publicUser(user) { return { name: user.name, email: user.email }; }
function publicName(name) { const parts = cleanName(name).split(" "); return parts.length > 1 ? `${parts[0]} ${parts[1].charAt(0)}.` : parts[0]; }
function sameOrigin(request) { const origin = request.headers.get("Origin"); return !origin || origin === new URL(request.url).origin; }
function readCookie(request, name) { const match = request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return match ? decodeURIComponent(match[1]) : null; }
function sessionCookie(request, token, expires) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires.toUTCString()}`; }
function clearSessionCookie(request) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`; }
async function readJson(request) { try { if (Number(request.headers.get("content-length") || 0) > 8192) return null; return await request.json(); } catch { return null; } }
function serviceUnavailable() { return json({ success: false, error: "El servicio de validación de DNI no está disponible temporalmente." }, 503); }
function securityHeaders() { return { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()" }; }
function withSecurityHeaders(response) { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
function json(data, status = 200, extraHeaders = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...securityHeaders(), ...extraHeaders } }); }
