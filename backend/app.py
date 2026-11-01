import os
import json
from datetime import datetime
from functools import wraps
import psycopg2
from psycopg2.extras import RealDictCursor
import redis
from flask import Flask, jsonify, request
from werkzeug.security import generate_password_hash
import csv
import io
import math
import uuid
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, Response

app = Flask(__name__)
cache = redis.Redis(host=os.environ.get("REDIS_HOST", "redis"), port=6379,
                    decode_responses=True)


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
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            passport_number VARCHAR(50),
            phone VARCHAR(30)
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS passport_number VARCHAR(50);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
        
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            transaction_id VARCHAR(64) UNIQUE NOT NULL,
            reservation_id INT REFERENCES reservations(id) ON DELETE CASCADE,
            username VARCHAR(50) NOT NULL,
            room_number INT NOT NULL,
            amount NUMERIC(10,2) NOT NULL,
            currency VARCHAR(10) DEFAULT 'USD',
            provider VARCHAR(30) DEFAULT 'Stripe-Sandbox',
            card_last4 VARCHAR(4) DEFAULT '4242',
            status VARCHAR(20) DEFAULT 'succeeded',
            paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS rooms (
            room_number INT PRIMARY KEY,
            floor INT NOT NULL DEFAULT 1,
            room_type VARCHAR(50) NOT NULL,
            sleeping_places INT NOT NULL DEFAULT 2,
            pets_allowed BOOLEAN DEFAULT FALSE,
            area_sqm NUMERIC(5,2) DEFAULT 25.0,
            window_view VARCHAR(50) NULL,
            price INT NOT NULL,
            additional_info TEXT[] NULL,
            is_booked BOOLEAN DEFAULT FALSE,
            booked_by VARCHAR(100) NULL
        );
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor INT NOT NULL DEFAULT 1;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sleeping_places INT NOT NULL DEFAULT 2;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pets_allowed BOOLEAN DEFAULT FALSE;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area_sqm NUMERIC(5,2) DEFAULT 25.0;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS window_view VARCHAR(50) NULL;
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS additional_info TEXT[] NULL;
        ALTER TABLE rooms ALTER COLUMN window_view DROP NOT NULL;
        ALTER TABLE rooms ALTER COLUMN additional_info DROP NOT NULL;
        ALTER TABLE rooms ALTER COLUMN additional_info DROP DEFAULT;

        CREATE TABLE IF NOT EXISTS reservations (
            id SERIAL PRIMARY KEY,
            room_number INT NOT NULL REFERENCES rooms(room_number) ON DELETE CASCADE,
            username VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            check_in TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            check_out TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 day'),
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS check_in TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS check_out TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 day');
        ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

        INSERT INTO rooms (room_number, floor, room_type, sleeping_places, pets_allowed, area_sqm, window_view, price, additional_info) VALUES
        (101, 1, 'Standard Single', 1, false, 20.0, NULL, 100, NULL),
        (102, 1, 'Deluxe Double', 2, true, 35.5, 'Garden View', 180, ARRAY['King Bed', 'Minibar', 'Balcony']),
        (201, 2, 'Penthouse Suite', 4, true, 85.0, 'Ocean View', 350, ARRAY['Jacuzzi', 'Private Kitchen', 'VIP Access'])
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
            session_data = cache.hgetall(
                f"session:{session_id}") if session_id else None
            if not session_data:
                return jsonify({"error": "Unauthorized"}), 401
            if required_role and session_data.get("role") != required_role:
                return jsonify(
                    {"error": "Forbidden: Admin privileges required"}), 403
            request.current_user = session_data
            return f(*args, **kwargs)

        return wrapper

    return decorator


def parse_iso_dt(dt_str):
    """Parses ISO datetime string 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD HH:MM:SS'."""
    if not dt_str:
        return None
    return datetime.fromisoformat(dt_str.replace("Z", ""))


def sync_reservation_states(cur, force=False):
    """
    Updates reservation states (upcoming -> active -> completed) in PostgreSQL.
    Protected by a 30-second Redis cooldown so spamming GET /api/rooms cannot
    spam SQL UPDATE queries. Pass force=True after booking/cancelling.
    """
    if not force:
        should_run = cache.set("sync:reservations:cooldown", "1", nx=True,
                               ex=30)
        if not should_run:
            return False

    cur.execute("""
        UPDATE reservations
        SET status = 'completed'
        WHERE status IN ('upcoming', 'active') AND check_out <= CURRENT_TIMESTAMP;

        UPDATE reservations
        SET status = 'active'
        WHERE status = 'upcoming' AND check_in <= CURRENT_TIMESTAMP AND check_out > CURRENT_TIMESTAMP;

        UPDATE rooms r
        SET is_booked = TRUE,
            booked_by = sub.username
        FROM (
            SELECT DISTINCT ON (room_number) room_number, username
            FROM reservations
            WHERE status = 'active'
            ORDER BY room_number, check_in ASC
        ) sub
        WHERE r.room_number = sub.room_number;

        UPDATE rooms r
        SET is_booked = FALSE,
            booked_by = NULL
        WHERE NOT EXISTS (
            SELECT 1 FROM reservations res
            WHERE res.room_number = r.room_number AND res.status = 'active'
        );
    """)
    return True


def get_room_holds(room_num):
    """Returns all active Redis holds for a room with their timeframes and TTLs."""
    holds = []
    for key in cache.scan_iter(f"hold:room:{room_num}:*"):
        raw = cache.get(key)
        ttl = cache.ttl(key)
        if raw and ttl > 0:
            data = json.loads(raw)
            data["ttl"] = ttl
            holds.append(data)
    return holds


def check_timeframe_conflicts(cur, room_num, req_in, req_out, ignore_user=None):
    """
    Checks both PostgreSQL reservations and Redis holds for overlapping timeframes.
    Overlap condition: existing_start < req_out AND existing_end > req_in
    """
    # 1. Check PostgreSQL reservations
    cur.execute("""
        SELECT id, username, check_in, check_out, status
        FROM reservations
        WHERE room_number = %s
          AND status IN ('upcoming', 'active')
          AND check_in < %s
          AND check_out > %s
        ORDER BY check_in ASC;
    """, (room_num, req_out, req_in))
    db_conflicts = [
        {
            "type": "reservation",
            "reservation_id": row[0],
            "username": row[1],
            "check_in": row[2].isoformat(),
            "check_out": row[3].isoformat(),
            "status": row[4]
        }
        for row in cur.fetchall()
    ]

    # 2. Check Redis active holds
    redis_conflicts = []
    for hold in get_room_holds(room_num):
        if ignore_user and hold.get("username") == ignore_user:
            continue
        h_in = parse_iso_dt(hold["check_in"])
        h_out = parse_iso_dt(hold["check_out"])
        if h_in < req_out and h_out > req_in:
            redis_conflicts.append({
                "type": "hold",
                "username": hold["username"],
                "check_in": hold["check_in"],
                "check_out": hold["check_out"],
                "expires_in_seconds": hold["ttl"]
            })

    return db_conflicts + redis_conflicts


# --- ROOMS & QUICKLOAD ENDPOINT ---
def compute_free_from(reservations, holds):
    """
    Returns the exact check_out timestamp of the current/upcoming booking block,
    or None if the room has no active/upcoming bookings.
    """
    intervals = []

    for r in reservations:
        if r.get("status") in ("active", "upcoming"):
            c_in = parse_iso_dt(r["check_in"])
            c_out = parse_iso_dt(r["check_out"])
            if c_in and c_out:
                intervals.append((c_in, c_out))

    for h in holds:
        h_in = parse_iso_dt(h["check_in"])
        h_out = parse_iso_dt(h["check_out"])
        if h_in and h_out:
            intervals.append((h_in, h_out))

    if not intervals:
        return None  # Room is completely free right now!

    # Sort by check_in time
    intervals.sort(key=lambda x: x[0])

    # Start from the end of the first active/upcoming reservation
    # and chain any back-to-back or overlapping reservations
    free_at = intervals[0][1]
    for start, end in intervals[1:]:
        if start <= free_at + timedelta(minutes=30):
            if end > free_at:
                free_at = end
        else:
            break

    return free_at.strftime("%Y-%m-%dT%H:%M")


@app.route("/api/rooms", methods=["GET"])
@require_auth()
def get_rooms():
    quick_mode = request.args.get("quick", "false").lower() in ("true", "1")
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    if not quick_mode:
        # Full load: auto-update reservation states in DB before reading
        sync_reservation_states(cur)
        conn.commit()

    cur.execute("""
        SELECT room_number, floor, room_type, sleeping_places, pets_allowed,
               area_sqm, window_view, price, additional_info, is_booked, booked_by
        FROM rooms ORDER BY room_number;
    """)
    rooms_rows = cur.fetchall()

    # Fetch upcoming & active reservations per room
    cur.execute("""
        SELECT id, room_number, username, check_in, check_out, status
        FROM reservations
        WHERE status IN ('upcoming', 'active')
        ORDER BY check_in ASC;
    """)
    res_rows = cur.fetchall()
    cur.close()
    conn.close()

    res_by_room = {}
    for r in res_rows:
        rn = r["room_number"]
        res_by_room.setdefault(rn, []).append({
            "id": r["id"],
            "username": r["username"],
            "check_in": r["check_in"].isoformat(),
            "check_out": r["check_out"].isoformat(),
            "status": r["status"]
        })

    result = []
    for r in rooms_rows:
        rn = r["room_number"]
        holds = get_room_holds(rn)
        first_hold = holds[0] if holds else None
        room_res = res_by_room.get(rn, [])
        free_from_iso = compute_free_from(room_res, holds)
        result.append({
            "room_number": rn,
            "floor": r["floor"],
            "room_type": r["room_type"],
            "sleeping_places": r["sleeping_places"],
            "pets_allowed": r["pets_allowed"],
            "area_sqm": float(r["area_sqm"]) if r[
                                                    "area_sqm"] is not None else 0.0,
            "window_view": r["window_view"],
            # Nullable (returns null in JSON if None)
            "price": r["price"],
            "additional_info": r["additional_info"],
            # Nullable (returns null or [] in JSON)
            "is_booked": r["is_booked"],
            "booked_by": r["booked_by"],
            "reservations": res_by_room.get(rn, []),
            "holds": holds,
            "free_from": free_from_iso,
            "is_locked": len(holds) > 0,
            "locked_by": first_hold["username"] if first_hold else None,
            "lock_expires_in": first_hold["ttl"] if first_hold else 0
        })

    return jsonify(result)


# --- HOLD ROOM WITH TIMEFRAME CHECKING ---
@app.route("/api/hold/<int:room_num>", methods=["POST"])
@require_auth()
def hold_room(room_num):
    user = request.current_user["username"]
    data = request.json or {}
    check_in_str = data.get("check_in")
    check_out_str = data.get("check_out")

    try:
        req_in = parse_iso_dt(check_in_str) if check_in_str else datetime.now()
        req_out = parse_iso_dt(
            check_out_str) if check_out_str else datetime.fromtimestamp(
            req_in.timestamp() + 86400)
    except ValueError:
        return jsonify({"available": False,
                        "error": "Invalid ISO datetime format. Use YYYY-MM-DDTHH:MM"}), 400

    if req_out <= req_in:
        return jsonify({"available": False,
                        "error": "Check-out time must be after check-in time."}), 400

    conn = get_db()
    cur = conn.cursor()
    sync_reservation_states(cur)
    conn.commit()

    cur.execute("SELECT room_number FROM rooms WHERE room_number = %s;",
                (room_num,))
    if not cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"available": False,
                        "error": f"Room {room_num} does not exist."}), 404

    conflicts = check_timeframe_conflicts(cur, room_num, req_in, req_out,
                                          ignore_user=user)
    cur.close()
    conn.close()

    if conflicts:
        return jsonify({
            "available": False,
            "error": "Room is unavailable for the selected timeframe.",
            "room_number": room_num,
            "requested_check_in": req_in.isoformat(),
            "requested_check_out": req_out.isoformat(),
            "conflicts": conflicts
        }), 409

    hold_payload = {
        "username": user,
        "check_in": req_in.isoformat(),
        "check_out": req_out.isoformat()
    }
    cache.set(f"hold:room:{room_num}:{user}", json.dumps(hold_payload), ex=600)

    return jsonify({
        "available": True,
        "message": f"Room {room_num} held for {user} for 10 minutes.",
        "hold": hold_payload,
        "expires_in_seconds": 600
    })


