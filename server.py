"""Servidor web ligero para Yaris 211 con cuentas, sesiones y reseñas SQLite."""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import time
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("YARIS211_DB", ROOT / "yaris211.db"))
HOST = os.environ.get("YARIS211_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "4173"))
SESSION_SECONDS = 60 * 60 * 24 * 30


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def initialize_database() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash BLOB NOT NULL,
                salt BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                review_text TEXT NOT NULL CHECK (length(review_text) BETWEEN 2 AND 280),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reviews_updated_at ON reviews(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
            """
        )


def password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class Handler(SimpleHTTPRequestHandler):
    server_version = "Yaris211/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16_384:
            raise ValueError("Solicitud inválida.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, status: int, payload: dict, headers: dict | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def session_token(self) -> str | None:
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = jar.get("yaris211_session")
        return morsel.value if morsel else None

    def current_user(self) -> sqlite3.Row | None:
        token = self.session_token()
        if not token:
            return None
        now = int(time.time())
        with connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            return db.execute(
                "SELECT users.id, users.name, users.email FROM sessions "
                "JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (token_digest(token), now),
            ).fetchone()

    def cookie_header(self, token: str, max_age: int) -> str:
        secure = self.headers.get("X-Forwarded-Proto", "").lower() == "https"
        parts = [f"yaris211_session={token}", "Path=/", f"Max-Age={max_age}", "HttpOnly", "SameSite=Lax"]
        if secure:
            parts.append("Secure")
        return "; ".join(parts)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/session":
            user = self.current_user()
            self.send_json(200, {"user": dict(user) if user else None})
            return
        if path == "/api/reviews":
            with connect() as db:
                rows = db.execute(
                    "SELECT users.name, reviews.rating, reviews.review_text, reviews.updated_at "
                    "FROM reviews JOIN users ON users.id = reviews.user_id "
                    "ORDER BY reviews.updated_at DESC LIMIT 100"
                ).fetchall()
            self.send_json(200, {"reviews": [
                {"name": row["name"], "rating": row["rating"], "text": row["review_text"],
                 "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["updated_at"]))}
                for row in rows
            ]})
            return
        if path == "/":
            self.path = "/index.html"
            path = "/index.html"
        allowed_page = path in {"/index.html", "/styles.css", "/script.js"}
        allowed_asset = path.startswith("/assets/") and ".." not in path and Path(path).suffix.lower() in {
            ".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico"
        }
        if not (allowed_page or allowed_asset):
            self.send_error(404, "Archivo no encontrado")
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/register":
                self.register()
            elif path == "/api/login":
                self.login()
            elif path == "/api/logout":
                self.logout()
            elif path == "/api/reviews":
                self.save_review()
            else:
                self.send_json(404, {"error": "Ruta no encontrada."})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error) or "Datos inválidos."})
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Este correo ya tiene una cuenta."})
        except Exception:
            self.send_json(500, {"error": "Ocurrió un problema. Inténtalo nuevamente."})

    def register(self) -> None:
        data = self.json_body()
        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if not 2 <= len(name) <= 60:
            raise ValueError("Ingresa un nombre válido.")
        if "@" not in email or len(email) > 180:
            raise ValueError("Ingresa un correo válido.")
        if len(password) < 6 or len(password) > 128:
            raise ValueError("La contraseña debe tener entre 6 y 128 caracteres.")
        salt = secrets.token_bytes(16)
        now = int(time.time())
        with connect() as db:
            cursor = db.execute(
                "INSERT INTO users(name,email,password_hash,salt,created_at) VALUES(?,?,?,?,?)",
                (name, email, password_hash(password, salt), salt, now),
            )
            user_id = cursor.lastrowid
        self.create_session(user_id, name, email)

    def login(self) -> None:
        data = self.json_body()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        with connect() as db:
            user = db.execute("SELECT id,name,email,password_hash,salt FROM users WHERE email = ?", (email,)).fetchone()
        if not user or not hmac.compare_digest(user["password_hash"], password_hash(password, user["salt"])):
            self.send_json(401, {"error": "Correo o contraseña incorrectos."})
            return
        self.create_session(user["id"], user["name"], user["email"])

    def create_session(self, user_id: int, name: str, email: str) -> None:
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + SESSION_SECONDS
        with connect() as db:
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", (token_digest(token), user_id, expires))
        self.send_json(200, {"user": {"id": user_id, "name": name, "email": email}},
                       {"Set-Cookie": self.cookie_header(token, SESSION_SECONDS)})

    def logout(self) -> None:
        token = self.session_token()
        if token:
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_digest(token),))
        self.send_json(200, {"ok": True}, {"Set-Cookie": self.cookie_header("", 0)})

    def save_review(self) -> None:
        user = self.current_user()
        if not user:
            self.send_json(401, {"error": "Inicia sesión para publicar una reseña."})
            return
        data = self.json_body()
        try:
            rating = int(data.get("rating", 0))
        except (TypeError, ValueError):
            rating = 0
        text = str(data.get("text", "")).strip()
        if rating < 1 or rating > 5:
            raise ValueError("Selecciona una calificación de 1 a 5 estrellas.")
        if not 2 <= len(text) <= 280:
            raise ValueError("La reseña debe tener entre 2 y 280 caracteres.")
        now = int(time.time())
        with connect() as db:
            db.execute(
                "INSERT INTO reviews(user_id,rating,review_text,created_at,updated_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET rating=excluded.rating, review_text=excluded.review_text, updated_at=excluded.updated_at",
                (user["id"], rating, text, now, now),
            )
        self.send_json(200, {"ok": True})


if __name__ == "__main__":
    mimetypes.add_type("text/javascript", ".js")
    initialize_database()
    print(f"Yaris 211 disponible en http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
