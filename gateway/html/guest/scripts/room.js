const params = new URLSearchParams(window.location.search);
const roomNumber = parseInt(params.get("id"));
let currentUser = null;
let datesInitialized = false;
let lockedMinISO = null;
let lastFreeFromISO = undefined;

if (!roomNumber) window.location.href = "/";

const toLocalISO = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
};

function applyDateBounds(earliestFreeISO) {
    const inInput = document.getElementById("check_in");
    const outInput = document.getElementById("check_out");

    const now = new Date();
    const maxDate = new Date(now);
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    const maxStr = toLocalISO(maxDate);

    // Lock baseline 'now' once on page load so it never ticks up every minute
    if (!lockedMinISO) {
        lockedMinISO = toLocalISO(now);
    }

    // If room is booked/held, use its exact check_out (earliestFreeISO); otherwise use page-load time
    const minStr = earliestFreeISO || lockedMinISO;
    inInput.min = minStr;
    inInput.max = maxStr;
    outInput.max = maxStr;

    // Only update input values on initial page load or if the room's free_from state actually changed
    if (!datesInitialized || lastFreeFromISO !== earliestFreeISO) {
        const paramIn = params.get("in");
        const startVal = (!datesInitialized && paramIn && paramIn >= minStr) ? paramIn : minStr;

        if (!datesInitialized || inInput.value < minStr) {
            inInput.value = startVal;
        }

        const nextDay = new Date(new Date(inInput.value).getTime() + 86400000);
        const paramOut = params.get("out");
        outInput.min = inInput.value;

        if (!datesInitialized) {
            outInput.value = (paramOut && paramOut > inInput.value) ? paramOut : toLocalISO(nextDay);
        } else if (outInput.value <= inInput.value) {
            outInput.value = toLocalISO(nextDay);
        }

        datesInitialized = true;
        lastFreeFromISO = earliestFreeISO;
    }

    const enforce = () => {
        if (inInput.value < minStr) inInput.value = minStr;
        if (inInput.value > maxStr) inInput.value = maxStr;
        outInput.min = inInput.value;
        if (outInput.value <= inInput.value) {
            const plusOneDay = new Date(new Date(inInput.value).getTime() + 86400000);
            outInput.value = toLocalISO(plusOneDay);
        }
        if (outInput.value > maxStr) outInput.value = maxStr;
    };

    inInput.onchange = enforce;
    outInput.onchange = enforce;
}

async function init() {
    currentUser = await getCurrentUser();
    if (!currentUser) {
        window.location.href = "/login";
        return;
    }
    await loadRoom(false);
    setInterval(() => loadRoom(true), 3000);
}

