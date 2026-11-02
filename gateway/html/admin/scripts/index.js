let cachedRooms = [];

        const toLocalISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

        function switchTab(tabId, btn) {
            document.querySelectorAll(".tab-pane").forEach(el => el.classList.remove("active"));
            document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));
            document.getElementById(tabId).classList.add("active");
            btn.classList.add("active");

            if (tabId === "tab-payments") loadPayments();
            if (tabId === "tab-users") loadUsers();
        }

        function setDefaultBookingDates() {
            const now = new Date();
            const tomorrow = new Date(now.getTime() + 86400000);
            const maxDate = new Date(now);
            maxDate.setFullYear(maxDate.getFullYear() + 1);

            const minStr = toLocalISO(now);
            const maxStr = toLocalISO(maxDate);

            const inEl = document.getElementById("book_in");
            const outEl = document.getElementById("book_out");
            inEl.min = minStr;
            inEl.max = maxStr;
            outEl.min = minStr;
            outEl.max = maxStr;
            inEl.value = minStr;
            outEl.value = toLocalISO(tomorrow);

            const enforce = () => {
                if (inEl.value < minStr) inEl.value = minStr;
                if (inEl.value > maxStr) inEl.value = maxStr;
                outEl.min = inEl.value;
                if (outEl.value <= inEl.value) {
                    const nextDay = new Date(new Date(inEl.value).getTime() + 86400000);
                    outEl.value = toLocalISO(nextDay);
                }
                if (outEl.value > maxStr) outEl.value = maxStr;
            };
            inEl.onchange = enforce;
            outEl.onchange = enforce;
        }

        async function loadAdminRooms(quick = false) {
            try {
                const res = await fetch(`/api/rooms${quick ? '?quick=true' : ''}`);
                if (res.status === 401) { window.location.href = "/login"; return; }
                if (!res.ok) return;
                cachedRooms = await res.json();

                // Render Tab 1: Room Editor Table
                document.getElementById("rooms-edit-table").innerHTML = cachedRooms.map(r => `
                    <tr class="clickable-row" onclick="populateRoomForm(${r.room_number})">
                        <td><b>#${r.room_number}</b></td>
                        <td>${r.room_type}<br><small>Floor ${r.floor}</small></td>
                        <td>${r.sleeping_places} Beds | ${r.area_sqm} m²<br><small>View: ${r.window_view ?? '<i>None</i>'}</small></td>
                        <td>Pets: ${r.pets_allowed ? 'Yes' : 'No'}<br><small>${r.additional_info ? r.additional_info.join(', ') : '<i>None</i>'}</small></td>
                        <td>$${r.price}</td>
                        <td>
                            ${r.free_from
                                ? `<b style="color:#b45309;">Free after: ${r.free_from.replace('T', ' ')}</b>`
                                : `<span style="color:#15803d; font-weight:600;">Available Now</span>`
                            }
                        </td>
                    </tr>
                `).join("");

                // Render Tab 2: Renting Dates & States (Paid vs Pending Payment)
                document.getElementById("schedule-table").innerHTML = cachedRooms.map(r => {
                    const paidRows = (r.reservations || []).map(b => `
                        <div style="margin-bottom:6px;">
                            <span class="badge badge-paid">PAID (${b.status.toUpperCase()})</span>
                            <b>${b.username}</b>: ${b.check_in.slice(0,16).replace('T',' ')} &rarr; ${b.check_out.slice(0,16).replace('T',' ')}
                        </div>
                    `);

                    const pendingRows = (r.holds || []).map(h => `
                        <div style="margin-bottom:6px;">
                            <span class="badge badge-pending">PENDING PAYMENT (${h.ttl}s left)</span>
                            <b>${h.username}</b>: ${h.check_in.slice(0,16).replace('T',' ')} &rarr; ${h.check_out.slice(0,16).replace('T',' ')}
                        </div>
                    `);

                    const allEntries = [...paidRows, ...pendingRows].join("");

                    return `
                        <tr>
                            <td><b>Room #${r.room_number}</b><br><small>${r.room_type}</small></td>
                            <td>
                                ${r.free_from
                                    ? `<b style="color:#b45309;">Free after: ${r.free_from.replace('T', ' ')}</b>`
                                    : `<span style="color:#15803d; font-weight:600;">Available Now</span>`
                                }
                            </td>
                            <td>${allEntries || '<span style="color:#15803d;">Completely Free</span>'}</td>
                            <td>
                                ${(paidRows.length || pendingRows.length)
                                    ? `<button class="btn-danger" onclick="cancelReservation(${r.room_number})">Cancel All</button>`
                                    : `<button class="btn-wheat-clr" onclick="selectRoomForBooking(${r.room_number})">Book</button>`
                                }
                            </td>
                        </tr>
                    `;
                }).join("");
            } catch (e) {
                console.warn("Network glitch:", e);
            }
        }

        function populateRoomForm(roomNumber) {
            const r = cachedRooms.find(item => item.room_number === roomNumber);
            if (!r) return;
            document.getElementById("r_num").value = r.room_number;
            document.getElementById("r_floor").value = r.floor;
            document.getElementById("r_type").value = r.room_type;
            document.getElementById("r_beds").value = r.sleeping_places;
            document.getElementById("r_area").value = r.area_sqm;
            document.getElementById("r_price").value = r.price;
            document.getElementById("r_pets").value = r.pets_allowed ? "true" : "false";
            document.getElementById("r_view").value = r.window_view ?? "";
            document.getElementById("r_info").value = r.additional_info ? r.additional_info.join(", ") : "";
            document.getElementById("book_room_num").value = r.room_number;
        }

        function selectRoomForBooking(roomNumber) {
            const r = cachedRooms.find(item => item.room_number === roomNumber);
            document.getElementById("book_room_num").value = roomNumber;
            const inEl = document.getElementById("book_in");
            const outEl = document.getElementById("book_out");

            const startISO = (r && r.free_from) ? r.free_from : toLocalISO(new Date());
            inEl.value = startISO;
            const nextDay = new Date(new Date(startISO).getTime() + 86400000);
            outEl.min = startISO;
            outEl.value = toLocalISO(nextDay);

            window.scrollTo({ top: 0, behavior: "smooth" });
        }

        async function importRoomsCSV() {
            const fileInput = document.getElementById("csv_file");
            if (!fileInput.files.length) {
                alert("Please select a Rooms CSV file first.");
                return;
            }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);

            const res = await fetch("/api/admin/import/rooms", {
                method: "POST",
                body: formData
            });
            const data = await res.json();
            alert(data.message || data.error);
            fileInput.value = "";
            loadAdminRooms(false);
        }

        async function importUsersCSV() {
            const fileInput = document.getElementById("users_csv_file");
            if (!fileInput.files.length) {
                alert("Please select a Users CSV file first.");
                return;
            }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);

            const res = await fetch("/api/admin/import/users", {
                method: "POST",
                body: formData
            });
            const data = await res.json();
            alert(data.message || data.error);
            fileInput.value = "";
            loadUsers();
        }

        async function loadPayments() {
            const res = await fetch("/api/admin/payments");
            if (!res.ok) return;
            const payments = await res.json();
            document.getElementById("payments-table").innerHTML = payments.length
                ? payments.map(p => `
                    <tr>
                        <td><code>${p.transaction_id}</code></td>
                        <td><b>${p.username}</b></td>
                        <td>#${p.room_number}</td>
                        <td><b>$${p.amount.toFixed(2)}</b> ${p.currency}</td>
                        <td>${p.provider} (•••• ${p.card_last4})</td>
                        <td><span class="badge badge-paid">${p.status.toUpperCase()}</span></td>
                        <td>${p.paid_at.slice(0,19).replace('T',' ')}</td>
                    </tr>
                `).join("")
                : `<tr><td colspan="7" style="text-align:center;">No payment records yet.</td></tr>`;
        }

        async function loadUsers() {
            const res = await fetch("/api/users");
            if (!res.ok) return;
            const users = await res.json();
            document.getElementById("users-table").innerHTML = users.map(u => `
                <tr>
                    <td><b>#${u.id} — ${u.username}</b></td>
                    <td>${u.role}</td>
                    <td>${u.passport_number || '<i>Not set</i>'}</td>
                    <td>${u.phone || '<i>Not set</i>'}</td>
                    <td>
                        ${(u.rented_rooms || []).length
                            ? u.rented_rooms.map(rr => `Room #${rr.room_number} (${rr.status}: ${String(rr.check_in).slice(0,16).replace('T',' ')} &rarr; ${String(rr.check_out).slice(0,16).replace('T',' ')})`).join('<br>')
                            : '<i>None</i>'
                        }
                    </td>
                </tr>
            `).join("");
        }

        async function saveRoom() {
            const viewVal = document.getElementById("r_view").value.trim();
            const infoRaw = document.getElementById("r_info").value.split(",").map(s => s.trim()).filter(Boolean);

            const payload = {
                room_number: parseInt(document.getElementById("r_num").value),
                floor: parseInt(document.getElementById("r_floor").value),
                room_type: document.getElementById("r_type").value.trim(),
                sleeping_places: parseInt(document.getElementById("r_beds").value),
                area_sqm: parseFloat(document.getElementById("r_area").value),
                price: parseInt(document.getElementById("r_price").value),
                pets_allowed: document.getElementById("r_pets").value === "true",
                window_view: viewVal.length > 0 ? viewVal : null,
                additional_info: infoRaw.length > 0 ? infoRaw : null
            };

            const res = await fetch("/api/admin/rooms", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            alert(data.message || data.error);
            loadAdminRooms(false);
        }

        async function manualBook(createNewUser = false) {
            const payload = {
                room_number: parseInt(document.getElementById("book_room_num").value),
                username: document.getElementById("book_username").value.trim(),
                check_in: document.getElementById("book_in").value,
                check_out: document.getElementById("book_out").value,
                create_new_user: createNewUser,
                password: document.getElementById("book_pass").value,
                passport_number: document.getElementById("book_passport").value.trim() || null,
                phone: document.getElementById("book_phone").value.trim() || null
            };

            const res = await fetch("/api/admin/book", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (res.status === 404 && data.code === "USER_NOT_FOUND") {
                document.getElementById("new-user-fields").style.display = "block";
                document.getElementById("confirm-create-btn").style.display = "inline-block";
                return;
            }
            if (!res.ok) {
                alert(data.error);
                return;
            }

            alert(data.message);
            document.getElementById("new-user-fields").style.display = "none";
            document.getElementById("confirm-create-btn").style.display = "none";
            loadAdminRooms(false);
        }

        async function cancelReservation(roomNum) {
            if (!confirm(`Cancel all reservations and holds for Room #${roomNum}?`)) return;
            const res = await fetch(`/api/admin/cancel/${roomNum}`, {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({})
            });
            const data = await res.json();
            alert(data.message || data.error);
            loadAdminRooms(false);
        }

        async function logout() {
            await fetch("/auth/logout", {method: "POST"});
            window.location.href = "/login";
        }

        setDefaultBookingDates();
        loadAdminRooms(false);
        setInterval(() => loadAdminRooms(true), 4000);