# --- PAY & CONVERT HOLD TO RESERVATION ---
@app.route("/api/pay/<int:room_num>", methods=["POST"])
@require_auth()
def pay_and_book(room_num):
    user = request.current_user["username"]
    hold_raw = cache.get(f"hold:room:{room_num}:{user}")
    if not hold_raw:
        return jsonify(
            {"error": "Your checkout hold expired or does not exist."}), 403

    hold_data = json.loads(hold_raw)
    req_in = parse_iso_dt(hold_data["check_in"])
    req_out = parse_iso_dt(hold_data["check_out"])
    status = "active" if req_in <= datetime.now() < req_out else "upcoming"

    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO reservations (room_number, username, check_in, check_out, status)
        VALUES (%s, %s, %s, %s, %s) RETURNING id;
    """, (room_num, user, req_in, req_out, status))
    res_id = cur.fetchone()[0]
    sync_reservation_states(cur)
    conn.commit()
    cur.close()
    conn.close()

    cache.delete(f"hold:room:{room_num}:{user}")
    return jsonify({
        "message": f"Payment processed! Room {room_num} booked for {user}.",
        "reservation_id": res_id,
        "check_in": req_in.isoformat(),
        "check_out": req_out.isoformat(),
        "status": status
    })


# --- TWO-WAY USER <-> RENTED ROOMS ENDPOINTS ---
@app.route("/api/users/<string:username>", methods=["GET"])
@require_auth()
def get_user_profile_and_rooms(username):
    caller = request.current_user
    if caller["role"] != "admin" and caller["username"] != username:
        return jsonify({"error": "Forbidden"}), 403

    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    if request.args.get("quick", "false").lower() not in ("true", "1"):
        sync_reservation_states(cur)
        conn.commit()

    cur.execute("""
        SELECT id, username, role, passport_number, phone
        FROM users WHERE username = %s;
    """, (username,))
    user_row = cur.fetchone()
    if not user_row:
        cur.close()
        conn.close()
        return jsonify({"exists": False, "error": "User not found"}), 404

    cur.execute("""
        SELECT res.id AS reservation_id, res.room_number, res.check_in, res.check_out, res.status,
               rm.floor, rm.room_type, rm.price, rm.window_view, rm.additional_info
        FROM reservations res
        JOIN rooms rm ON rm.room_number = res.room_number
        WHERE res.username = %s
        ORDER BY res.check_in DESC;
    """, (username,))
    rented = cur.fetchall()
    cur.close()
    conn.close()

    for item in rented:
        item["check_in"] = item["check_in"].isoformat()
        item["check_out"] = item["check_out"].isoformat()

    return jsonify({
        "exists": True,
        "user": user_row,
        "rented_rooms": rented
    })


@app.route("/api/users", methods=["GET"])
@require_auth(required_role="admin")
def list_all_users():
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    if request.args.get("quick", "false").lower() not in ("true", "1"):
        sync_reservation_states(cur)
        conn.commit()

    cur.execute("""
        SELECT u.id, u.username, u.role, u.passport_number, u.phone,
               COALESCE(
                   json_agg(
                       json_build_object(
                           'reservation_id', r.id,
                           'room_number', r.room_number,
                           'check_in', r.check_in,
                           'check_out', r.check_out,
                           'status', r.status
                       )
                   ) FILTER (WHERE r.id IS NOT NULL AND r.status IN ('upcoming', 'active')),
                   '[]'
               ) AS rented_rooms
        FROM users u
        LEFT JOIN reservations r ON u.username = r.username
        GROUP BY u.id
        ORDER BY u.username;
    """)
    users = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify(users)


# --- ADMIN CREATE/UPDATE ROOM (WITH NULLABLE FIELDS) ---
@app.route("/api/admin/rooms", methods=["POST"])
@require_auth(required_role="admin")
def create_or_update_room():
    data = request.json or {}
    room_number = data.get("room_number")
    if not room_number:
        return jsonify({"error": "room_number is required"}), 400

    floor = data.get("floor", 1)
    room_type = data.get("room_type", "Standard")
    sleeping_places = data.get("sleeping_places", 2)
    pets_allowed = bool(data.get("pets_allowed", False))
    area_sqm = data.get("area_sqm", 25.0)
    price = data.get("price", 100)

    # Nullable handling for window_view and additional_info
    raw_view = data.get("window_view")
    window_view = raw_view.strip() if isinstance(raw_view,
                                                 str) and raw_view.strip() else None

    raw_info = data.get("additional_info")
    if isinstance(raw_info, list):
        cleaned_info = [str(x).strip() for x in raw_info if str(x).strip()]
        additional_info = cleaned_info if len(cleaned_info) > 0 else None
    else:
        additional_info = None

    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO rooms (room_number, floor, room_type, sleeping_places, pets_allowed, area_sqm, window_view, price, additional_info)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (room_number) DO UPDATE SET
            floor = EXCLUDED.floor,
            room_type = EXCLUDED.room_type,
            sleeping_places = EXCLUDED.sleeping_places,
            pets_allowed = EXCLUDED.pets_allowed,
            area_sqm = EXCLUDED.area_sqm,
            window_view = EXCLUDED.window_view,
            price = EXCLUDED.price,
            additional_info = EXCLUDED.additional_info;
    """, (room_number, floor, room_type, sleeping_places, pets_allowed,
          area_sqm, window_view, price, additional_info))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"message": f"Room {room_number} saved successfully!"})


