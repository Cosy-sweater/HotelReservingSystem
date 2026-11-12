import time
import requests

BASE = "http://127.0.0.1:8080"


def test_admin_protected():
    r = requests.get(f"{BASE}/admin/", allow_redirects=False)
    assert r.status_code in (302, 401, 403)


def test_register_login_and_book():
    s = requests.Session()
    user = f"u_{int(time.time())}"

    reg = s.post(f"{BASE}/auth/register", json={
        "username": user,
        "password": "password123",
        "passport": "AB12345",
        "passport_number": "AB12345",
        "phone": "123456789"
    })
    assert reg.status_code in (200, 201)

    login = s.post(f"{BASE}/auth/login", json={
        "username": user,
        "password": "password123"
    })
    assert login.status_code == 200

    rooms = s.get(f"{BASE}/api/rooms")
    assert rooms.status_code == 200

    hold = s.post(f"{BASE}/api/hold/101", json={})
    assert hold.status_code in (200, 409)