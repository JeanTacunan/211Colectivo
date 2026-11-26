import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("auth in Workers + D1: migration preserves data, register/login/logout, throttling", async () => {
  const bundle = await build({ entryPoints: ["src/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "auth-test", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-13", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], bindings: { SESSION_SECRET: "isolated-test-secret-not-for-deployment" } }] }));
  try {
    const db = await mf.getD1Database("DB");
    const migrations = (await readdir("migrations")).filter(f => f.endsWith(".sql")).sort();
    async function migrate(file) {
      const sql = (await readFile("migrations/" + file, "utf8")).replace(/^--.*$/gm, "");
      for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
    }
    await migrate(migrations[0]); await migrate(migrations[1]);
    await db.prepare("INSERT INTO users (id,dni_hash,dni_last4,name,email,password_hash) VALUES ('legacy','legacy','0000','Historical account','legacy@local.invalid','historical-hash')").run();
    await db.prepare("INSERT INTO reviews (id,user_id,rating,comment) VALUES ('historical-review','legacy',5,'Preserve this review')").run();
    await db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ('historical-session','legacy','2099-01-01T00:00:00.000Z')").run();
    const before = await db.prepare("SELECT * FROM reviews").all();
    await migrate(migrations[2]);
    assert.deepEqual((await db.prepare("SELECT * FROM reviews").all()).results, before.results);
    assert.equal((await db.prepare("SELECT password_hash FROM users WHERE id='legacy'").first()).password_hash, "historical-hash");
    assert.ok(await db.prepare("SELECT * FROM sessions WHERE token_hash='historical-session'").first());
    const call = (path, body, cookie = "", origin = "https://yaris.test") => mf.dispatchFetch("https://yaris.test" + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "CF-Connecting-IP": "192.0.2.1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = { firstName: "Persona", lastName: "Simulada", phone: "900000001", password: "Local-test-password-42" };
    for (const key of Object.keys(payload)) {
      const invalid = { ...payload }; delete invalid[key];
      assert.equal((await call("/api/auth/register", invalid)).status, 400, key + " is required");
    }
    assert.equal((await call("/api/auth/register", { ...payload, phone: "800000001" })).status, 400);
    assert.equal((await call("/api/auth/register", payload, "", "https://other.test")).status, 403);
    assert.equal((await call("/api/dni/validate", {})).status, 404);
    const registered = await call("/api/auth/register", payload);
    assert.equal(registered.status, 201, await registered.clone().text());
    const cookie = registered.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Secure/);
    const stored = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(payload.phone).first();
    assert.match(stored.password_hash, /^scrypt\$/); assert.ok(!stored.password_hash.includes(payload.password));
    assert.equal(stored.first_name, payload.firstName); assert.equal(stored.last_name, payload.lastName);
    assert.equal((await call("/api/auth/register", payload)).status, 409);
    assert.equal((await (await call("/api/auth/me", undefined, cookie)).json()).user.phone, payload.phone);
    const login = await call("/api/auth/login", { phone: payload.phone, password: payload.password }, cookie);
    assert.equal(login.status, 200, await login.clone().text());
    assert.equal((await (await call("/api/auth/me", undefined, cookie)).json()).user, null, "old session rotated");
    const loginCookie = login.headers.get("set-cookie");
    await call("/api/auth/logout", {}, loginCookie);
    assert.equal((await (await call("/api/auth/me", undefined, loginCookie)).json()).user, null);
    for (let i = 0; i < 4; i++) assert.equal((await call("/api/auth/login", { phone: payload.phone, password: "incorrect-password" })).status, 401);
    const blocked = await call("/api/auth/login", { phone: payload.phone, password: payload.password });
    assert.equal(blocked.status, 429); assert.ok(blocked.headers.has("retry-after"));
    await db.prepare("UPDATE auth_attempts SET expires_at = 0").run();
    const resumed = await call("/api/auth/login", { phone: payload.phone, password: payload.password });
    assert.equal(resumed.status, 200);
    await db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").bind(stored.id).run();
    assert.equal((await (await call("/api/auth/me", undefined, resumed.headers.get("set-cookie"))).json()).user, null);
    assert.deepEqual((await db.prepare("SELECT * FROM reviews").all()).results, before.results);
    assert.equal((await call("/api/reviews")).status, 200);
  } finally { await mf.dispose(); }
});
