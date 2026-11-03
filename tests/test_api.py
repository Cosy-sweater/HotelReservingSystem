import pytest
import requests
import os

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8080")


def test_gateway_health_and_admin_block():
    """Verify unauthenticated access to /admin redirects to /login (HTTP 302)"""
    response = requests.get(f"{BASE_URL}/admin/", allow_redirects=False)
    assert response.status_code == 302
    assert "/login" in response.headers.get("Location", "")


def test_user_registration_and_login():
    """Verify Point 2: Registration, Authorization, and Session Cookie creation"""
    test_user = "ci_test_user_99"
    test_pass = "SecurePass123!"

    # 1. Register new user
    reg_res = requests.post(f"{BASE_URL}/auth/register", json={
        "username": test_user,
        "password": test_pass,
        "passport_number": "AB1234567",
        "phone": "+37060000000"
    })
    # Might return 200/201 or 409 if user already ran once
    assert reg_res.status_code in (200, 201, 409)

    # 2. Login
    login_res = requests.post(f"{BASE_URL}/auth/login", json={
        "username": test_user,
        "password": test_pass
    })
    assert login_res.status_code == 200
    assert "session_id" in login_res.cookies

    # 3. Verify /auth/me session check using the cookie
    session_cookie = {"session_id": login_res.cookies["session_id"]}
    me_res = requests.get(f"{BASE_URL}/auth/me", cookies=session_cookie)
    assert me_res.status_code == 200
    assert me_res.json().get("username") == test_user


def test_room_catalog_and_holding():
    """Verify Point 2: Room listing and holding workflow"""
    # Login as admin or test user to get session
    login_res = requests.post(f"{BASE_URL}/auth/login", json={
        "username": "ci_test_user_99",
        "password": "SecurePass123!"
    })
    cookies = {"session_id": login_res.cookies.get("session_id")}

    # Get rooms catalog
    rooms_res = requests.get(f"{BASE_URL}/api/rooms", cookies=cookies)
    assert rooms_res.status_code == 200
    rooms = rooms_res.json()
    assert isinstance(rooms, list)
    if len(rooms) > 0:
        room_num = rooms[0]["room_number"]

        # Try holding the room
        hold_res = requests.post(f"{BASE_URL}/api/hold/{room_num}",
                                 cookies=cookies, json={
                "check_in": "2026-12-01T14:00",
                "check_out": "2026-12-03T11:00"
            })
        assert hold_res.status_code in (200, 409)