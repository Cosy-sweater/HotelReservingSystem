let allRooms = [];

// Set default filter timeframe: Now -> Tomorrow
function setDefaultDates() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const tomorrow = new Date(now.getTime() + 86400000);
    document.getElementById("f_in").value = now.toISOString().slice(0, 16);
    document.getElementById("f_out").value = tomorrow.toISOString().slice(0, 16);
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
    setInterval(() => fetchRooms(true), 4000);
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
        console.warn("Temporary network error:", err);
    }
}

/**
 * Determines a room's availability rank for the selected Check-In / Check-Out filter dates:
 *   0 = Available (sorted to top)
 *   1 = Temporarily Held in Redis (sorted to middle)
 *   2 = Booked in DB for those dates (sorted to bottom)
 */
function getAvailabilityState(room, filterIn, filterOut) {
    const reqIn = filterIn ? new Date(filterIn) : new Date();
    const reqOut = filterOut ? new Date(filterOut) : new Date(reqIn.getTime() + 86400000);

    // Check overlapping DB reservations
    const overlappingRes = (room.reservations || []).find(res => {
        const rIn = new Date(res.check_in);
        const rOut = new Date(res.check_out);
        return rIn < reqOut && rOut > reqIn;
    });
    if (overlappingRes || (!filterIn && room.is_booked)) {
        return {rank: 2, label: "Booked", css: "status-booked"};
    }

    // Check overlapping Redis holds
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

    return {rank: 0, label: "Available", css: "status-available"};
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

    // 1. Decorate with availability state & filter
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

    // 2. Sort: Primary sort is ALWAYS Availability Rank (0 -> 1 -> 2)
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
        container.innerHTML = `<div style="text-align:center; padding:2rem; color:#64748b; background:#fff; border-radius:10px;">No rooms match your current filters.</div>`;
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
                    <div class="room-card ${isAvailable ? '' : 'unavailable'}">
                        <div style="flex:1;">
                            <div class="room-header">
                                <h3 class="room-title">Room #${r.room_number} — ${r.room_type}</h3>
                                <span class="area-badge">${r.area_sqm} m²</span>
                                <span class="status-badge ${r._avail.css}">${r._avail.label}</span>
                            </div>

                            <div class="room-specs">
                                <span>🛏️ <b>${r.sleeping_places}</b> Sleeping Place${r.sleeping_places > 1 ? 's' : ''}</span>
                                <span>🏢 Floor <b>${r.floor}</b></span>
                                ${r.window_view ? `<span>🪟 ${r.window_view}</span>` : ''}
                                <span>${r.pets_allowed ? '🐾 Pets Allowed' : '🚫 No Pets'}</span>
                            </div>

                            <div class="tags-row">
                                ${infoList}
                            </div>
                        </div>

                        <div class="room-action">
                            <div class="price-box">$${r.price} <span>/ night</span></div>
                            <a class="rent-btn ${isAvailable ? '' : 'secondary'}" href="/room?id=${r.room_number}&${queryDates}">
                                ${isAvailable ? 'Rent Room &rarr;' : 'View Schedule &rarr;'}
                            </a>
                        </div>
                    </div>
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
    document.getElementById("f_search").value = "";
    document.getElementById("f_pets").checked = false;
    document.getElementById("f_avail_only").checked = false;
    document.getElementById("f_sort").value = "price_asc";
    renderRooms();
}

init();