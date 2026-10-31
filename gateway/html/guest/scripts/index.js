async function loadRooms() {
            const res = await fetch("/api/rooms");
            const rooms = await res.json();
            document.getElementById("rooms").innerHTML = rooms.map(r => `
                <div style="border:1px solid #ccc; padding:12px; margin-bottom:10px;">
                    <strong>Room ${r.room_number} (${r.room_type})</strong> - $${r.price}/night<br/>
                    ${r.is_booked
                        ? `<span style="color:red;">Booked by ${r.booked_by}</span>`
                        : r.is_locked
                            ? `<span style="color:orange;">Held by ${r.locked_by} (${r.lock_expires_in}s left)</span>
                               <button onclick="pay(${r.room_number})">Complete Payment</button>`
                            : `<button onclick="hold(${r.room_number})">Hold Room</button>`
                    }
                </div>
            `).join("");
        }

        async function hold(num) {
            const res = await fetch(`/api/hold/${num}`, {method: "POST"});
            const data = await res.json();
            alert(data.message || data.error);
            loadRooms();
        }

        async function pay(num) {
            const res = await fetch(`/api/pay/${num}`, {method: "POST"});
            const data = await res.json();
            alert(data.message || data.error);
            loadRooms();
        }

        async function logout() {
            await fetch("/auth/logout", {method: "POST"});
            window.location.href = "/login";
        }

        loadRooms();
        setInterval(loadRooms, 3000);