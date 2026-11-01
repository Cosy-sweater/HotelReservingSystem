let allRooms = [];

// Set default filter timeframe: Now -> Tomorrow
function setDefaultDates() {

    const toLocalISO = (date) => {
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    };

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000); // Default check-out: +1 day

    const maxDate = new Date(now);
    maxDate.setFullYear(maxDate.getFullYear() + 1);

    const minStr = toLocalISO(now);
    const tomorrowStr = toLocalISO(tomorrow);
    const maxStr = toLocalISO(maxDate);

    const inInput = document.getElementById("f_in") || document.getElementById("check_in") || document.getElementById("book_in");
    const outInput = document.getElementById("f_out") || document.getElementById("check_out") || document.getElementById("book_out");

    if (!inInput || !outInput) return;

    inInput.min = minStr;
    inInput.max = maxStr;

    outInput.min = minStr;
    outInput.max = maxStr;

    inInput.value = minStr;
    outInput.value = tomorrowStr;

    const enforceBounds = () => {
        if (inInput.value < minStr) inInput.value = minStr;
        if (inInput.value > maxStr) inInput.value = maxStr;

        outInput.min = inInput.value || minStr;
        if (outInput.value < outInput.min) outInput.value = outInput.min;
        if (outInput.value > maxStr) outInput.value = maxStr;
    };

    inInput.addEventListener("change", enforceBounds);
    outInput.addEventListener("change", enforceBounds);
}

async function init() {
    setDefaultDates();
    const user = await getCurrentUser();
    if (!user) {
        window.location.href = "/login";
        return;
    }
    document.getElementById("user-display").textContent = user.username;
    if (user.role === "admin") {
        document.getElementById("admin-btn").style.display = "inline-block";
    }

    await fetchRooms(false);
}

async function fetchRooms(quick = false) {
    try {
        const res = await fetch(`/api/rooms${quick ? '?quick=true' : ''}`);
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) return;
        allRooms = await res.json();
        renderRooms();
    } catch (err) {
        console.warn("Room fetching error:", err);
    }
}


function getAvailabilityState(room, filterIn, filterOut) {
    const reqIn = filterIn ? new Date(filterIn) : new Date();
    const reqOut = filterOut ? new Date(filterOut) : new Date(reqIn.getTime() + 86400000);

    const overlappingRes = (room.reservations || []).find(res => {
        const rIn = new Date(res.check_in);
        const rOut = new Date(res.check_out);
        return rIn < reqOut && rOut > reqIn;
    });
    if (overlappingRes || (!filterIn && room.is_booked)) {
        return {rank: 2, label: "Забронировано", css: "status-booked"};
    }

    const overlappingHold = (room.holds || []).find(hold => {
        const hIn = new Date(hold.check_in);
        const hOut = new Date(hold.check_out);
        return hIn < reqOut && hOut > reqIn;
    });
    if (overlappingHold) {
        return {
            rank: 1,
            label: `Held (${overlappingHold.ttl}s)`,
            css: "status-held"
        };
    }

    return {rank: 0, label: "Свободно", css: "status-available"};
}

function renderRooms() {
    const filterIn = document.getElementById("f_in").value;
    const filterOut = document.getElementById("f_out").value;
    const minBeds = parseInt(document.getElementById("f_beds").value) || 0;
    const maxPrice = parseFloat(document.getElementById("f_price").value) || Infinity;
    const search = document.getElementById("f_search").value.trim().toLowerCase();
    const petsOnly = document.getElementById("f_pets").checked;
    const availOnly = document.getElementById("f_avail_only").checked;
    const sortMode = document.getElementById("f_sort").value;

    const filtered = allRooms
        .map(r => ({
            ...r,
            _avail: getAvailabilityState(r, filterIn, filterOut)
        }))
        .filter(r => {
            if (r.sleeping_places < minBeds) return false;
            if (r.price > maxPrice) return false;
            if (petsOnly && !r.pets_allowed) return false;
            if (availOnly && r._avail.rank !== 0) return false;

            if (search) {
                const haystack = [
                    `room ${r.room_number}`,
                    r.room_type,
                    r.window_view || "",
                    ...(r.additional_info || [])
                ].join(" ").toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        });

    filtered.sort((a, b) => {
        if (a._avail.rank !== b._avail.rank) {
            return a._avail.rank - b._avail.rank;
        }
        if (sortMode === "price_asc") return a.price - b.price;
        if (sortMode === "price_desc") return b.price - a.price;
        if (sortMode === "area_desc") return b.area_sqm - a.area_sqm;
        return a.room_number - b.room_number;
    });

    const container = document.getElementById("rooms-container");
    if (filtered.length === 0) {
        container.innerHTML = `<p class="label-no-rooms">Не найдены комнаты по заданным критериями.</p>`;
        return;
    }

    const queryDates = `in=${encodeURIComponent(filterIn)}&out=${encodeURIComponent(filterOut)}`;

    // 3. Render Cards
    container.innerHTML = filtered.map(r => {
        const isAvailable = r._avail.rank === 0;
        const infoList = Array.isArray(r.additional_info) && r.additional_info.length > 0
            ? r.additional_info.map(tag => `<span class="info-tag">${tag}</span>`).join("")
            : `<span style="font-size:0.8rem; color:#94a3b8;">No extra amenities listed</span>`;

        return `
                    <a href="/room?id=${r.room_number}&${queryDates}">
                        <div class="room-card ${isAvailable ? '' : 'unavailable'}">
                            <div style="flex:1;">
                                <div class="room-header">
                                    <h3 class="room-title">Комната #${r.room_number} — ${r.room_type}</h3>
                                    <span class="area-badge">${r.area_sqm} м²</span>
                                    <span class="status-badge ${r._avail.css}">${r._avail.label}</span>
                                </div>
    
                                <div class="room-specs">
                                    <span>Спальные места: <b>${r.sleeping_places}</b></span>
                                    <span>Этаж <b>${r.floor}</b></span>
                                    ${r.window_view ? `<span>Вид: ${r.window_view}</span>` : ''}
                                    <span>${r.pets_allowed ? 'Можно с питомцами' : 'Без питомцев'}</span>
                                </div>
    
                                <div class="tags-row">
                                    ${infoList}
                                </div>
                            </div>
    
                            <div class="room-action">
                                <div class="price-box">$${r.price} <span>/ ночь</span></div>
                                <small>${r.free_from ? `Свободна с: ${r.free_from.replace('T', ' ')}` : 'Свободна сейчас'}</small>
                                <span class="rent-btn ${isAvailable ? '' : 'secondary'}" href="/room?id=${r.room_number}&${queryDates}">
                                    ${isAvailable ? 'Снять комнату &rarr;' : 'Посмотреть доступные даты &rarr;'}
                                </span>
                            </div>
                        </div>
                    </a>
                `;
    }).join("");
}

async function logout() {
    await fetch("/auth/logout", {method: "POST"});
    window.location.href = "/login";
}

function resetFilters() {
    setDefaultDates();
    document.getElementById("f_beds").value = "0";
    document.getElementById("f_price").value = "";
    document.getElementById("f_pets").checked = false;
    document.getElementById("f_avail_only").checked = false;
    document.getElementById("f_sort").value = "price_asc";
    renderRooms();
}

init();