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
                            <h1 style="margin:0;">Room #${r.room_number} — ${r.room_type} (${r.area_sqm} m²)</h1>
                            <p style="color:#475569;">Floor ${r.floor} | 🛏️ ${r.sleeping_places} Beds | 🪟 ${r.window_view ?? 'Standard'} | ${r.pets_allowed ? '🐾 Pets Allowed' : '🚫 No Pets'}</p>
                        </div>
                        <div style="font-size:1.5rem; font-weight:800; color:#15803d;">$${r.price}<small style="font-size:0.85rem; color:#64748b;">/night</small></div>
                    </div>
                    <div><b>Amenities:</b><br/>${tagsHtml}</div>
                    <div class="free-banner ${isFreeRightNow ? 'free-now' : 'free-later'}">
                        ${isFreeRightNow
            ? `✅ Available right now!`
            : `⏳ Reserved — Free from: <b>${formattedFreeTime}</b> (Set as minimum check-in)`
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
                                🔒 Room held for you (${myHold.ttl}s remaining): ${myHold.check_in.slice(0, 16).replace('T', ' ')} &rarr; ${myHold.check_out.slice(0, 16).replace('T', ' ')}
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
            actionArea.innerHTML = `<button onclick="holdRoom()">Hold Room for Selected Dates (10 Min Lock)</button>`;
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

init();