async function loadRoom(quick = false) {
    try {
        const res = await fetch(`/api/rooms${quick ? '?quick=true' : ''}`);
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) return;

        const rooms = await res.json();
        const r = rooms.find(item => item.room_number === roomNumber);
        if (!r) {
            document.getElementById("room-box").innerHTML = "<h2>Room not found</h2>";
            return;
        }

        // Lock date picker minimum to exact checkout date (or page load time if free now)
        applyDateBounds(r.free_from);

        const isFreeRightNow = !r.free_from;
        const formattedFreeTime = r.free_from ? r.free_from.replace("T", " ") : "Right Now";

        const tagsHtml = Array.isArray(r.additional_info) && r.additional_info.length
            ? r.additional_info.map(t => `<span class="tag">${t}</span>`).join("")
            : `<i>None</i>`;

        document.getElementById("room-box").innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <h1 style="margin:0;">Номер №${r.room_number} — ${r.room_type} (${r.area_sqm} m²)</h1>
                            <p style="color:#475569;">${r.floor} этаж | ${r.sleeping_places} спальных мест | Вид: ${r.window_view ?? 'Standard'} | ${r.pets_allowed ? 'Можно с питомцами' : 'Без питомцев'}</p>
                        </div>
                        <div style="font-size:1.5rem; font-weight:800;">$${r.price}<small style="font-size:0.85rem; color:#64748b;">/night</small></div>
                    </div>
                    <div><b>Дополнительные удобства:</b><br/>${tagsHtml}</div>
                    <div class="free-banner ${isFreeRightNow ? 'free-now' : 'free-later'}">
                        ${isFreeRightNow
            ? `Номер доступна`
            : `Номер освободится после: <b>${formattedFreeTime}</b>`
        }
                    </div>
                `;

        const myHold = (r.holds || []).find(h => h.username === currentUser.username);
        const actionArea = document.getElementById("action-area");

        if (myHold) {
            // Preserve user input in payment fields across 3-second polling cycles
            const prevProvider = document.getElementById("pay_provider")?.value || "Stripe";
            const prevCard = document.getElementById("pay_card")?.value || "4242424242424242";

            actionArea.innerHTML = `
                        <div style="background:#f0fdf4; border:1px solid #86efac; padding:14px; border-radius:8px;">
                            <p style="color:#15803d; font-weight:600; margin:0 0 10px 0;">
                                Комната забронирована для оплаты (${myHold.ttl}с осталось): ${myHold.check_in.slice(0, 16).replace('T', ' ')} &rarr; ${myHold.check_out.slice(0, 16).replace('T', ' ')}
                            </p>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                                <div>
                                    <label style="font-size:0.8rem; font-weight:600;">Payment Service</label>
                                    <select id="pay_provider">
                                        <option value="Stripe" ${prevProvider === 'Stripe' ? 'selected' : ''}>Stripe</option>
                                        <option value="YooKassa" ${prevProvider === 'YooKassa' ? 'selected' : ''}>YooKassa</option>
                                        <option value="CloudPayments" ${prevProvider === 'CloudPayments' ? 'selected' : ''}>CloudPayments</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:0.8rem; font-weight:600;">Card Number</label>
                                    <input id="pay_card" placeholder="4242 •••• •••• 4242" value="${prevCard}" />
                                </div>
                            </div>
                            <button class="pay-btn" onclick="completePayment()">Pay & Confirm Booking</button>
                        </div>
                    `;
        } else {
            actionArea.innerHTML = `<button onclick="holdRoom()">Оформить оплату</button>`;
        }
    } catch (err) {
        console.warn("Temporary network glitch:", err);
    }
}

async function holdRoom() {
    const conflictBox = document.getElementById("conflict-box");
    conflictBox.style.display = "none";

    const res = await fetch(`/api/hold/${roomNumber}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            check_in: document.getElementById("check_in").value,
            check_out: document.getElementById("check_out").value
        })
    });
    const data = await res.json();

    if (!res.ok) {
        conflictBox.style.display = "block";
        conflictBox.innerHTML = `<b>${data.error}</b>` + (data.conflicts
            ? `<ul>` + data.conflicts.map(c => `<li>${c.type.toUpperCase()}: ${c.check_in.slice(0, 16).replace('T', ' ')} &rarr; ${c.check_out.slice(0, 16).replace('T', ' ')}</li>`).join("") + `</ul>`
            : "");
        return;
    }
    loadRoom(false);
}

async function completePayment() {
    const provider = document.getElementById("pay_provider")?.value || "Stripe";
    const card_number = document.getElementById("pay_card")?.value || "4242";
    const res = await fetch(`/api/pay/${roomNumber}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({provider, card_number})
    });
    const data = await res.json();
    alert(data.message || data.error);
    if (res.ok) window.location.href = "/";
}

// Always formats a Date as local "YYYY-MM-DDTHH:00" (minutes stripped)
const toLocalHourISO = (date) => {
    const d = new Date(date);
    d.setMinutes(0, 0, 0); // Strip minutes, seconds, milliseconds
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 13) + ":00";
};

// Rounds UP to the next whole hour for "right now" so the minimum isn't in the past
const getCurrentNextHourISO = () => {
    const now = new Date();
    if (now.getMinutes() > 0 || now.getSeconds() > 0) {
        now.setHours(now.getHours() + 1);
    }
    return toLocalHourISO(now);
};

const enforce = () => {
    // 1. Force check-in minutes to :00
    if (inInput.value) {
        inInput.value = inInput.value.slice(0, 13) + ":00";
    }
    if (inInput.value < minStr) inInput.value = minStr;
    if (inInput.value > maxStr) inInput.value = maxStr;

    // 2. Minimum rental is 1 hour (+3,600,000 ms) after Check-In
    const minCheckOutDate = new Date(new Date(inInput.value).getTime() + 3600000);
    const minOutStr = toLocalHourISO(minCheckOutDate);
    outInput.min = minOutStr;

    // 3. Force check-out minutes to :00 and ensure it is >= Check-In + 1 hour
    if (outInput.value) {
        outInput.value = outInput.value.slice(0, 13) + ":00";
    }
    if (!outInput.value || outInput.value < minOutStr) {
        outInput.value = minOutStr;
    }
    if (outInput.value > maxStr) outInput.value = maxStr;
};

init();