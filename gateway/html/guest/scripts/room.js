const params = new URLSearchParams(window.location.search);
const roomNumber = parseInt(params.get("id"));
let currentUser = null;
let currentRoom = null;
let dateController = null;
let renderedState = null;

if (!roomNumber) window.location.href = "/";

// Updates both the top estimate bar AND the payment popup invoice from the current input values
function syncAllPriceDisplays() {
    if (!currentRoom) return;
    const inVal = document.getElementById("check_in").value;
    const outVal = document.getElementById("check_out").value;
    const hours = calculateRentedHours(inVal, outVal);
    const total = (hours * currentRoom.price).toFixed(2);
    const timeframeStr = `${inVal.slice(0, 16).replace("T", " ")} → ${outVal.slice(0, 16).replace("T", " ")}`;

    document.getElementById("est-hours").textContent = `${hours} часов`;
    document.getElementById("est-total").textContent = `${total} рублей`;

    if (renderedState === "payment_form") {
        const tfEl = document.getElementById("inv-timeframe");
        const hrEl = document.getElementById("inv-hours");
        const totEl = document.getElementById("inv-total");
        const btnEl = document.getElementById("pay-btn-label");
        if (tfEl) tfEl.textContent = timeframeStr;
        if (hrEl) hrEl.textContent = `${hours} ч * ${currentRoom.price} Руб/ч`;
        if (totEl) totEl.textContent = `${total} рублей`;
        if (btnEl) btnEl.textContent = `Оплатить ${total} рублей (${hours}часов)`;
    }
}

async function init() {
    currentUser = await getCurrentUser();
    if (!currentUser) {
        window.location.href = "/login";
        return;
    }

    await loadRoom();
    setInterval(loadRoom, 4000);
}

async function loadRoom() {
    try {
        const res = await fetch("/api/rooms");
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
        currentRoom = r;
        const myHold = (r.holds || []).find(h => h.username === currentUser.username);

        // Do NOT use r.free_from as minISO if the room is currently held by this user,
        // otherwise r.free_from equals myHold.check_out and resets the user's selected dates!
        const effectiveMinISO = myHold ? null : r.free_from;

        if (!dateController) {
            dateController = setupHourlyDateInputs("check_in", "check_out", {
                minISO: effectiveMinISO,
                initialIn: myHold ? myHold.check_in : params.get("in"),
                initialOut: myHold ? myHold.check_out : params.get("out"),
                defaultDurationHours: 1,
                onChange: syncAllPriceDisplays
            });
        } else if (!myHold) {
            // Only push min forward if the user does NOT have an active hold
            dateController.updateMin(r.free_from);
        }

        renderRoomHeaderInPlace(r);
        renderActionAreaInPlace(r, myHold);
        syncAllPriceDisplays();
    } catch (err) {
        console.warn("Temporary poll error:", err);
    }
}

