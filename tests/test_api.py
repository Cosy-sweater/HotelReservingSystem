from datetime import datetime, timedelta
import requests

BASE_URL = "http://127.0.0.1:8080"


def test_admin_redirect():
    res = requests.get(f"{BASE_URL}/admin/", allow_redirects=False)
    assert res.status_code in (302, 401)


def test_auth_and_booking_flow():
    session = requests.Session()
    username = f"user_{int(datetime.now().timestamp())}"

    # 1. Register
    reg = session.post(f"{BASE_URL}/auth/register", json={
        "username": username,
        "password": "TestPassword123",
        "passport_number": "AB123456",
        "phone": "+37060000000"
    })
    assert reg.status_code == 200

    # 2. Login
    login = session.post(f"{BASE_URL}/auth/login", json={
        "username": username,
        "password": "TestPassword123"
    })
    assert login.status_code == 200
    assert "session_id" in session.cookies

    # 3. Get rooms
    rooms = session.get(f"{BASE_URL}/api/rooms")
    assert rooms.status_code == 200
    assert len(rooms.json()) > 0

    # 4. Hold and book room 101 for 2 hours in the future
    start_dt = (datetime.now() + timedelta(days=10)).replace(minute=0, second=0, microsecond=0)
    end_dt = start_dt + timedelta(hours=2)
    check_in = start_dt.strftime("%Y-%m-%dT%H:00")
    check_out = end_dt.strftime("%Y-%m-%dT%H:00")

    hold = session.post(f"{BASE_URL}/api/hold/101", json={
        "check_in": check_in,
        "check_out": check_out
    })
    assert hold.status_code == 200

    pay = session.post(f"{BASE_URL}/api/pay/101", json={
        "provider": "Stripe Sandbox",
        "card_number": "4242424242424242",
        "check_in": check_in,
        "check_out": check_out
    })
    assert pay.status_code == 200
    assert pay.json().get("status") in ("upcoming", "active")