# --- SMART ADMIN BOOKING (CHECKS ROOM, CHECKS USER & SUGGESTS CREATION, CHECKS DATES) ---
@app.route("/api/admin/book", methods=["POST"])
@require_auth(required_role="admin")
def admin_create_reservation():
    data = request.json or {}
    room_number = data.get("room_number")
    target_user = (data.get("username") or "").strip()
    create_new_user = bool(data.get("create_new_user", False))
    check_in_str = data.get("check_in")
    check_out_str = data.get("check_out")

    if not room_number or not target_user:
        return jsonify({"code": "MISSING_FIELDS",
                        "error": "room_number and username are required."}), 400

    try:
        req_in = parse_iso_dt(check_in_str) if check_in_str else datetime.now()
        req_out = parse_iso_dt(
            check_out_str) if check_out_str else datetime.fromtimestamp(
            req_in.timestamp() + 86400)
    except ValueError:
        return jsonify({"code": "INVALID_DATES",
                        "error": "Invalid date format. Use YYYY-MM-DDTHH:MM."}), 400

    if req_out <= req_in:
        return jsonify({"code": "INVALID_DATES",
                        "error": "Check-out must be after check-in."}), 400

    conn = get_db()
    cur = conn.cursor()
    sync_reservation_states(cur, force=True)

    # 1. Verify Room Exists
    cur.execute("SELECT room_number FROM rooms WHERE room_number = %s;",
                (room_number,))
    if not cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({
            "code": "ROOM_NOT_FOUND",
            "error": f"Room #{room_number} does not exist in the database. Create the room first."
        }), 404

    # 2. Verify User Exists (or prompt frontend to create with expanded info)
    cur.execute(
        "SELECT username, passport_number, phone FROM users WHERE username = %s;",
        (target_user,))
    user_row = cur.fetchone()
    if not user_row:
        if not create_new_user:
            cur.close()
            conn.close()
            return jsonify({
                "code": "USER_NOT_FOUND",
                "suggest_create_user": True,
                "username": target_user,
                "error": f"User '{target_user}' does not exist. Would you like to create a new user profile?"
            }), 404

        # Admin confirmed creation: create user with expanded info
        new_password = data.get("password") or "guest123"
        passport = (data.get("passport_number") or "").strip() or None
        phone = (data.get("phone") or "").strip() or None
        cur.execute("""
            INSERT INTO users (username, password_hash, role, passport_number, phone)
            VALUES (%s, %s, 'user', %s, %s);
        """, (target_user, generate_password_hash(new_password), passport,
              phone))
    else:
        # Optional: update passport/phone if admin provided them for an existing user
        passport = (data.get("passport_number") or "").strip()
        phone = (data.get("phone") or "").strip()
        if passport or phone:
            cur.execute("""
                UPDATE users
                SET passport_number = COALESCE(%s, passport_number),
                    phone = COALESCE(%s, phone)
                WHERE username = %s;
            """, (passport or None, phone or None, target_user))

    # 3. Verify Timeframe Availability
    conflicts = check_timeframe_conflicts(cur, room_number, req_in, req_out)
    if conflicts:
        conn.rollback()
        cur.close()
        conn.close()
        return jsonify({
            "code": "TIMEFRAME_UNAVAILABLE",
            "available": False,
            "error": f"Room #{room_number} is already booked or held during that timeframe.",
            "conflicts": conflicts
        }), 409

    # 4. Create the reservation
    status = "active" if req_in <= datetime.now() < req_out else "upcoming"
    cur.execute("""
        INSERT INTO reservations (room_number, username, check_in, check_out, status)
        VALUES (%s, %s, %s, %s, %s) RETURNING id;
    """, (room_number, target_user, req_in, req_out, status))
    res_id = cur.fetchone()[0]

    sync_reservation_states(cur, force=True)
    conn.commit()
    cur.close()
    conn.close()

    # Clear any holds on this room for that user
    cache.delete(f"hold:room:{room_number}:{target_user}")

    return jsonify({
        "code": "BOOKED",
        "message": f"Room #{room_number} reserved for '{target_user}' ({req_in.strftime('%Y-%m-%d %H:%M')} -> {req_out.strftime('%Y-%m-%d %H:%M')}).",
        "reservation_id": res_id,
        "status": status
    })


