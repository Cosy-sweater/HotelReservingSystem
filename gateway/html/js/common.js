async function getCurrentUser() {
    try {
        const res = await fetch("/auth/me");
        if (!res.ok) return null;
        return await res.json() // username, role
    } catch (err) {
        return null;
    }
}