import os
import psycopg2
import redis
from functools import wraps
from flask import Flask, jsonify, request

app = Flask(__name__)
cache = redis.Redis(host=os.environ.get("REDIS_HOST", "redis"), port=6379, decode_responses=True)

def get_db():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "db"),
        database=os.environ.get("POSTGRES_DB", "hotel_db"),
        user=os.environ.get("POSTGRES_USER", "hotel_admin"),
        password=os.environ.get("POSTGRES_PASSWORD", "secretpassword")
    )

def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            room_number INT PRIMARY KEY,
            room_type VARCHAR(50),
            price INT,
            is_booked BOOLEAN DEFAULT FALSE,
            booked_by VARCHAR(100)
        );
        INSERT INTO rooms (room_number, room_type, price) VALUES
        (101, 'Standard Single', 100),
        (102, 'Deluxe Double', 180),
        (201, 'Penthouse Suite', 350)
        ON CONFLICT (room_number) DO NOTHING;
    """)
    conn.commit()
    cur.close()
    conn.close()

def require_auth(required_role=None):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            session_id = request.cookies.get("session_id")
            session_data = cache.hgetall(f"session:{session_id}") if session_id else None
            if not session_data:
                return jsonify({"error": "Unauthorized"}), 401
            if required_role and session_data.get("role") != required_role:
                return jsonify({"error": "Forbidden: Admin privileges required"}), 403
            request.current_user = session_data
            return f(*args, **kwargs)
        return wrapper
    return decorator

@app.route("/api/rooms", methods=["GET"])
@require_auth()
def get_rooms():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT room_number, room_type, price, is_booked, booked_by FROM rooms ORDER BY room_number;")
    rows = cur.fetchall()
    cur.close()
    conn.close()

    rooms = []
    for r in rows:
        room_num = r[0]
        lock_holder = cache.get(f"lock:room:{room_num}")
        ttl = cache.ttl(f"lock:room:{room_num}")
        rooms.append({
            "room_number": room_num,
            "room_type": r[1],
            "price": r[2],
            "is_booked": r[3],
            "booked_by": r[4],
            "is_locked": lock_holder is not None,
            "locked_by": lock_holder,
            "lock_expires_in": ttl if ttl and ttl > 0 else 0
        })
    return jsonify(rooms)

@app.route("/api/hold/<int:room_num>", methods=["POST"])
@require_auth()
def hold_room(room_num):
    user = request.current_user["username"]
    locked = cache.set(f"lock:room:{room_num}", user, nx=True, ex=600)
    if not locked:
        return jsonify({"error": "Room is currently held by another guest!"}), 409
    return jsonify({"message": f"Room {room_num} held for {user}."})

@app.route("/api/pay/<int:room_num>", methods=["POST"])
@require_auth()
def pay_and_book(room_num):
    user = request.current_user["username"]
    if cache.get(f"lock:room:{room_num}") != user:
        return jsonify({"error": "Hold expired or belongs to another user."}), 403

    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE rooms SET is_booked = TRUE, booked_by = %s WHERE room_number = %s;", (user, room_num))
    conn.commit()
    cur.close()
    conn.close()
    cache.delete(f"lock:room:{room_num}")
    return jsonify({"message": f"Room {room_num} booked for {user}!"})

@app.route("/api/admin/reset", methods=["POST"])
@require_auth(required_role="admin")
def reset_all():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("UPDATE rooms SET is_booked = FALSE, booked_by = NULL;")
    conn.commit()
    cur.close()
    conn.close()
    for key in cache.scan_iter("lock:room:*"):
        cache.delete(key)
    return jsonify({"message": "All rooms and locks reset!"})

if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)