# --- CANCEL RESERVATION (BY ROOM OR BY SPECIFIC RESERVATION ID) ---
@app.route("/api/admin/cancel/<int:room_num>", methods=["POST"])
@require_auth(required_role="admin")
def admin_cancel_reservation(room_num):
    data = request.json if request.is_json else {}
    res_id = data.get("reservation_id") if data else None

    conn = get_db()
    cur = conn.cursor()
    if res_id:
        cur.execute(
            "UPDATE reservations SET status = 'cancelled' WHERE id = %s AND room_number = %s;",
            (res_id, room_num))
    else:
        cur.execute(
            "UPDATE reservations SET status = 'cancelled' WHERE room_number = %s AND status IN ('upcoming', 'active');",
            (room_num,))

    sync_reservation_states(cur, force=True)
    conn.commit()
    cur.close()
    conn.close()

    for key in cache.scan_iter(f"hold:room:{room_num}:*"):
        cache.delete(key)

    return jsonify(
        {"message": f"Reservation(s) for Room #{room_num} cancelled."})


# --- PAYMENTS LIST ENDPOINT ---
@app.route("/api/admin/payments", methods=["GET"])
@require_auth(required_role="admin")
def get_all_payments():
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("""
        SELECT transaction_id, reservation_id, username, room_number,
               amount, currency, provider, card_last4, status, paid_at
        FROM payments
        ORDER BY paid_at DESC;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    for r in rows:
        r["amount"] = float(r["amount"])
        r["paid_at"] = r["paid_at"].isoformat()
    return jsonify(rows)


# --- 1. EXPORT ROOMS CSV ---
@app.route("/api/admin/export/rooms", methods=["GET"])
@require_auth(required_role="admin")
def export_rooms_csv():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT room_number, floor, room_type, sleeping_places, pets_allowed,
               area_sqm, window_view, price, additional_info
        FROM rooms ORDER BY room_number;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "room_number", "floor", "room_type", "sleeping_places",
        "pets_allowed", "area_sqm", "window_view", "price", "additional_info"
    ])
    for r in rows:
        info_str = "|".join(r[8]) if r[8] else ""
        writer.writerow([
            r[0], r[1], r[2], r[3],
            "true" if r[4] else "false",
            float(r[5]) if r[5] else 0.0,
            r[6] or "",
            r[7],
            info_str
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=rooms_export.csv"}
    )


# --- 2. IMPORT ROOMS CSV (MASS CREATE / UPDATE) ---
@app.route("/api/admin/import/rooms", methods=["POST"])
@require_auth(required_role="admin")
def import_rooms_csv():
    if "file" not in request.files:
        return jsonify({"error": "No CSV file uploaded"}), 400

    file = request.files["file"]
    content = file.stream.read().decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    conn = get_db()
    cur = conn.cursor()
    count = 0

    try:
        for row in reader:
            if not row.get("room_number"):
                continue
            room_number = int(row["room_number"])
            floor = int(row.get("floor") or 1)
            room_type = (row.get("room_type") or "Standard").strip()
            sleeping_places = int(row.get("sleeping_places") or 2)
            pets_allowed = str(row.get("pets_allowed", "")).strip().lower() in (
                "true", "1", "yes")
            area_sqm = float(row.get("area_sqm") or 25.0)
            window_view = (row.get("window_view") or "").strip() or None
            price = int(float(row.get("price") or 100))

            raw_info = (row.get("additional_info") or "").strip()
            # Supports pipe-separated (Wi-Fi|TV) or comma-separated values
            sep = "|" if "|" in raw_info else ","
            info_list = [x.strip() for x in raw_info.split(sep) if
                         x.strip()] if raw_info else None

            cur.execute("""
                INSERT INTO rooms (room_number, floor, room_type, sleeping_places, pets_allowed, area_sqm, window_view, price, additional_info)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (room_number) DO UPDATE SET
                    floor = EXCLUDED.floor,
                    room_type = EXCLUDED.room_type,
                    sleeping_places = EXCLUDED.sleeping_places,
                    pets_allowed = EXCLUDED.pets_allowed,
                    area_sqm = EXCLUDED.area_sqm,
                    window_view = EXCLUDED.window_view,
                    price = EXCLUDED.price,
                    additional_info = EXCLUDED.additional_info;
            """, (room_number, floor, room_type, sleeping_places, pets_allowed,
                  area_sqm, window_view, price, info_list))
            count += 1

        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"CSV import failed: {str(e)}"}), 400
    finally:
        cur.close()
        conn.close()

    return jsonify(
        {"message": f"Successfully imported/updated {count} rooms from CSV!"})


# --- 3. EXPORT PAYMENTS CSV ---
@app.route("/api/admin/export/payments", methods=["GET"])
@require_auth(required_role="admin")
def export_payments_csv():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT transaction_id, reservation_id, username, room_number,
               amount, currency, provider, card_last4, status, paid_at
        FROM payments ORDER BY paid_at DESC;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "transaction_id", "reservation_id", "username", "room_number",
        "amount", "currency", "provider", "card_last4", "status", "paid_at"
    ])
    for r in rows:
        writer.writerow(
            [r[0], r[1], r[2], r[3], float(r[4]), r[5], r[6], r[7], r[8],
             r[9].isoformat()])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=payments_export.csv"}
    )


# --- 4. EXPORT USERS CSV ---
@app.route("/api/admin/export/users", methods=["GET"])
@require_auth(required_role="admin")
def export_users_csv():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT u.id, u.username, u.role, u.passport_number, u.phone,
               COUNT(r.id) FILTER (WHERE r.status IN ('upcoming', 'active')) AS active_bookings
        FROM users u
        LEFT JOIN reservations r ON u.username = r.username
        GROUP BY u.id
        ORDER BY u.id;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "username", "role", "passport_number", "phone",
                     "active_bookings"])
    for r in rows:
        writer.writerow([r[0], r[1], r[2], r[3] or "", r[4] or "", r[5]])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=users_export.csv"}
    )

@app.route("/api/admin/import/users", methods=["POST"])
@require_auth(required_role="admin")
def import_users_csv():
    if "file" not in request.files:
        return jsonify({"error": "No CSV file uploaded"}), 400

    file = request.files["file"]
    content = file.stream.read().decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(content))

    conn = get_db()
    cur = conn.cursor()
    count = 0

    try:
        for row in reader:
            username = (row.get("username") or "").strip()
            if not username:
                continue

            role = (row.get("role") or "user").strip()
            if role not in ("user", "admin"):
                role = "user"

            passport = (row.get("passport_number") or "").strip() or None
            phone = (row.get("phone") or "").strip() or None
            raw_password = (row.get("password") or "").strip()
            default_hash = generate_password_hash(raw_password if raw_password else "guest123")

            if raw_password:
                # If a 'password' column was provided and non-empty, update password too
                cur.execute("""
                    INSERT INTO users (username, password_hash, role, passport_number, phone)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (username) DO UPDATE SET
                        password_hash = EXCLUDED.password_hash,
                        role = EXCLUDED.role,
                        passport_number = EXCLUDED.passport_number,
                        phone = EXCLUDED.phone;
                """, (username, default_hash, role, passport, phone))
            else:
                # Otherwise preserve existing password_hash for existing users
                cur.execute("""
                    INSERT INTO users (username, password_hash, role, passport_number, phone)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (username) DO UPDATE SET
                        role = EXCLUDED.role,
                        passport_number = EXCLUDED.passport_number,
                        phone = EXCLUDED.phone;
                """, (username, default_hash, role, passport, phone))

            count += 1

        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({"error": f"Users CSV import failed: {str(e)}"}), 400
    finally:
        cur.close()
        conn.close()

    return jsonify({"message": f"Successfully imported/updated {count} users from CSV!"})


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