function renderRoomHeaderInPlace(r) {
    const isFreeRightNow = !r.free_from;
    const formattedFreeTime = r.free_from ? r.free_from.replace("T", " ") : "Сейчас";
    const bannerText = isFreeRightNow
        ? "Номер свободен"
        : `Номер освободится после <b>${formattedFreeTime}</b>`;
    const bannerClass = `free-banner ${isFreeRightNow ? 'free-now' : 'free-later'}`;

    const existingBanner = document.getElementById("free-status-banner");
    if (existingBanner) {
        existingBanner.className = bannerClass;
        if (existingBanner.innerHTML !== bannerText) {
            existingBanner.innerHTML = bannerText;
        }
        return;
    }

    const tagsHtml = Array.isArray(r.additional_info) && r.additional_info.length
        ? r.additional_info.map(t => `<span class="tag">${t}</span>`).join("")
        : `<i>Нет</i>`;

    document.getElementById("room-box").innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <div>
                        <h1 style="margin:0;">Номер ${r.room_number}: ${r.room_type}</h1>
                        <p style="color:#344251;">${r.floor} этаж  |  ${r.area_sqm} м²  |  ${r.sleeping_places} спальных мест  |  Вид: ${r.window_view ?? 'Обычный'}  |  ${r.pets_allowed ? 'Можно с питомцами' : 'Нельзя с питомцами'}</p>
                    </div>
                    <div style="font-size:1.5rem; font-weight:500; color:#15803d;">${r.price} рублей<small>/час</small></div>
                </div>
                <div><b>Amenities:</b><br/>${tagsHtml}</div>
                <div id="free-status-banner" class="${bannerClass}">${bannerText}</div>
            `;
}

function renderActionAreaInPlace(r, myHold) {
    const actionArea = document.getElementById("action-area");

    if (myHold) {
        if (renderedState === "payment_form") {
            const ttlEl = document.getElementById("hold-ttl-display");
            if (ttlEl) ttlEl.textContent = `${myHold.ttl}s`;
            return;
        }

        renderedState = "payment_form";
        actionArea.innerHTML = `
                    <div class="payment-popup">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <h4 style="margin:0; color:#15803d;">Комната забронирована для оплаты</h4>
                            <span style="background:#dcfce7; color:#15803d; padding:4px 10px; border-radius:999px; font-size:0.85rem; font-weight:700;">
                                Осталось <span id="hold-ttl-display">${myHold.ttl}s</span>
                            </span>
                        </div>

                        <div class="invoice-box">
                            <div class="invoice-row">
                                <span>Номер:</span>
                                <b>#${r.room_number} (${r.room_type})</b>
                            </div>
                            <div class="invoice-row">
                                <span>Даты:</span>
                                <b id="inv-timeframe"></b>
                            </div>
                            <div class="invoice-row">
                                <span>Срок и стоимость:</span>
                                <span id="inv-hours"></span>
                            </div>
                            <div class="invoice-row invoice-total">
                                <span>Всего к оплате:</span>
                                <span id="inv-total"></span>
                            </div>
                        </div>

                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                            <div>
                                <label style="font-size:0.8rem; font-weight:600;">Оплата через</label>
                                <select id="pay_provider">
                                    <option value="Stripe">Stripe</option>
                                    <option value="ЮКасса">ЮКасса</option>
                                    <option value="СБП">СБП</option>
                                </select>
                            </div>
                            <div>
                                <label style="font-size:0.8rem; font-weight:600;">Имя владельца</label>
                                <input id="pay_holder" placeholder="IVAN IVANOV" />
                            </div>
                            <div>
                                <label style="font-size:0.8rem; font-weight:600;">Номер карты</label>
                                <input id="pay_card" placeholder="0000 0000 0000 0000" maxlength="19" />
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                                <div>
                                    <label style="font-size:0.8rem; font-weight:600;">Действует до</label>
                                    <input id="pay_exp" placeholder="MM/YY" maxlength="5" />
                                </div>
                                <div>
                                    <label style="font-size:0.8rem; font-weight:600;">CVV</label>
                                    <input id="pay_cvv" placeholder="123" maxlength="4" />
                                </div>
                            </div>
                        </div>

                        <button class="pay-btn" id="pay-btn-label" onclick="completePayment()">
                            Оплатить
                        </button>
                    </div>
                `;
    } else {
        if (renderedState !== "hold_btn") {
            renderedState = "hold_btn";
            actionArea.innerHTML = `<button onclick="holdRoom()">Перейти к оплате</button>`;
        }
    }
}

async function holdRoom() {
    if (dateController) dateController.triggerEnforce();
    const conflictBox = document.getElementById("conflict-box");
    conflictBox.style.display = "none";

    const checkInVal = document.getElementById("check_in").value;
    const checkOutVal = document.getElementById("check_out").value;

    const res = await fetch(`/api/hold/${roomNumber}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            check_in: checkInVal,
            check_out: checkOutVal
        })
    });
    const data = await safeJson(res);

    if (!res.ok) {
        conflictBox.style.display = "block";
        conflictBox.innerHTML = `<b>${data.error}</b>` + (data.conflicts
            ? `<ul>` + data.conflicts.map(c => `<li>${c.type.toUpperCase()}: ${c.check_in.slice(0, 16).replace('T', ' ')} &rarr; ${c.check_out.slice(0, 16).replace('T', ' ')}</li>`).join("") + `</ul>`
            : "");
        return;
    }
    await loadRoom();
}

async function completePayment() {
    if (dateController) dateController.triggerEnforce();
    const provider = document.getElementById("pay_provider")?.value || "Stripe Sandbox";
    const card_number = document.getElementById("pay_card")?.value || "4242";
    const check_in = document.getElementById("check_in").value;
    const check_out = document.getElementById("check_out").value;

    const res = await fetch(`/api/pay/${roomNumber}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({provider, card_number, check_in, check_out})
    });
    const data = await safeJson(res);
    if (!res.ok) {
        alert(data.error || "Payment failed");
        return;
    }
    alert(
        `${data.message}\n` +
        `Оплаченные даты: ${data.check_in.slice(0, 16).replace('T', ' ')} -> ${data.check_out.slice(0, 16).replace('T', ' ')} (${data.hours}h)\n` +
        `Всего: ${data.total_amount.toFixed(2)} ${data.currency}`
    );
    window.location.href = "/";
}

init();