async function safeJson(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        return { error: `Server returned status ${res.status}` };
    }
}

async function getCurrentUser() {
    try {
        const res = await fetch("/auth/me", {
            method: "GET",
            credentials: "same-origin"
        });
        if (!res.ok) return null;
        return await safeJson(res);
    } catch (err) {
        console.warn("Could not verify session:", err);
        return null;
    }
}

// Parses a Date object or "YYYY-MM-DDTHH:mm" string directly into a local Date at :00 minutes
function parseLocalHourISO(input) {
    if (!input) return null;
    if (input instanceof Date) {
        if (isNaN(input.getTime())) return null;
        return new Date(
            input.getFullYear(),
            input.getMonth(),
            input.getDate(),
            input.getHours(),
            0, 0, 0
        );
    }
    if (typeof input === "string") {
        const clean = input.trim().replace(" ", "T");
        const [datePart, timePart] = clean.split("T");
        if (!datePart) return null;
        const [y, m, d] = datePart.split("-").map(Number);
        if (!y || !m || !d) return null;
        const hr = timePart ? (parseInt(timePart.split(":")[0], 10) || 0) : 0;
        return new Date(y, m - 1, d, hr, 0, 0, 0);
    }
    return null;
}

// Formats a Date or ISO string into local "YYYY-MM-DDTHH:00" without UTC conversion
function toLocalHourISO(dateInput) {
    const d = parseLocalHourISO(dateInput) || parseLocalHourISO(new Date());
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:00`;
}

// Adds whole hours to a "YYYY-MM-DDTHH:00" string in local time
function addHoursISO(isoStr, hoursToAdd) {
    const d = parseLocalHourISO(isoStr) || parseLocalHourISO(new Date());
    d.setHours(d.getHours() + hoursToAdd, 0, 0, 0);
    return toLocalHourISO(d);
}

// Calculates exact whole hours between two ISO datetime strings (minimum 1 hour)
function calculateRentedHours(checkInISO, checkOutISO) {
    const dIn = parseLocalHourISO(checkInISO);
    const dOut = parseLocalHourISO(checkOutISO);
    if (!dIn || !dOut) return 1;
    const diffHours = Math.round((dOut.getTime() - dIn.getTime()) / 3600000);
    return Math.max(1, diffHours);
}

// Enforces whole-hour (:00) values, min/max bounds, and >= 1 hour duration
function enforceHourlyBounds(inInput, outInput, minStr, maxStr, onUpdateCallback = null) {
    if (!inInput || !outInput) return;

    const parsedIn = parseLocalHourISO(inInput.value);
    inInput.value = parsedIn ? toLocalHourISO(parsedIn) : minStr;

    if (inInput.value < minStr) inInput.value = minStr;
    if (inInput.value > maxStr) inInput.value = maxStr;

    const minOutStr = addHoursISO(inInput.value, 1);
    outInput.min = minOutStr;

    const parsedOut = parseLocalHourISO(outInput.value);
    outInput.value = parsedOut ? toLocalHourISO(parsedOut) : minOutStr;

    if (outInput.value < minOutStr) {
        outInput.value = minOutStr;
    }
    if (outInput.value > maxStr) {
        outInput.value = maxStr;
    }

    if (typeof onUpdateCallback === "function") {
        onUpdateCallback(inInput.value, outInput.value);
    }
}

// Locks a pair of <input type="datetime-local"> elements to whole hours
function setupHourlyDateInputs(inId, outId, options = {}) {
    const inInput = document.getElementById(inId);
    const outInput = document.getElementById(outId);
    if (!inInput || !outInput) return null;

    inInput.setAttribute("step", "3600");
    outInput.setAttribute("step", "3600");

    const now = new Date();
    const baselineNowISO = toLocalHourISO(now);

    const maxDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    const maxStr = toLocalHourISO(maxDate);

    let currentMinStr = options.minISO ? toLocalHourISO(options.minISO) : baselineNowISO;
    const defaultHours = options.defaultDurationHours || 1;

    inInput.min = currentMinStr;
    inInput.max = maxStr;
    outInput.max = maxStr;

    const reqInISO = options.initialIn ? toLocalHourISO(options.initialIn) : null;
    const initialIn = (reqInISO && reqInISO >= currentMinStr) ? reqInISO : currentMinStr;
    inInput.value = initialIn;

    const minOutStr = addHoursISO(initialIn, 1);
    const defaultOutStr = addHoursISO(initialIn, defaultHours);
    const reqOutISO = options.initialOut ? toLocalHourISO(options.initialOut) : null;
    const initialOut = (reqOutISO && reqOutISO >= minOutStr) ? reqOutISO : defaultOutStr;

    outInput.min = minOutStr;
    outInput.value = initialOut;

    const triggerEnforce = () => {
        enforceHourlyBounds(inInput, outInput, currentMinStr, maxStr, options.onChange);
    };

    inInput.addEventListener("change", triggerEnforce);
    outInput.addEventListener("change", triggerEnforce);
    triggerEnforce();

    return {
        updateMin(newMinISO) {
            const nextMin = newMinISO ? toLocalHourISO(newMinISO) : baselineNowISO;
            if (nextMin !== currentMinStr) {
                currentMinStr = nextMin;
                inInput.min = currentMinStr;
                if (inInput.value < currentMinStr) {
                    inInput.value = currentMinStr;
                }
                triggerEnforce();
            }
        },
        setDates(newInISO, newOutISO) {
            if (newInISO) inInput.value = toLocalHourISO(newInISO);
            if (newOutISO) outInput.value = toLocalHourISO(newOutISO);
            triggerEnforce();
        },
        triggerEnforce
    };
}