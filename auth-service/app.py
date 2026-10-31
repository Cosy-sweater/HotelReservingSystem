import os
import secrets
import psycopg2
import redis
from flask import Flask, jsonify, request, make_response
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
cache = redis.Redis(host=os.environ.get("REDIS_HOST", "redis"), port=6379, decode_responses=True)

def get_db():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "db"),
        database=os.environ.get("POSTGRES_DB", "hotel_db"),
        user=os.environ.get("POSTGRES_USER", "hotel_admin"),
        password=os.environ.get("POSTGRES_PASSWORD", "secretpassword")
    )

def init_auth_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user'
        );
    """)
    cur.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_number VARCHAR(50);")
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);")
    admin_hash = generate_password_hash("admin123")
    guest_hash = generate_password_hash("guest123")
    cur.execute("""
        INSERT INTO users (username, password_hash, role) VALUES
        ('admin', %s, 'admin'),
        ('alice', %s, 'user')
        ON CONFLICT (username) DO NOTHING;
    """, (admin_hash, guest_hash))
    conn.commit()
    cur.close()
    conn.close()

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT username, password_hash, role FROM users WHERE username = %s;", (username,))
    user = cur.fetchone()
    cur.close()
    conn.close()

    if not user or not check_password_hash(user[1], password):
        return jsonify({"error": "Invalid credentials"}), 401

    session_id = secrets.token_hex(32)
    cache.hset(f"session:{session_id}", mapping={"username": user[0], "role": user[2]})
    cache.expire(f"session:{session_id}", 86400)

    # Return role so login page knows where to redirect, but keep session_id in an HttpOnly cookie!
    resp = make_response(jsonify({"username": user[0], "role": user[2]}))
    resp.set_cookie(
        "session_id",
        session_id,
        httponly=True,   # Invisible to JavaScript (document.cookie)!
        samesite="Lax",
        path="/"
    )
    return resp

@app.route("/auth/logout", methods=["POST"])
def logout():
    session_id = request.cookies.get("session_id")
    if session_id:
        cache.delete(f"session:{session_id}")
    resp = make_response(jsonify({"message": "Logged out"}))
    resp.delete_cookie("session_id", path="/")
    return resp


@app.route("/auth/register", methods=["POST"])
def register():
    data = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    passport_number = (data.get("passport_number") or "").strip() or None
    phone = (data.get("phone") or "").strip() or None

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO users (username, password_hash, role, passport_number, phone)
            VALUES (%s, %s, 'user', %s, %s);
        """, (username, generate_password_hash(password), passport_number, phone))
        conn.commit()
    except psycopg2.IntegrityError:
        conn.rollback()
        return jsonify({"error": "Username already taken"}), 409
    finally:
        cur.close()
        conn.close()

    session_id = secrets.token_hex(32)
    cache.hset(f"session:{session_id}", mapping={"username": username, "role": "user"})
    cache.expire(f"session:{session_id}", 86400)

    resp = make_response(jsonify({"username": username, "role": "user"}))
    resp.set_cookie("session_id", session_id, httponly=True, samesite="Lax", path="/")
    return resp

@app.route("/auth/me", methods=["GET"])
def me():
    session_id = request.cookies.get("session_id")
    user = cache.hgetall(f"session:{session_id}") if session_id else None
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    return jsonify(user)

# --- INTERNAL NGINX GATEKEEPER ENDPOINTS ---
@app.route("/auth/verify-user", methods=["GET"])
def verify_user():
    session_id = request.cookies.get("session_id")
    user = cache.hgetall(f"session:{session_id}") if session_id else None
    if not user:
        return "", 401
    return "", 200

@app.route("/auth/verify-admin", methods=["GET"])
def verify_admin():
    session_id = request.cookies.get("session_id")
    user = cache.hgetall(f"session:{session_id}") if session_id else None
    if not user:
        return "", 401
    if user.get("role") != "admin":
        return "", 403  # Logged in, but NOT an admin!
    return "", 200

if __name__ == "__main__":
    init_auth_db()
    app.run(host="0.0.0.0", port=5001, debug=True)