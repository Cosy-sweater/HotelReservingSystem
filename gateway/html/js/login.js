let SHOW_REG_WINDOW = false;

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
        window.location.href = data.role === "admin" ? "/admin" : "/";
    } else {
        error_message.textContent = data.error;
    }
}

async function register() {
    if (!SHOW_REG_WINDOW) {
        SHOW_REG_WINDOW = true
        document.getElementById("reg-window").style.display = "flex";
        return;
    }
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const passport = document.getElementById("passport-number").value;
    const phone = document.getElementById("phone").value;
    const res = await fetch("/auth/register", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({username, password, passport, phone})
    });
    const data = await res.json();
    if (res.ok) {
        window.location.href = "/";
    } else {
        error_message.textContent = data.error;
    }
}

function revealPassword() {
  var x = document.getElementById("password");
  if (x.type === "password") {
    x.type = "text";
  } else {
    x.type = "password";
  }
}

function revealPassport() {
  var x = document.getElementById("passport-number");
  if (x.type === "password") {
    x.type = "text";
  } else {
    x.type = "password";
  }
}


revealPassword(); revealPassword();
revealPassport(); revealPassport();