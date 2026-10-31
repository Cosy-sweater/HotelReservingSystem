error_message = document.getElementsByClassName("error-message")[0];
document.querySelectorAll("input").forEach((inputElement) => {
    inputElement.addEventListener("click", () => {
        error_message.textContent = "";
    });
});

async function login() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const res = await fetch("/auth/login", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({username, password})
    });
    const data = await res.json();
    if (res.ok) {
        // Server already set the HttpOnly cookie! Redirect based on role:
        window.location.href = data.role === "admin" ? "/admin" : "/";
    } else {
        error_message.textContent = data.error;
    }
}

async function register() {
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const res = await fetch("/auth/register", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({username, password})
    });
    const data = await res.json();
    if (res.ok) {
        // Cookie is already set by /auth/register — go straight to Guest Portal!
        window.location.href = "/";
    } else {
        error_message.textContent = data.error;
    }
}

